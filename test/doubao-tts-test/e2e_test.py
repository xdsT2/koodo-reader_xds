"""模拟 main.js 的 generate-tts 豆包分支：发 TCP 请求拿 PCM，封装成 WAV。"""
import socket, json, base64, wave, sys, time

HOST, PORT = "127.0.0.1", 18765
text = "你好，这是豆包语音合成的端到端测试。"
voice = "zh_female_xiaohe_uranus_bigtts"

req = json.dumps({"text": text, "voice": voice, "format": "pcm", "sample_rate": 24000}).encode()

t0 = time.time()
with socket.create_connection((HOST, PORT), timeout=30) as s:
    s.sendall(req)
    chunks = []
    while True:
        d = s.recv(65536)
        if not d:
            break
        chunks.append(d)
    raw = b"".join(chunks)
    resp = json.loads(raw.decode())

elapsed = time.time() - t0
print(f"round-trip: {elapsed:.2f}s, success={resp.get('success')}")

if not resp.get("success"):
    print("ERROR:", resp.get("error"))
    sys.exit(1)

pcm = base64.b64decode(resp["audio"])
sr = resp.get("sample_rate", 24000)
print(f"pcm bytes={len(pcm)}, sample_rate={sr}, duration={len(pcm)/sr/2:.2f}s")

out = "test_output_e2e.wav"
with wave.open(out, "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(sr)
    w.writeframes(pcm)
print("wrote", out)
