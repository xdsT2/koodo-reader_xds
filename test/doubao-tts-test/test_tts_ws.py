#!/usr/bin/env python3
"""
火山引擎 WebSocket 双向流式 V3 语音合成交互脚本
输入文字 → 合成 → 自动播放，支持多轮交互
"""

import argparse
import asyncio
import io
import json
import os
import struct
import sys
import tempfile
import time
import uuid

import pygame
import websockets


# ── 协议常量 ──────────────────────────────────────────────
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
    header = make_header()
    data = bytearray()
    data.extend(header)
    data.extend(struct.pack(">i", event))
    if session_id:
        sid = session_id.encode()
        data.extend(struct.pack(">I", len(sid)))
        data.extend(sid)
    body = json.dumps(payload or {}).encode()
    data.extend(struct.pack(">I", len(body)))
    data.extend(body)
    return bytes(data)


def make_payload(event, text="", speaker="", audio_format="mp3", sample_rate=24000, uid="default"):
    return {
        "user": {"uid": uid},
        "event": event,
        "namespace": "BidirectionalTTS",
        "req_params": {
            "text": text,
            "speaker": speaker,
            "audio_params": {
                "format": audio_format,
                "sample_rate": sample_rate,
            },
        },
    }


def parse_response(frame):
    """解析服务器返回的二进制帧"""
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
    if event in (EventRecv.TTS_RESPONSE,):
        return {"event": event, "session_id": session_id, "payload": {}, "audio": frame[pos:pos+payload_len]}
    payload = {}
    if payload_len > 0 and pos + payload_len <= len(frame):
        try:
            payload = json.loads(frame[pos:pos+payload_len])
        except json.JSONDecodeError:
            payload = {}
    return {"event": event, "session_id": session_id, "payload": payload, "audio": b""}


def make_session_id():
    return str(uuid.uuid4()).replace("-", "")


def play_audio(data, fmt="mp3"):
    """使用 pygame 直接播放音频（不打开外部播放器）"""
    pygame.mixer.init()
    suffix = ".mp3" if fmt == "mp3" else ".wav"
    fd, path = tempfile.mkstemp(suffix=suffix)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    try:
        pygame.mixer.music.load(path)
        pygame.mixer.music.play()
        while pygame.mixer.music.get_busy():
            pygame.time.wait(100)
    finally:
        pygame.mixer.music.stop()
        try:
            os.remove(path)
        except OSError:
            pass


# ── 命令行参数 ──────────────────────────────────────────
def parse_args():
    p = argparse.ArgumentParser(description="火山引擎 WebSocket 双向流式 TTS 交互脚本")
    g_auth = p.add_argument_group("鉴权")
    g_auth.add_argument("--api-key", default=os.environ.get("VOLC_API_KEY"),
                        help="新版控制台 API Key (环境 VOLC_API_KEY)")
    g_auth.add_argument("--resource-id", default="seed-tts-2.0",
                        help="模型版本 (默认 seed-tts-2.0)")
    g_auth.add_argument("--app-id", default=os.environ.get("VOLC_APP_ID"),
                        help="旧版 AppID (备选)")
    g_auth.add_argument("--access-key", default=os.environ.get("VOLC_ACCESS_KEY"),
                        help="旧版 Access Key (备选)")
    g_req = p.add_argument_group("合成")
    g_req.add_argument("--speaker", default="zh_female_xiaohe_uranus_bigtts",
                       help="音色 (默认 zh_female_xiaohe_uranus_bigtts)")
    g_req.add_argument("--format", default="mp3", choices=["mp3", "pcm"],
                       help="音频格式 (默认 mp3)")
    g_req.add_argument("--sample-rate", type=int, default=24000, help="采样率 (默认 24000)")
    g_req.add_argument("--speed", type=float, default=1.0, help="语速 0.1-2.0")
    g_req.add_argument("--output", default="", help="保存文件路径 (留空则不保存)")
    return p.parse_args()


# ── 核心逻辑 ──────────────────────────────────────────
class TTSClient:
    def __init__(self, args):
        self.args = args
        self.ws = None
        self.audio_data = bytearray()
        self._done = asyncio.Event()

    def build_headers(self):
        if self.args.api_key:
            return {
                "X-Api-Key": self.args.api_key,
                "X-Api-Resource-Id": self.args.resource_id,
            }
        return {
            "X-Api-App-Key": self.args.app_id,
            "X-Api-Access-Key": self.args.access_key,
            "X-Api-Resource-Id": self.args.resource_id,
        }

    async def connect(self):
        headers = self.build_headers()
        uri = "wss://openspeech.bytedance.com/api/v3/tts/bidirection"
        self.ws = await websockets.connect(uri, additional_headers=headers,
                                           ping_interval=None, max_size=100_000_000)
        await self.ws.send(make_event_frame(EventSend.START_CONNECTION, payload={}))
        resp = parse_response(await self.ws.recv())
        if resp and resp["event"] == EventRecv.CONNECTION_FAILED:
            raise ConnectionError(f"连接失败: {resp['payload']}")
        if resp is None or resp["event"] != EventRecv.CONNECTION_STARTED:
            raise ConnectionError(f"预期 CONNECTION_STARTED, 收到 event={resp}")
        return self

    async def start_session(self, session_id):
        pl = make_payload(EventSend.START_SESSION,
                          speaker=self.args.speaker,
                          audio_format=self.args.format,
                          sample_rate=self.args.sample_rate)
        await self.ws.send(make_event_frame(EventSend.START_SESSION, session_id, pl))
        resp = parse_response(await self.ws.recv())
        if resp and resp["event"] == EventRecv.SESSION_FAILED:
            raise RuntimeError(f"会话失败: {resp['payload']}")
        if resp is None or resp["event"] != EventRecv.SESSION_STARTED:
            raise RuntimeError(f"预期 SESSION_STARTED, 收到 event={resp}")

    async def send_text(self, session_id, text):
        pl = make_payload(EventSend.TASK_REQUEST,
                          text=text,
                          speaker=self.args.speaker,
                          audio_format=self.args.format,
                          sample_rate=self.args.sample_rate)
        await self.ws.send(make_event_frame(EventSend.TASK_REQUEST, session_id, pl))

    async def finish_session(self, session_id):
        await self.ws.send(make_event_frame(EventSend.FINISH_SESSION, session_id, {}))

    async def finish_connection(self):
        await self.ws.send(make_event_frame(EventSend.FINISH_CONNECTION, payload={}))
        try:
            await asyncio.wait_for(self.ws.recv(), timeout=3)
        except (asyncio.TimeoutError, websockets.exceptions.ConnectionClosed):
            pass

    async def synthesize(self, text, session_id):
        self.audio_data = bytearray()
        self._done.clear()

        async def listener():
            try:
                async for msg in self.ws:
                    parsed = parse_response(msg)
                    if not parsed:
                        continue
                    ev = parsed["event"]
                    if ev == EventRecv.TTS_RESPONSE:
                        audio = parsed.get("audio", b"")
                        if audio:
                            self.audio_data.extend(audio)
                    elif ev == EventRecv.SESSION_FINISHED:
                        self._done.set()
                        break
                    elif ev == EventRecv.SESSION_FAILED:
                        print(f"\n  会话失败: {parsed['payload']}")
                        self._done.set()
                        break
            except websockets.exceptions.ConnectionClosed:
                self._done.set()

        task = asyncio.create_task(listener())
        await self.send_text(session_id, text)
        await self.finish_session(session_id)
        await asyncio.wait_for(self._done.wait(), timeout=30)
        task.cancel()
        return bytes(self.audio_data)


async def interactive_loop():
    args = parse_args()
    if not args.api_key and not (args.app_id and args.access_key):
        print("请提供 --api-key，或 --app-id + --access-key")
        sys.exit(1)

    print()
    print("=" * 50)
    print("  火山引擎 WebSocket 双向流式 TTS")
    print("  输入文字后回车 → 合成 → 自动播放")
    print("  输入 exit / quit 退出")
    print("=" * 50)

    client = TTSClient(args)
    try:
        await client.connect()
    except Exception as e:
        print(f"连接失败: {e}")
        sys.exit(1)

    while True:
        try:
            text = input("\n> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if not text:
            continue
        if text.lower() in ("exit", "quit"):
            break

        session_id = make_session_id()
        print(f"  合", end="", flush=True)
        try:
            await client.start_session(session_id)
            start = time.time()
            audio = await client.synthesize(text, session_id)
            elapsed = time.time() - start
        except Exception as e:
            print(f" 错误: {e}")
            continue

        if not audio:
            print(" 未收到音频数据")
            continue

        size_kb = len(audio) / 1024
        print(f" 完成 ({size_kb:.1f} KB, {elapsed:.2f}s)")

        print(f"  播放...", end=" ", flush=True)
        play_audio(audio, args.format)

        if args.output:
            with open(args.output, "wb") as f:
                f.write(audio)
            print(f"  保存: {os.path.abspath(args.output)}")

    await client.finish_connection()
    print("再见!")


def main():
    asyncio.run(interactive_loop())


if __name__ == "__main__":
    main()
