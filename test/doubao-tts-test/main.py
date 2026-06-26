import os
import sys
import io
import wave
from doubao_tts_client import DoubaoTTSClient
from config import VOICE_TYPE

if hasattr(sys.stdout, 'buffer') and sys.stdout.encoding != 'utf-8':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')


def test_connection():
    client = DoubaoTTSClient()
    if client.connect():
        print("[OK] 连接测试通过")
        client.disconnect()
        return True
    else:
        print("[FAIL] 连接测试失败")
        return False


def test_synthesis(text: str = "你好，欢迎使用豆包语音合成服务。", voice_type: str = None):
    client = DoubaoTTSClient()
    if not client.connect():
        print("[FAIL] 无法连接到服务器")
        return None

    print(f"正在合成文本: {text}")
    print(f"音色类型: {voice_type or VOICE_TYPE}")

    audio_data = client.synthesize(text, voice_type)
    client.disconnect()

    if audio_data:
        output_file = "test_output.wav"
        save_wav(audio_data, output_file)
        print(f"[OK] 语音合成成功，已保存到: {output_file}")
        return output_file
    else:
        print("[FAIL] 语音合成失败")
        return None


def save_wav(audio_data: bytes, filename: str, sample_rate: int = 24000, channels: int = 1, sample_width: int = 2):
    with wave.open(filename, 'wb') as wav_file:
        wav_file.setnchannels(channels)
        wav_file.setsampwidth(sample_width)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(audio_data)


def batch_test():
    test_cases = [
        ("你好，这是一条测试消息。", None),
        ("今天天气真不错，适合出去散步。", None),
        ("豆包语音合成，让文字变成声音。", None),
    ]

    results = []
    for text, voice in test_cases:
        print(f"\n测试: {text}")
        result = test_synthesis(text, voice)
        results.append((text, result))

    print("\n=== 批量测试结果 ===")
    for text, result in results:
        status = "[OK] 成功" if result else "[FAIL] 失败"
        print(f"{status}: {text}")


if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1:
        command = sys.argv[1]
        if command == "connect":
            test_connection()
        elif command == "synthesize":
            text = sys.argv[2] if len(sys.argv) > 2 else "你好，欢迎使用豆包语音合成服务。"
            test_synthesis(text)
        elif command == "batch":
            batch_test()
        else:
            print("用法:")
            print("  python main.py connect      - 测试连接")
            print("  python main.py synthesize   - 测试合成")
            print("  python main.py batch        - 批量测试")
    else:
        print("豆包语音合成测试工具")
        print("=" * 40)
        print("\n正在执行连接测试...")
        test_connection()
        print("\n正在执行合成测试...")
        test_synthesis()