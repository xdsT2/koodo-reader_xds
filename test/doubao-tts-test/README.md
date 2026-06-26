# 豆包语音合成测试项目

基于火山引擎豆包语音API V3双向流式协议的语音合成测试工具。

## 项目结构

```
doubao-tts-test/
├── config.py              # 配置文件
├── doubao_tts_client.py   # TTS客户端 (V3协议)
├── main.py                # 主程序入口
├── test_tts_ws.py         # V3协议参考实现 (交互式)
├── requirements.txt       # 依赖包
├── .env                   # 环境变量 (API密钥)
├── .env.example           # 环境变量示例
└── README.md              # 说明文档
```

## 快速开始

### 1. 安装依赖

```bash
pip install -r requirements.txt
```

### 2. 配置API密钥

复制 `.env.example` 为 `.env`，填入您的API密钥：

```env
DOUBAO_API_KEY=your_api_key_here
DOUBAO_APP_ID=your_app_id_here
```

### 3. 运行测试

```bash
# 测试连接
python main.py connect

# 测试语音合成
python main.py synthesize

# 批量测试
python main.py batch
```

### 4. 交互式合成 (test_tts_ws.py)

```bash
python test_tts_ws.py --api-key YOUR_API_KEY
```

## 支持的音色

默认音色: `zh_female_xiaohe_uranus_bigtts`

## API说明

- 协议: V3 双向流式 WebSocket
- 端点: `wss://openspeech.bytedance.com/api/v3/tts/bidirection`
- 认证: HTTP Header (`X-Api-App-Key` + `X-Api-Access-Key`)

## 功能特性

- V3双向流式WebSocket通信
- 实时音频数据接收
- 支持PCM/MP3格式
- 批量测试功能

## 注意事项

1. 确保网络连接正常
2. API密钥请妥善保管，不要泄露
3. 音频输出默认为WAV格式，采样率24kHz
