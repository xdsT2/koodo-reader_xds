// 豆包 TTS 插件脚本 - 基于官方 volcengineTTSVoice.js
// HTTP 单向流式，返回 MP3

const getAudioPath = async (text, speed, dirPath, config) => {
  const path = require("path");
  const fs = require("fs");
  const log = global.__ttsLog || ((msg) => {});
  log("[DoubaoPlugin] getAudioPath called: text.length=" + text.length + ", speed=" + speed + ", dirPath=" + dirPath + ", config.apiKey=" + (config.apiKey ? config.apiKey.substring(0, 8) + "..." : "EMPTY!"));
  let audioName = new Date().getTime() + ".mp3";
  if (!fs.existsSync(path.join(dirPath, "tts"))) {
    fs.mkdirSync(path.join(dirPath, "tts"));
    log("[DoubaoPlugin] created tts dir: " + path.join(dirPath, "tts"));
  }
  try {
    const audioData = await getTTSAudio(text, speed, config);
    fs.writeFileSync(
      path.join(dirPath, "tts", audioName),
      audioData,
    );
    const fullPath = path.join(dirPath, "tts", audioName);
    log("[DoubaoPlugin] audio saved: " + fullPath + " (" + audioData.length + " bytes)");
    return fullPath;
  } catch (err) {
    log("[DoubaoPlugin] getAudioPath failed: " + (err.message || err));
    throw err;
  }
};

const mapSpeedToSpeechRate = (speed) => {
  if (!speed || speed === 1.0) return 0;
  return Math.min(100, Math.max(-50, Math.round((speed - 1) * 100)));
};

const parseChunkedResponse = (responseText) => {
  const audioChunks = [];
  const lines = responseText.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      const code = obj.code || 0;
      if (code === 20000000) continue;
      if (code !== 0) {
        throw new Error(obj.message || `TTS error code ${code}`);
      }
      if (obj.data) {
        audioChunks.push(Buffer.from(obj.data, "base64"));
      }
    } catch (err) {
      if (err.message && err.message.startsWith("TTS error")) throw err;
    }
  }
  return Buffer.concat(audioChunks);
};

const getTTSAudio = async (text, speed, config) => {
  const log = global.__ttsLog || ((msg) => {});
  const apiKey = config.apiKey || "120f2e95-4030-413a-86b5-e721533197a0";
  log("[DoubaoPlugin] getTTSAudio start: text.length=" + text.length + ", speed=" + speed + ", voiceName=" + (config.voiceName || "default") + ", resourceId=" + (config.resourceId || "default"));
  if (!apiKey) {
    log("[DoubaoPlugin] MISSING API KEY in plugin config!");
    return Promise.reject("[DoubaoPlugin] Missing API Key - check plugin configuration");
  }

  const voiceName = config.voiceName || "zh_female_xiaohe_uranus_bigtts";
  const resourceId = config.resourceId || "seed-tts-2.0";
  const url = "https://openspeech.bytedance.com/api/v3/tts/unidirectional";
  log("[DoubaoPlugin] using URL=" + url + ", apiKey prefix=" + apiKey.substring(0, 8) + "..., resourceId=" + resourceId);
  const axios = require("axios");

  const audioParams = {
    format: "mp3",
    sample_rate: 24000,
  };
  const speechRate = mapSpeedToSpeechRate(speed);
  if (speechRate !== 0) {
    audioParams.speech_rate = speechRate;
    log("[DoubaoPlugin] speech_rate=" + speechRate);
  }

  const payload = {
    req_params: {
      text: text,
      speaker: voiceName,
      audio_params: audioParams,
    },
  };

  log("[DoubaoPlugin] sending HTTP request to ByteDance API...");

  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    axios
      .post(url, payload, {
        headers: {
          "X-Api-Key": apiKey,
          "Content-Type": "application/json",
          "X-Api-Resource-Id": resourceId,
        },
        responseType: "text",
        timeout: 60000,
      })
      .then((response) => {
        const elapsed = Date.now() - startTime;
        log("[DoubaoPlugin] HTTP response received in " + elapsed + "ms, status=" + response.status + ", data.length=" + response.data.length);
        const audioBuffer = parseChunkedResponse(response.data);
        if (!audioBuffer.length) {
          log("[DoubaoPlugin] No audio data parsed from response");
          reject("[DoubaoPlugin] No audio data in response");
          return;
        }
        log("[DoubaoPlugin] SUCCESS: parsed " + audioBuffer.length + " bytes audio in " + elapsed + "ms");
        resolve(audioBuffer);
      })
      .catch((error) => {
        const elapsed = Date.now() - startTime;
        let errorMsg = "[DoubaoPlugin] HTTP ERROR after " + elapsed + "ms: " + (error.message || error);
        let userMsg = "";
        
        if (error.response) {
          log("[DoubaoPlugin] response status=" + error.response.status + ", data=" + JSON.stringify(error.response.data).substring(0, 200));
          const respData = error.response.data;
          let code = 0;
          let msg = "";
          try {
            const parsed = typeof respData === 'string' ? JSON.parse(respData) : respData;
            code = parsed.code || parsed.error_code || 0;
            msg = parsed.message || parsed.error_msg || "";
          } catch (e) {
            code = error.response.status;
            msg = typeof respData === 'string' ? respData.substring(0, 100) : "HTTP " + error.response.status;
          }
          
          if (code === 401 || code === 403 || msg.includes("auth") || msg.includes("invalid") || msg.includes("expired")) {
            userMsg = "[豆包TTS] API Key无效或已过期，请检查配置";
          } else if (code === 402 || msg.includes("balance") || msg.includes("quota") || msg.includes("欠费") || msg.includes("余额")) {
            userMsg = "[豆包TTS] 账户余额不足或配额已用完，请充值";
          } else if (code === 429) {
            userMsg = "[豆包TTS] 请求过于频繁，请稍后重试";
          } else if (code === 500 || code === 502 || code === 503) {
            userMsg = "[豆包TTS] 服务端错误，请稍后重试";
          } else {
            userMsg = "[豆包TTS] 服务异常: " + code + " - " + msg;
          }
          log("[DoubaoPlugin] user friendly msg: " + userMsg);
        } else if (error.code === 'ECONNABORTED') {
          log("[DoubaoPlugin] Request TIMEOUT (60s)");
          userMsg = "[豆包TTS] 请求超时，请检查网络";
        } else if (error.code === 'ENOTFOUND' || error.code === 'ETIMEDOUT') {
          log("[DoubaoPlugin] Network error: " + error.code + " - cannot reach API server");
          userMsg = "[豆包TTS] 网络连接失败，请检查网络";
        }
        
        const finalMsg = userMsg || "[DoubaoPlugin] Failed: " + (error.message || "unknown error");
        log(errorMsg);
        reject(finalMsg);
      });
  });
};

const getTTSVoice = async (config) => {
  const voices = [
    { name: "zh_female_xiaohe_uranus_bigtts", displayName: "小何 2.0", gender: "female", locale: "zh-CN" },
    { name: "zh_female_vv_uranus_bigtts", displayName: "Vivi 2.0", gender: "female", locale: "zh-CN" },
    { name: "zh_male_m191_uranus_bigtts", displayName: "云舟 2.0", gender: "male", locale: "zh-CN" },
    { name: "zh_male_taocheng_uranus_bigtts", displayName: "小天 2.0", gender: "male", locale: "zh-CN" },
    { name: "zh_female_cancan_uranus_bigtts", displayName: "知性灿灿 2.0", gender: "female", locale: "zh-CN" },
    { name: "zh_female_sophie_uranus_bigtts", displayName: "魅力苏菲 2.0", gender: "female", locale: "zh-CN" },
  ];
  return Promise.resolve(
    voices.map((voice) => ({
      name: voice.name,
      gender: voice.gender,
      locale: voice.locale,
      displayName: `豆包 TTS - ${voice.displayName}`,
      plugin: "doubao_tts_voice",
      config: {
        ...config,
        apiKey: config.apiKey || "120f2e95-4030-413a-86b5-e721533197a0",
        voiceName: voice.name,
      },
    })),
  );
};

global.getAudioPath = getAudioPath;
global.getTTSVoice = getTTSVoice;
