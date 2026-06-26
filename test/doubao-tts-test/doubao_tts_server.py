"""
豆包 TTS WebSocket 服务
在本地 WebSocket 端口上运行，供 Electron 主进程通过 IPC 调用。
"""
import asyncio
import json
import struct
import uuid
import os
import sys
import io
import hashlib
import hmac
import time
import wave
import tempfile

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

try:
    import websockets
    from dotenv import load_dotenv
except ImportError:
    print("请先安装: pip install websockets python-dotenv")
    sys.exit(1)

# .env 加载：PyInstaller onefile 打包后 __file__ 指向临时解压目录 _MEIxxxxx，
# 需优先从 exe 同目录（frozen 模式下 sys.executable 的目录）读 .env，
# 回退到源码目录（开发模式）。
if getattr(sys, "frozen", False):
    _BASE_DIR = os.path.dirname(sys.executable)
else:
    _BASE_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(_BASE_DIR, ".env"))

APP_ID = os.getenv("DOUBAO_APP_ID", "")
API_KEY = os.getenv("DOUBAO_API_KEY", "")
WS_URI = "wss://openspeech.bytedance.com/api/v3/tts/bidirection"
DEFAULT_VOICE = "zh_female_xiaohe_uranus_bigtts"


class EventSend:
    START_CONNECTION = 1
    FINISH_CONNECTION = 2
    START_SESSION = 100
    FINISH_SESSION = 102
    TASK_REQUEST = 200


class EventRecv:
    CONNECTION_STARTED = 50
    CONNECTION_FAILED = 51
    CONNECTION_FINISHED = 52
    SESSION_STARTED = 150
    SESSION_FINISHED = 152
    SESSION_FAILED = 153
    TTS_SENTENCE_START = 350
    TTS_SENTENCE_END = 351
    TTS_RESPONSE = 352


def make_header(msg_type=0b0001, flags=0b0100, serial=0b0001, compress=0b0000):
    return bytes([
        (0b0001 << 4) | 0b0001,
        (msg_type << 4) | flags,
        (serial << 4) | compress,
        0x00,
    ])


def make_event_frame(event, session_id="", payload=None):
    data = bytearray(make_header())
    data.extend(struct.pack(">i", event))
    if session_id:
        sid = session_id.encode()
        data.extend(struct.pack(">I", len(sid)))
        data.extend(sid)
    body = json.dumps(payload or {}).encode()
    data.extend(struct.pack(">I", len(body)))
    data.extend(body)
    return bytes(data)


def make_payload(text, speaker, audio_format, sample_rate, speech_rate=0):
    return {
        "user": {"uid": "koodo-reader-tts"},
        "event": EventSend.TASK_REQUEST,
        "namespace": "BidirectionalTTS",
        "req_params": {
            "text": text,
            "speaker": speaker,
            "audio_params": {
                "format": audio_format,
                "sample_rate": sample_rate,
                "speech_rate": speech_rate,
            },
        },
    }


def parse_response(frame):
    if len(frame) < 8:
        return None
    event = struct.unpack(">i", frame[4:8])[0]
    pos = 8
    session_id = ""
    if pos + 4 <= len(frame):
        sid_len = struct.unpack(">I", frame[pos:pos+4])[0]
        pos += 4
        if pos + sid_len <= len(frame):
            session_id = frame[pos:pos+sid_len].decode()
            pos += sid_len
    if pos + 4 > len(frame):
        return {"event": event, "session_id": session_id, "payload": {}, "audio": b""}
    payload_len = struct.unpack(">I", frame[pos:pos+4])[0]
    pos += 4
    if event == EventRecv.TTS_RESPONSE:
        return {"event": event, "session_id": session_id, "payload": {}, "audio": frame[pos:pos+payload_len]}
    payload = {}
    if payload_len > 0 and pos + payload_len <= len(frame):
        try:
            payload = json.loads(frame[pos:pos+payload_len])
        except json.JSONDecodeError:
            payload = {}
    return {"event": event, "session_id": session_id, "payload": payload, "audio": b""}


async def synthesize_text(text, voice, audio_format="pcm", sample_rate=24000, speech_rate=0):
    """合成文本并返回音频数据"""
    headers = {
        "X-Api-App-Key": APP_ID,
        "X-Api-Access-Key": API_KEY,
        "X-Api-Resource-Id": "seed-tts-2.0",
    }
    ws = await websockets.connect(
        WS_URI, additional_headers=headers,
        ping_interval=None, max_size=100_000_000
    )

    await ws.send(make_event_frame(EventSend.START_CONNECTION, payload={}))
    resp = parse_response(await ws.recv())
    if resp["event"] != EventRecv.CONNECTION_STARTED:
        await ws.close()
        raise ConnectionError("连接失败")

    sid = str(uuid.uuid4()).replace("-", "")
    pl = make_payload("", voice, audio_format, sample_rate, speech_rate)
    pl["event"] = EventSend.START_SESSION
    await ws.send(make_event_frame(EventSend.START_SESSION, sid, pl))
    resp = parse_response(await ws.recv())
    if resp["event"] != EventRecv.SESSION_STARTED:
        await ws.close()
        raise RuntimeError("会话启动失败")

    audio_data = bytearray()
    done = asyncio.Event()

    async def listener():
        try:
            async for msg in ws:
                p = parse_response(msg)
                if not p:
                    continue
                if p["event"] == EventRecv.TTS_RESPONSE:
                    audio_data.extend(p.get("audio", b""))
                elif p["event"] in (EventRecv.SESSION_FINISHED, EventRecv.SESSION_FAILED):
                    done.set()
                    break
        except Exception:
            done.set()

    task = asyncio.create_task(listener())
    pl2 = make_payload(text, voice, audio_format, sample_rate, speech_rate)
    await ws.send(make_event_frame(EventSend.TASK_REQUEST, sid, pl2))
    await ws.send(make_event_frame(EventSend.FINISH_SESSION, sid, {}))
    await asyncio.wait_for(done.wait(), timeout=60)
    task.cancel()

    await ws.send(make_event_frame(EventSend.FINISH_CONNECTION, payload={}))
    try:
        await asyncio.wait_for(ws.recv(), timeout=3)
    except Exception:
        pass
    await ws.close()

    return bytes(audio_data)


async def handle_client(reader, writer):
    """处理来自 Electron 的本地 TCP 连接"""
    try:
        data = await reader.read(4096)
        request = json.loads(data.decode())

        text = request.get("text", "")
        voice = request.get("voice", DEFAULT_VOICE)
        audio_format = request.get("format", "pcm")
        sample_rate = request.get("sample_rate", 24000)
        speech_rate = request.get("speech_rate", 0)
        try:
            speech_rate = int(speech_rate)
        except (TypeError, ValueError):
            speech_rate = 0
        # 豆包 API 限制: [-50, 100]，100=2.0x, -50=0.5x, 0=1.0x
        speech_rate = max(-50, min(100, speech_rate))

        audio = await synthesize_text(text, voice, audio_format, sample_rate, speech_rate)

        import base64
        response = {
            "success": True,
            "audio": base64.b64encode(audio).decode(),
            "format": audio_format,
            "sample_rate": sample_rate,
        }
    except Exception as e:
        response = {"success": False, "error": str(e)}

    writer.write(json.dumps(response).encode())
    await writer.drain()
    writer.close()


async def main(host="127.0.0.1", port=18765):
    print(f"豆包 TTS 服务启动: {host}:{port}")
    print(f"AppID: {APP_ID}")
    print(f"API Key: {API_KEY[:8]}..." if API_KEY else "API Key: 未配置")
    server = await asyncio.start_server(handle_client, host, port)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18765)
    args = parser.parse_args()
    asyncio.run(main(args.host, args.port))
