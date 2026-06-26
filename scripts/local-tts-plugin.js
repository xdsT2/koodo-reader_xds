// 本地 TTS 插件脚本 - 调用局域网内的 DoBao TTS 服务
// API: http://192.168.1.240:3000/api/reader/tts/stream
// GET 请求，返回 MP3 音频流

const getAudioPath = async (text, speed, dirPath, config) => {
  const path = require("path");
  const fs = require("fs");
  const log = global.__ttsLog || ((msg) => {});
  log("[LocalTTS] getAudioPath called: text.length=" + text.length + ", speed=" + speed);

  let audioName = new Date().getTime() + ".mp3";
  if (!fs.existsSync(path.join(dirPath, "tts"))) {
    fs.mkdirSync(path.join(dirPath, "tts"));
    log("[LocalTTS] created tts dir: " + path.join(dirPath, "tts"));
  }

  try {
    const audioData = await getTTSAudio(text, speed, config);
    fs.writeFileSync(path.join(dirPath, "tts", audioName), audioData);
    const fullPath = path.join(dirPath, "tts", audioName);
    log("[LocalTTS] audio saved: " + fullPath + " (" + audioData.length + " bytes)");
    return fullPath;
  } catch (err) {
    log("[LocalTTS] getAudioPath failed: " + (err.message || err));
    throw err;
  }
};

const getTTSAudio = async (text, speed, config) => {
  const http = require("http");
  const log = global.__ttsLog || ((msg) => {});
  const serverHost = config.serverHost || "192.168.1.240";
  const serverPort = config.serverPort || 3000;
  const voiceName = config.voiceName || "zh_female_wenroutaozi_uranus_bigtts";
  const delay = config.delay || 0;

  // 构建 API URL
  const encodedText = encodeURIComponent(text);
  const urlPath = `/api/reader/tts/stream?text=${encodedText}&speed=${speed}&voice=${voiceName}&usePrefetch=false&delay=${delay}`;

  log("[LocalTTS] requesting: http://" + serverHost + ":" + serverPort + urlPath);

  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const options = {
      hostname: serverHost,
      port: serverPort,
      path: urlPath,
      method: "GET",
      timeout: 120000, // 2 分钟超时
    };

    const req = http.request(options, (response) => {
      if (response.statusCode !== 200) {
        log("[LocalTTS] HTTP error: status=" + response.statusCode);
        reject("[LocalTTS] 服务返回错误: HTTP " + response.statusCode);
        return;
      }

      const chunks = [];
      response.on("data", (chunk) => {
        chunks.push(chunk);
      });

      response.on("end", () => {
        const elapsed = Date.now() - startTime;
        const audioBuffer = Buffer.concat(chunks);
        log("[LocalTTS] SUCCESS: received " + audioBuffer.length + " bytes in " + elapsed + "ms");

        if (!audioBuffer.length) {
          log("[LocalTTS] No audio data received");
          reject("[LocalTTS] 未收到音频数据");
          return;
        }
        resolve(audioBuffer);
      });
    });

    req.on("error", (error) => {
      const elapsed = Date.now() - startTime;
      log("[LocalTTS] ERROR after " + elapsed + "ms: " + (error.message || error));
      if (error.code === "ECONNREFUSED") {
        reject("[LocalTTS] 无法连接服务器 " + serverHost + ":" + serverPort + "，请确保服务已启动");
      } else if (error.code === "ETIMEDOUT" || error.code === "ESOCKETTIMEDOUT") {
        reject("[LocalTTS] 请求超时，请检查网络");
      } else {
        reject("[LocalTTS] 请求失败: " + (error.message || error));
      }
    });

    req.on("timeout", () => {
      req.destroy();
      log("[LocalTTS] Request timeout after 120s");
      reject("[LocalTTS] 请求超时（120s）");
    });

    req.end();
  });
};

const getTTSVoice = async (config) => {
  const voices = [
    // 升级版
    { name: "zh_female_wenroutaozi_uranus_bigtts", displayName: "温柔桃子（升级版）", gender: "female", locale: "zh-CN" },
    { name: "zh_male_junyu_uranus_bigtts", displayName: "磁性俊宇（升级版）", gender: "male", locale: "zh-CN" },
    { name: "zh_female_sunshine_uranus_bigtts", displayName: "阳光甜妹（升级版）", gender: "female", locale: "zh-CN" },
    // 经典版
    { name: "zh_female_wenroutaozi_classic_bigtts", displayName: "温柔桃子（经典版）", gender: "female", locale: "zh-CN" },
    { name: "zh_female_sophie_uranus_bigtts", displayName: "魅力苏菲", gender: "female", locale: "zh-CN" },
    { name: "zh_female_xiaohe_uranus_bigtts", displayName: "邻家女孩", gender: "female", locale: "zh-CN" },
    { name: "zh_female_saijiao_uranus_bigtts", displayName: "撒娇学妹", gender: "female", locale: "zh-CN" },
    { name: "zh_male_linjia_uranus_bigtts", displayName: "邻家男孩", gender: "male", locale: "zh-CN" },
    { name: "zh_male_youyou_uranus_bigtts", displayName: "悠悠君子", gender: "male", locale: "zh-CN" },
  ];

  return Promise.resolve(
    voices.map((voice) => ({
      name: voice.name,
      gender: voice.gender,
      locale: voice.locale,
      displayName: `本地TTS - ${voice.displayName}`,
      plugin: "local_tts_voice",
      config: {
        ...config,
        serverHost: config.serverHost || "192.168.1.240",
        serverPort: config.serverPort || 3000,
        voiceName: voice.name,
        delay: config.delay || 0,
      },
    })),
  );
};

global.getAudioPath = getAudioPath;
global.getTTSVoice = getTTSVoice;
