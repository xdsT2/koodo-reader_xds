import asyncio
import json
import struct
import uuid
import os
import sys
import io
import wave
from typing import Optional
from dotenv import load_dotenv

load_dotenv()

if hasattr(sys.stdout, 'buffer') and sys.stdout.encoding != 'utf-8':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

try:
    import websockets
except ImportError:
    raise ImportError("请先安装: pip install websockets")


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


WS_URI = "wss://openspeech.bytedance.com/api/v3/tts/bidirection"
DEFAULT_SPEAKER = "zh_female_xiaohe_uranus_bigtts"
DEFAULT_FORMAT = "pcm"
DEFAULT_SAMPLE_RATE = 24000


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


def make_payload(text, speaker, audio_format, sample_rate):
    return {
        "user": {"uid": "doubao_tts_client"},
        "event": EventSend.TASK_REQUEST,
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


class DoubaoTTSClient:
    def __init__(self, api_key: str = None, app_id: str = None):
        self.api_key = api_key or os.getenv("DOUBAO_API_KEY", "")
        self.app_id = app_id or os.getenv("DOUBAO_APP_ID", "")
        self.ws = None
        self.audio_data = bytearray()

    def _build_headers(self):
        if self.api_key and len(self.api_key) > 40:
            return {"X-Api-Key": self.api_key, "X-Api-Resource-Id": "seed-tts-2.0"}
        elif self.app_id:
            return {"X-Api-App-Key": self.app_id, "X-Api-Access-Key": self.api_key, "X-Api-Resource-Id": "seed-tts-2.0"}
        return {"X-Api-Key": self.api_key, "X-Api-Resource-Id": "seed-tts-2.0"}

    async def _connect(self):
        headers = self._build_headers()
        self.ws = await websockets.connect(
            WS_URI, additional_headers=headers,
            ping_interval=None, max_size=100_000_000
        )
        await self.ws.send(make_event_frame(EventSend.START_CONNECTION, payload={}))
        resp = parse_response(await self.ws.recv())
        if resp is None or resp["event"] != EventRecv.CONNECTION_STARTED:
            raise ConnectionError(f"连接失败: {resp}")
        return True

    async def _start_session(self, session_id, speaker, audio_format, sample_rate):
        pl = make_payload("", speaker, audio_format, sample_rate)
        pl["event"] = EventSend.START_SESSION
        await self.ws.send(make_event_frame(EventSend.START_SESSION, session_id, pl))
        resp = parse_response(await self.ws.recv())
        if resp is None or resp["event"] != EventRecv.SESSION_STARTED:
            raise RuntimeError(f"会话启动失败: {resp}")

    async def _synthesize(self, text, session_id, speaker, audio_format, sample_rate):
        self.audio_data = bytearray()
        done = asyncio.Event()

        async def listener():
            try:
                async for msg in self.ws:
                    parsed = parse_response(msg)
                    if not parsed:
                        continue
                    if parsed["event"] == EventRecv.TTS_RESPONSE:
                        audio = parsed.get("audio", b"")
                        if audio:
                            self.audio_data.extend(audio)
                    elif parsed["event"] == EventRecv.SESSION_FINISHED:
                        done.set()
                        break
                    elif parsed["event"] == EventRecv.SESSION_FAILED:
                        done.set()
                        break
            except Exception:
                done.set()

        task = asyncio.create_task(listener())
        pl = make_payload(text, speaker, audio_format, sample_rate)
        await self.ws.send(make_event_frame(EventSend.TASK_REQUEST, session_id, pl))
        await self.ws.send(make_event_frame(EventSend.FINISH_SESSION, session_id, {}))
        await asyncio.wait_for(done.wait(), timeout=30)
        task.cancel()
        return bytes(self.audio_data)

    async def _disconnect(self):
        if self.ws:
            await self.ws.send(make_event_frame(EventSend.FINISH_CONNECTION, payload={}))
            try:
                await asyncio.wait_for(self.ws.recv(), timeout=3)
            except (asyncio.TimeoutError, Exception):
                pass
            await self.ws.close()
            self.ws = None

    def connect(self) -> bool:
        return asyncio.get_event_loop().run_until_complete(self._connect())

    def synthesize(self, text: str, voice_type: str = None, audio_format: str = DEFAULT_FORMAT, sample_rate: int = DEFAULT_SAMPLE_RATE) -> bytes:
        async def _run():
            session_id = str(uuid.uuid4()).replace("-", "")
            await self._start_session(session_id, voice_type or DEFAULT_SPEAKER, audio_format, sample_rate)
            audio = await self._synthesize(text, session_id, voice_type or DEFAULT_SPEAKER, audio_format, sample_rate)
            return audio
        return asyncio.get_event_loop().run_until_complete(_run())

    def disconnect(self):
        asyncio.get_event_loop().run_until_complete(self._disconnect())
