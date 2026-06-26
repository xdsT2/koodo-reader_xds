/**
 * 更新 SQLite 插件数据库中的豆包插件脚本
 * 使用硬编码的 API Key 并注入日志功能
 */
const path = require("path");
const fs = require("fs");

const dbDir = path.join(__dirname, ".dev-user-data");
// 尝试多个可能的数据库路径
const possiblePaths = [
  path.join(dbDir, "plugins.db"),
  path.join(dbDir, "data", "plugins.db"),
  path.join(dbDir, "data", "config", "plugins.db"),
];
let dbPath = null;
for (const p of possiblePaths) {
  if (fs.existsSync(p)) {
    dbPath = p;
    break;
  }
}
if (!dbPath) {
  console.log("未找到插件数据库，已尝试路径:");
  possiblePaths.forEach(p => console.log("  " + p));
  process.exit(0);
}
console.log("找到插件数据库:", dbPath);

// 使用 better-sqlite3 或 sql.js 或直接读写
try {
  // 尝试使用 sql.js (已存在于 node_modules)
  const initSqlJs = require("sql.js");
  initSqlJs().then((SQL) => {
    const buffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(buffer);

    // 查找豆包插件
    const result = db.exec("SELECT * FROM plugins WHERE key LIKE '%doubao%'");
    if (result.length === 0 || result[0].values.length === 0) {
      console.log("未找到豆包插件记录，尝试查找所有语音插件...");
      const allResult = db.exec("SELECT * FROM plugins WHERE type = 'voice'");
      if (allResult.length > 0) {
        console.log("找到语音插件:", JSON.stringify(allResult[0].values));
      } else {
        console.log("未找到任何语音插件");
      }
      db.close();
      process.exit(0);
    }

    const row = result[0];
    const columns = row.columns;
    const values = row.values[0];

    // 构建插件对象
    const plugin = {};
    columns.forEach((col, i) => {
      try {
        plugin[col] = JSON.parse(values[i]);
      } catch {
        plugin[col] = values[i];
      }
    });

    console.log("找到插件:", plugin.key, plugin.displayName);

    // 更新脚本 - 注入 API Key
    const updatedScript = `const getAudioPath = async (text, speed, dirPath, config) => {
  const path = require("path");
  const fs = require("fs");
  const log = global.__ttsLog || (msg => {});
  log("[DoubaoPlugin] getAudioPath called: text.length=" + text.length + ", speed=" + speed);
  let audioName = new Date().getTime() + ".mp3";
  if (!fs.existsSync(path.join(dirPath, "tts"))) fs.mkdirSync(path.join(dirPath, "tts"));
  try {
    const audioData = await getTTSAudio(text, speed, config);
    fs.writeFileSync(path.join(dirPath, "tts", audioName), audioData);
    log("[DoubaoPlugin] audio saved: " + path.join(dirPath, "tts", audioName) + " (" + audioData.length + " bytes)");
    return path.join(dirPath, "tts", audioName);
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
  const lines = responseText.split("\\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj.code === 20000000) continue;
      if (obj.code !== 0) throw new Error(obj.message || "TTS error code " + obj.code);
      if (obj.data) audioChunks.push(Buffer.from(obj.data, "base64"));
    } catch (err) {
      if (err.message && err.message.startsWith("TTS error")) throw err;
    }
  }
  return Buffer.concat(audioChunks);
};
const getTTSAudio = async (text, speed, config) => {
  const log = global.__ttsLog || (msg => {});
  const apiKey = config.apiKey || "120f2e95-4030-413a-86b5-e721533197a0";
  log("[DoubaoPlugin] getTTSAudio: text.length=" + text.length + ", apiKey=" + (apiKey ? apiKey.substring(0,8)+"..." : "EMPTY"));
  if (!apiKey) return Promise.reject("Missing API Key");
  const voiceName = config.voiceName || "zh_female_xiaohe_uranus_bigtts";
  const resourceId = config.resourceId || "seed-tts-2.0";
  const url = "https://openspeech.bytedance.com/api/v3/tts/unidirectional";
  const axios = require("axios");
  const payload = {
    req_params: {
      text: text,
      speaker: voiceName,
      audio_params: { format: "mp3", sample_rate: 24000 }
    }
  };
  const speechRate = mapSpeedToSpeechRate(speed);
  if (speechRate !== 0) payload.req_params.audio_params.speech_rate = speechRate;
  log("[DoubaoPlugin] sending HTTP request to ByteDance API...");
  return new Promise((resolve, reject) => {
    const start = Date.now();
    axios.post(url, payload, {
      headers: { "X-Api-Key": apiKey, "Content-Type": "application/json", "X-Api-Resource-Id": resourceId },
      responseType: "text",
      timeout: 60000
    }).then(res => {
      const elapsed = Date.now() - start;
      log("[DoubaoPlugin] HTTP " + res.status + " in " + elapsed + "ms, data.len=" + res.data.length);
      const buf = parseChunkedResponse(res.data);
      if (!buf.length) { reject("No audio data"); return; }
      log("[DoubaoPlugin] SUCCESS: " + buf.length + " bytes in " + elapsed + "ms");
      resolve(buf);
    }).catch(err => {
      const elapsed = Date.now() - start;
      log("[DoubaoPlugin] HTTP ERROR after " + elapsed + "ms: " + (err.message || err));
      if (err.response) log("[DoubaoPlugin] status=" + err.response.status);
      reject("Failed: " + (err.message || "unknown"));
    });
  });
};
const getTTSVoice = async (config) => {
  return Promise.resolve([
    { name: "zh_female_xiaohe_uranus_bigtts", gender: "female", locale: "zh-CN", displayName: "豆包 TTS - 小何 2.0", plugin: "doubao_tts_voice", config: { ...config, apiKey: config.apiKey || "120f2e95-4030-413a-86b5-e721533197a0", voiceName: "zh_female_xiaohe_uranus_bigtts" } }
  ]);
};
global.getAudioPath = getAudioPath;
global.getTTSVoice = getTTSVoice;`;

    // 更新 config 中的 apiKey
    let config = plugin.config || {};
    if (typeof config === "string") {
      try { config = JSON.parse(config); } catch { config = {}; }
    }
    config.apiKey = "120f2e95-4030-413a-86b5-e721533197a0";

    const stmt = db.prepare("UPDATE plugins SET script = ?, config = ? WHERE key = ?");
    stmt.run([JSON.stringify(updatedScript), JSON.stringify(config), plugin.key]);
    stmt.free();

    // 保存到文件
    const newBuffer = db.export();
    fs.writeFileSync(dbPath, Buffer.from(newBuffer));
    console.log("✅ 豆包插件脚本和 API Key 已更新!");
    db.close();
  });
} catch (err) {
  console.error("更新失败:", err.message);
  console.log("尝试直接读写 JSON 备份...");
  process.exit(1);
}
