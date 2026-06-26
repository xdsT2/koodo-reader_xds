import asyncio
import sys
import io
import os
import wave
import tempfile
import uuid

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

import pygame
import websockets
from dotenv import load_dotenv

load_dotenv()

from doubao_tts_client import (
    make_event_frame, make_payload, parse_response,
    EventSend, EventRecv, WS_URI
)

APP_ID = os.getenv("DOUBAO_APP_ID", "")
API_KEY = os.getenv("DOUBAO_API_KEY", "")
VOICE = "zh_female_xiaohe_uranus_bigtts"


async def play_long_text(text):
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
        print("连接失败")
        return

    sid = str(uuid.uuid4()).replace("-", "")
    pl = make_payload("", VOICE, "pcm", 24000)
    pl["event"] = EventSend.START_SESSION
    await ws.send(make_event_frame(EventSend.START_SESSION, sid, pl))
    resp = parse_response(await ws.recv())
    if resp["event"] != EventRecv.SESSION_STARTED:
        print("会话失败")
        return

    print(f"文本长度: {len(text)} 字")
    print("合成中...")

    audio_data = bytearray()
    done = asyncio.Event()

    async def listener():
        try:
            async for msg in ws:
                p = parse_response(msg)
                if not p:
                    continue
                if p["event"] == EventRecv.TTS_RESPONSE:
                    chunk = p.get("audio", b"")
                    if chunk:
                        audio_data.extend(chunk)
                elif p["event"] == EventRecv.SESSION_FINISHED:
                    done.set()
                    break
                elif p["event"] == EventRecv.SESSION_FAILED:
                    done.set()
                    break
        except Exception:
            done.set()

    task = asyncio.create_task(listener())

    chunk_size = 500
    chunks = [text[i:i+chunk_size] for i in range(0, len(text), chunk_size)]
    for i, chunk in enumerate(chunks):
        pl2 = make_payload(chunk, VOICE, "pcm", 24000)
        await ws.send(make_event_frame(EventSend.TASK_REQUEST, sid, pl2))
        print(f"  已发送 {min((i+1)*chunk_size, len(text))}/{len(text)} 字")

    await ws.send(make_event_frame(EventSend.FINISH_SESSION, sid, {}))
    await asyncio.wait_for(done.wait(), timeout=120)
    task.cancel()

    await ws.send(make_event_frame(EventSend.FINISH_CONNECTION, payload={}))
    try:
        await asyncio.wait_for(ws.recv(), timeout=3)
    except Exception:
        pass
    await ws.close()

    if not audio_data:
        print("未收到音频")
        return

    print(f"音频: {len(audio_data)/1024:.1f} KB")

    fd, path = tempfile.mkstemp(suffix=".wav")
    with os.fdopen(fd, "wb") as f:
        with wave.open(f, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(24000)
            w.writeframes(bytes(audio_data))

    print("播放中...")
    pygame.mixer.init()
    pygame.mixer.music.load(path)
    pygame.mixer.music.play()
    while pygame.mixer.music.get_busy():
        pygame.time.wait(100)
    pygame.mixer.music.stop()
    pygame.mixer.quit()

    try:
        os.remove(path)
    except Exception:
        pass

    print("播放完成!")


if __name__ == "__main__":
    arg = sys.argv[1] if len(sys.argv) > 1 else None
    if not arg:
        print("用法: python play_text.py <文本或文件路径>")
        sys.exit(1)
    if os.path.isfile(arg):
        with open(arg, "r", encoding="utf-8") as f:
            text = f.read().strip()
    else:
        text = arg
    asyncio.run(play_long_text(text))
