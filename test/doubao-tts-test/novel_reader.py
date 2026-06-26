"""
长篇小说TTS朗读器
用法: python novel_reader.py <小说文件路径> [--voice 音色] [--chunk 字数]
"""
import asyncio
import sys
import io
import os
import re
import wave
import tempfile
import uuid
import argparse
import queue
import struct

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
DEFAULT_VOICE = "zh_female_xiaohe_uranus_bigtts"


def split_text(text, max_chars=300):
    """按自然断句分割文本"""
    sentences = re.split(r'(?<=[。！？；\n])', text)
    chunks = []
    current = ""
    for s in sentences:
        s = s.strip()
        if not s:
            continue
        if len(current) + len(s) <= max_chars:
            current += s
        else:
            if current:
                chunks.append(current)
            current = s
    if current:
        chunks.append(current)
    return chunks


async def stream_synthesize(chunks, voice, audio_queue):
    """流式合成，将音频块放入队列"""
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
        audio_queue.put(None)
        return

    for i, chunk in enumerate(chunks):
        sid = str(uuid.uuid4()).replace("-", "")
        pl = make_payload("", voice, "pcm", 24000)
        pl["event"] = EventSend.START_SESSION
        await ws.send(make_event_frame(EventSend.START_SESSION, sid, pl))
        resp = parse_response(await ws.recv())
        if resp["event"] != EventRecv.SESSION_STARTED:
            continue

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
        pl2 = make_payload(chunk, voice, "pcm", 24000)
        await ws.send(make_event_frame(EventSend.TASK_REQUEST, sid, pl2))
        await ws.send(make_event_frame(EventSend.FINISH_SESSION, sid, {}))
        await asyncio.wait_for(done.wait(), timeout=60)
        task.cancel()

        if audio_data:
            audio_queue.put(bytes(audio_data))
            progress = (i + 1) / len(chunks) * 100
            print(f"\r  合成进度: {progress:.0f}% ({i+1}/{len(chunks)}段)", end="", flush=True)

    await ws.send(make_event_frame(EventSend.FINISH_CONNECTION, payload={}))
    try:
        await asyncio.wait_for(ws.recv(), timeout=3)
    except Exception:
        pass
    await ws.close()
    audio_queue.put(None)
    print()


def play_from_queue(audio_queue):
    """从队列中读取音频块并播放"""
    pygame.mixer.init(frequency=24000, size=-16, channels=1, buffer=4096)

    temp_files = []

    while True:
        chunk = audio_queue.get()
        if chunk is None:
            break

        fd, path = tempfile.mkstemp(suffix=".pcm")
        with os.fdopen(fd, "wb") as f:
            f.write(chunk)
        temp_files.append(path)

    pygame.mixer.quit()

    for f in temp_files:
        try:
            os.remove(f)
        except Exception:
            pass


def play_streaming(audio_queue):
    """流式播放：边合成边播放"""
    pygame.mixer.init(frequency=24000, size=-16, channels=1, buffer=4096)

    buffer = bytearray()
    buffer_threshold = 24000 * 2  # 1秒的PCM数据
    playing = False
    sound = None

    while True:
        chunk = audio_queue.get()
        if chunk is None:
            if buffer and not playing:
                pcm_data = bytes(buffer)
                sound = pygame.mixer.Sound(buffer=pcm_data)
                sound.play()
                while pygame.mixer.get_busy():
                    pygame.time.wait(100)
            break

        buffer.extend(chunk)

        if len(buffer) >= buffer_threshold and not playing:
            pcm_data = bytes(buffer)
            sound = pygame.mixer.Sound(buffer=pcm_data)
            sound.play()
            buffer.clear()
            playing = True

    if playing:
        while pygame.mixer.get_busy():
            pygame.time.wait(100)

    if sound:
        try:
            sound.stop()
        except Exception:
            pass

    pygame.mixer.quit()


def main():
    parser = argparse.ArgumentParser(description="长篇小说TTS朗读器")
    parser.add_argument("file", help="小说文件路径 (.txt)")
    parser.add_argument("--voice", default=DEFAULT_VOICE, help="音色")
    parser.add_argument("--chunk", type=int, default=300, help="每段字数 (默认300)")
    parser.add_argument("--save", default="", help="保存为WAV文件路径 (可选)")
    args = parser.parse_args()

    if not os.path.isfile(args.file):
        print(f"文件不存在: {args.file}")
        sys.exit(1)

    with open(args.file, "r", encoding="utf-8") as f:
        text = f.read().strip()

    print(f"文件: {args.file}")
    print(f"总字数: {len(text)}")
    print(f"音色: {args.voice}")

    chunks = split_text(text, args.chunk)
    print(f"分为 {len(chunks)} 段 (每段约{args.chunk}字)")
    print()

    audio_queue = queue.Queue()

    print("开始合成...")

    if args.save:
        print(f"保存到: {args.save}")
        asyncio.run(stream_synthesize(chunks, args.voice, audio_queue))
        all_audio = bytearray()
        while True:
            chunk = audio_queue.get()
            if chunk is None:
                break
            all_audio.extend(chunk)
        with wave.open(args.save, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(24000)
            w.writeframes(bytes(all_audio))
        print(f"已保存: {args.save} ({len(all_audio)/1024/1024:.1f} MB)")
    else:
        print("播放中...")

        async def run_all():
            syn = asyncio.create_task(stream_synthesize(chunks, args.voice, audio_queue))
            play = asyncio.get_event_loop().run_in_executor(None, play_streaming, audio_queue)
            await asyncio.gather(syn, play)

        asyncio.run(run_all())

    print("完成!")


if __name__ == "__main__":
    main()
