// ChatTTS 插件 — 所有内容挂在 global.__chattts_* 下，避免 eval 冲突
(function(){
  const http = require("http");
  const path = require("path");
  const fs = require("fs");

  global.__chattts_getTTSAudio = (text, speed, config) => {
    return new Promise((resolve, reject) => {
      const serverHost = config.serverHost || "127.0.0.1";
      const serverPort = config.serverPort || 9966;
      const voice = config.voiceName || config.name || config.voice || "1111";

      // 日志：写文件看看 config 到底长什么样
      try {
        fs.appendFileSync(path.join(require('os').tmpdir(), "chattts_debug.log"),
          new Date().toISOString() + " voice=" + voice + " voiceName=" + (config.voiceName==null?"NULL":config.voiceName) + " name=" + (config.name||"null") + " voiceField=" + (config.voice||"null") + " FULLCONFIG=" + JSON.stringify(config) + " text=" + text.substring(0,20) + "\n");
      } catch(e) {}

      const chatSpeed = Math.max(1, Math.min(10, Math.round((speed + 100) / 200 * 9 + 1)));
      const encodedText = encodeURIComponent(text);
      const voiceName = voice || config.voice || "2222";
      const postData = `text=${encodedText}&voice=${voiceName}&speed=${chatSpeed}&wav=1`;

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
        if (res.statusCode !== 200) {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => reject("HTTP " + res.statusCode + ": " + body));
          return;
        }
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks)));
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
