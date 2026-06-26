import os
from dotenv import load_dotenv

load_dotenv()

# 火山引擎 API 配置
DOUBAO_API_KEY = os.getenv("DOUBAO_API_KEY", "")
DOUBAO_APP_ID = os.getenv("DOUBAO_APP_ID", "")

# WebSocket 连接配置 (V3 双向流式)
WS_URI = "wss://openspeech.bytedance.com/api/v3/tts/bidirection"

# 语音合成参数
VOICE_TYPE = "zh_female_xiaohe_uranus_bigtts"  # 音色类型
AUDIO_SAMPLE_RATE = 24000  # 音频采样率
AUDIO_FORMAT = "pcm"  # 音频格式 (mp3 或 pcm)
