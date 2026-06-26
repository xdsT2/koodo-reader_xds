# 项目记忆 — Koodo Reader TTS 改造版

## 项目本质
Koodo Reader（跨平台电子书阅读器，Electron 34 + React 18 + TypeScript + CRA）的二次开发分支，目录名带 `_TTS`，核心是在原版基础上集成文本转语音（TTS）功能。上游：https://github.com/koodo-reader/koodo-reader ，版本 2.3.8。

## 技术栈
- 前端：React 18 + react-scripts 5 (CRA) + Redux + react-router-dom 5 + i18next
- 桌面：Electron 34，入口 `main.js`（约 2094 行，承载大量自定义 IPC）
- 音频播放：howler
- 数据存储：better-sqlite3（plugins 表等）
- 打包：electron-builder → `dist5/`（Win 当前为 dir target，便携版）

## TTS 架构（本分支重点）
两条语音通路：
1. **官方 AI 语音** (`official-ai-voice-plugin`)：前端 `getTTSAudio` 直接请求，返回 base64，前端并发缓存(限流10)。
2. **自定义插件**（重点：豆包 TTS）：串行缓存。

### 豆包 TTS 后端实现 (main.js)
- 启动时 `registerDoubaoPlugin()` 自动向 SQLite `plugins` 表注册 `doubao_tts_voice` 插件，含 6 个音色（小何/Vivi/云舟/小天/灿灿/苏菲，均为 `*_uranus_bigtts`）。
- **generate-tts 豆包分支**（2026-06-25 修复后）：检测 `plugin.key === "doubao_tts_voice"`，若 Python 服务未运行则自动 spawn `test/doubao-tts-test/doubao_tts_server.py`（用 `resolveDoubaoPython()` 查项目内 .venv），探测端口就绪后通过 TCP 18765 发合成请求，PCM 封装成 WAV 落盘返回路径。
- `doubao-tts-start/stop/synthesize` 三个 handler 现为冗余（generate-tts 已自动启动），保留无害。
- `clear-tts`：清空 tts 临时目录。
- `tts-write-log`：渲染进程通过 IPC 写 `tts-debug.log`。

### 豆包 TTS Python 服务 (test/doubao-tts-test/)
- `doubao_tts_server.py`：WebSocket 双向流式连字节跳动 `wss://openspeech.bytedance.com/api/v3/tts/bidirection`，本地 TCP 127.0.0.1:18765。
- `.env` 配 `DOUBAO_API_KEY` + `DOUBAO_APP_ID`（与 HTTP 单向流式的 `120f2e95-...` 是两套 key 体系，不通用）。
- 项目内 `.venv`（test/doubao-tts-test/.venv）装 websockets + python-dotenv。
- 音频返回 PCM，main.js 封装 WAV。

### 前端 (src/utils/reader/ttsUtil.ts)
- `TTSUtil` 静态类：管理 Howl 播放器、audioPaths 缓存、processingIndexes 去重、pause/resume/stop。
- `ttsLog()` 走 IPC 写文件日志。
- 缓存清理：保留 `index >= currentIndex - 10` 的已朗读项。
- **并发控制（2026-06-25 新增）**：
  - `sessionId` 计数器：`stopAudio`/`setAudioPaths` 递增，`cacheAudio` 捕获后检查，防止旧 cacheAudio 的过期数据污染新会话。
  - `stopAudio` 改为立即清理（原来有 1s setTimeout 延迟，会导致快速重启时清掉新会话缓存）。
  - `setAudioPaths` 现在也重置 `isPaused = false`。

### 前端 (src/components/textToSpeech/component.tsx)
- **`readGeneration` 计数器（2026-06-25 新增）**：`handleStartAudio`/`handleVoiceSwitch`/`handlePrevSentence`/`handleNextSentence` 均递增。`handleCustomRead` 捕获后检查，旧循环安静退出（不报错、不 setState），防止快速操作时旧循环报错把新会话也停了。
- `handleSpeechAutoStartRequest` 在 `handleStop` 后显式重置 `TTSUtil.isPaused = false`，并 `await handleStartAudio`（原来是 fire-and-forget）。

### 语速参数链路（2026-06-26 修复）
- UI voiceSpeed (0.1~8) → `handleCustomRead` 做 `speed*100-100` → `cacheAudio` → `getAudioPath` IPC → main.js
- 官方 AI 语音：`getTTSAudio` 传 `(speed+100)/100` 倍速比。
- 豆包 TTS：main.js 直接用 `speechRate = speed`（格式已一致：-50=0.5x, 0=1.0x, 100=2.0x），clamp [-50, 100]，传 Python → `make_payload` 的 `audio_params.speech_rate`。
- **注意**：豆包双向流式 API 的语速参数名是 `speech_rate`（不是 `speed_ratio`），取值 [-50, 100]。API 限制 0.5x~2.0x，超出无效。

## 关键文件
- `main.js` — Electron 主进程，TTS IPC 与豆包插件注册
- `src/utils/reader/ttsUtil.ts` — 前端 TTS 播放/缓存核心
- `src/constants/ttsList.tsx` — 语言映射 + 官方 AI 声音列表
- `test/doubao-tts-test/doubao_tts_server.py` — 豆包 TTS Python 服务
- `scripts/doubao-tts-plugin.js` — 豆包插件脚本
- `start-with-tts-log.bat` — 调试启动脚本（拷贝正式配置→build→electron 启动记日志）
- `tts-debug.log` — TTS 运行日志

## 开发命令
- `yarn dev` — 桌面开发模式（concurrently 起 CRA + electron）
- `yarn start` — 纯 web 模式
- `yarn build` → `yarn ele` / `yarn release`
- `start-with-tts-log.bat` — 便携调试（用 .dev-user-data 隔离配置）

## 注意点
- 配置隔离：开发调试用 `.dev-user-data/`，正式版数据在 `%APPDATA%\koodo-reader`。
- 依赖已装（node_modules + build 均存在），可直接调试。
- 最近日志显示"豆包插件已存在，跳过注册"——插件注册逻辑会跳过已存在项。
