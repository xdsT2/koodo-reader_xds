// ChatTTS 插件 — 所有内容挂在 global.__chattts_* 下，避免 eval 冲突
(function(){
  const http = require("http");
  const path = require("path");
  const fs = require("fs");
  const os = require("os");

  function getUserDataDir() {
    try {
      const electron = require("electron");
      if (electron && electron.app) {
        return electron.app.getPath("userData");
      }
    } catch(e) {}
    try {
      return path.join(process.env.APPDATA || os.homedir(), "koodo-reader");
    } catch(e) {
      return "";
    }
  }

  function readVoiceNameFromConfig() {
    try {
      const userDataDir = getUserDataDir();
      if (!userDataDir) return null;
      const configPath = path.join(userDataDir, "config.json");
      if (!fs.existsSync(configPath)) return null;
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      const readerConfigRaw = config.readerConfig;
      if (!readerConfigRaw) return null;
      const readerConfig = typeof readerConfigRaw === "string" ? JSON.parse(readerConfigRaw) : readerConfigRaw;
      return readerConfig.voiceName || null;
    } catch(e) {
      return null;
    }
  }

  function readVoiceNameFromFile() {
    try {
      const userDataDir = getUserDataDir();
      if (!userDataDir) return null;
      const voiceFilePath = path.join(userDataDir, "chattts_voice.json");
      if (!fs.existsSync(voiceFilePath)) return null;
      const data = JSON.parse(fs.readFileSync(voiceFilePath, "utf8"));
      return data.voiceName || null;
    } catch(e) {
      return null;
    }
  }

  global.__chattts_getTTSAudio = (text, speed, config) => {
    return new Promise((resolve, reject) => {
      const serverHost = config.serverHost || "127.0.0.1";
      const serverPort = config.serverPort || 9966;
      let voice = config.voiceName || config.name || config.voice || "1111";

      // 优先级：config.voiceName > 独立文件 > config.json > 默认值
      const voiceFromFile = readVoiceNameFromFile();
      const configVoiceName = readVoiceNameFromConfig();
      if (voiceFromFile) {
        voice = voiceFromFile;
      } else if (configVoiceName) {
        voice = configVoiceName;
      }

      try {
        fs.appendFileSync(path.join(os.tmpdir(), "chattts_debug.log"),
          new Date().toISOString() + " voice=" + voice + " configVoiceName=" + (configVoiceName||"NULL") + " voiceFromFile=" + (voiceFromFile||"NULL") + " paramVoiceName=" + (config.voiceName==null?"NULL":config.voiceName) + " name=" + (config.name||"null") + " FULLCONFIG=" + JSON.stringify(config) + " text=" + text.substring(0,20) + "\n");
      } catch(e) {}

      const chatSpeed = Math.max(1, Math.min(10, Math.round((speed + 100) / 200 * 9 + 1)));
      const postData = "text=" + encodeURIComponent(text) + "&voice=" + voice + "&speed=" + chatSpeed + "&wav=1";

      const options = {
        hostname: serverHost,
        port: serverPort,
        path: "/tts",
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(postData),
        },
        timeout: 120000,
      };

      const req = http.request(options, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            const body = Buffer.concat(chunks).toString();
            reject("HTTP " + res.statusCode + ": " + body);
            return;
          }
          resolve(Buffer.concat(chunks));
        });
      });

      req.on("error", (err) => reject(err.message));
      req.on("timeout", () => {
        req.destroy();
        reject("请求超时");
      });
      req.write(postData);
      req.end();
    });
  };

  global.__chattts_getAudioPath = async (text, speed, dirPath, config) => {
    const log = global.__ttsLog || ((msg) => {});
    let audioName = new Date().getTime() + ".wav";
    if (!fs.existsSync(path.join(dirPath, "tts"))) {
      fs.mkdirSync(path.join(dirPath, "tts"));
    }
    try {
      const audioData = await global.__chattts_getTTSAudio(text, speed, config);
      fs.writeFileSync(path.join(dirPath, "tts", audioName), audioData);
      log("[ChatTTSPlugin] ok: " + audioName + " voice=" + (config.voiceName || config.name || config.voice || "?"));
      return path.join(dirPath, "tts", audioName);
    } catch (err) {
      log("[ChatTTSPlugin] Error: " + (err.message || err));
      throw err;
    }
  };

  global.__chattts_getTTSVoice = (config) => {
    const log = global.__ttsLog || ((msg) => {});
    const speakerDir = config.speakerDir || "";
    const voices = [];

    if (speakerDir && fs.existsSync(speakerDir)) {
      try {
        const files = fs.readdirSync(speakerDir);
        const csvFiles = files.filter(f => f.endsWith(".csv")).sort();
        for (const file of csvFiles) {
          const name = path.basename(file, ".csv");
          voices.push({
            name: name,
            displayName: "ChatTTS-" + name,
            gender: "female",
            locale: "zh-CN",
            plugin: "chattts_voice",
            config: { serverHost: "127.0.0.1", serverPort: 9966 },
          });
        }
        log("[ChatTTSPlugin] 扫描到 " + voices.length + " 个音色");
      } catch (err) {
        log("[ChatTTSPlugin] 扫描失败: " + (err.message || err));
      }
    }

    if (voices.length === 0) {
      voices.push(
        { name: "1111", displayName: "ChatTTS-青年男声", gender: "male", locale: "zh-CN", plugin: "chattts_voice", config: { serverHost: "127.0.0.1", serverPort: 9966 } },
        { name: "2222", displayName: "ChatTTS-默认女声", gender: "female", locale: "zh-CN", plugin: "chattts_voice", config: { serverHost: "127.0.0.1", serverPort: 9966 } },
        { name: "3333", displayName: "ChatTTS-温柔女声", gender: "female", locale: "zh-CN", plugin: "chattts_voice", config: { serverHost: "127.0.0.1", serverPort: 9966 } },
        { name: "4444", displayName: "ChatTTS-御姐音", gender: "female", locale: "zh-CN", plugin: "chattts_voice", config: { serverHost: "127.0.0.1", serverPort: 9966 } },
        { name: "5555", displayName: "ChatTTS-沉稳男声", gender: "male", locale: "zh-CN", plugin: "chattts_voice", config: { serverHost: "127.0.0.1", serverPort: 9966 } }
      );
    }
    return voices;
  };
})();
