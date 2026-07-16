// ChatTTS 插件共享辅助模块
// 被 main.js 和 temp_asar_extract/main.js 共用
const path = require("path");
const fs = require("fs");

/**
 * 智能查找 ChatTTS 源码目录
 * 开发版: __dirname = 项目根目录 → 直接拼接
 * 打包版: __dirname = app.asar/ → 需要向上找 3~4 级
 * 也检查绝对路径 E:\A1\chattts-ui
 */
function findChatTTSUIDir(mainDir) {
  var candidates = [
    path.join(mainDir, "chattts-ui-20260614"),
    path.join(mainDir, "..", "chattts-ui-20260614"),
    path.join(mainDir, "..", "..", "chattts-ui-20260614"),
    path.join(mainDir, "..", "..", "..", "chattts-ui-20260614"),
    path.join(mainDir, "..", "..", "..", "..", "chattts-ui-20260614"),
    path.join(mainDir, "chattts-ui"),
    path.join(mainDir, "..", "chattts-ui"),
    "E:\\A1\\koodo-reader-dev_TTS\\chattts-ui-20260614",
    "E:\\A1\\chattts-ui",
  ];
  for (var i = 0; i < candidates.length; i++) {
    if (fs.existsSync(candidates[i])) {
      return candidates[i];
    }
  }
  return null;
}

/**
 * 注册 ChatTTS 插件到前端的 plugins.db
 * - 读取 scripts/chattts-plugin.js (IIFE) 并 eval 到全局
 * - 自动查找 speaker 目录获取音色列表
 * - 写入单个插件条目 (key=chattts_voice) + voiceList JSON 数组
 * - DB 路径与前端 getDBConnection 一致: storagePath/config/plugins.db
 *
 * @param {Electron.App} app
 * @param {string} mainDir - 调用方 __dirname
 */
function registerChatTTSPlugin(app, mainDir) {
  try {
    var chatttsDir = findChatTTSUIDir(mainDir);
    if (!chatttsDir) {
      console.error("[ChatTTS] 未找到 chattts-ui-20260614 目录，跳过插件注册");
      return;
    }
    var speakerDir = path.join(chatttsDir, "speaker");

    var pluginScriptPath = path.join(mainDir, "scripts", "chattts-plugin.js");
    if (!fs.existsSync(pluginScriptPath)) {
      console.error("[ChatTTS] 插件脚本未找到:", pluginScriptPath);
      return;
    }
    var pluginScript = fs.readFileSync(pluginScriptPath, "utf8");
    // eslint-disable-next-line no-eval
    eval(pluginScript);

    // DB 路径：与前端 DatabaseService.getDBConnection 一致
    // getStorageLocation() -> app.getPath("userData")/uploads/data
    // DB = storagePath/config/plugins.db
    var storagePath = path.join(app.getPath("userData"), "uploads", "data");
    var configPath = path.join(storagePath, "config");
    if (!fs.existsSync(configPath)) {
      fs.mkdirSync(configPath, { recursive: true });
    }
    var dbPath = path.join(configPath, "plugins.db");

    var Database = require("better-sqlite3");
    var pluginDb = new Database(dbPath);
    pluginDb.pragma("journal_mode = WAL");

    // 确保表结构存在（支持 voiceList / script 字段）
    pluginDb.exec(
      'CREATE TABLE IF NOT EXISTS "plugins" (' +
        '"key" text PRIMARY KEY,' +
        '"type" text,"displayName" text,"icon" text,"version" text,' +
        '"config" text,"autoValue" text,"langList" text,"voiceList" text,' +
        '"scriptSHA256" text,"script" text)'
    );

    // 获取音色列表
    var ttsVoiceList = global.__chattts_getTTSVoice({ speakerDir: speakerDir || "" });

    // 构建 voiceList：每个音色只存简化的元数据
    var voiceList = ttsVoiceList.map(function (v) {
      return {
        name: v.name,
        displayName: v.displayName,
        gender: v.gender || "female",
        locale: v.locale || "zh-CN",
        plugin: "chattts_voice",
      };
    });

    // 清理旧条目：删除之前可能存在的多行 schema 或单条目
    pluginDb.prepare("DELETE FROM plugins WHERE key = 'chattts_voice' OR plugin = 'chattts_voice'").run();

    // 插入单个插件条目
    pluginDb
      .prepare(
        "INSERT INTO plugins (key,type,displayName,icon,version,config,autoValue,langList,voiceList,scriptSHA256,script) " +
          "VALUES (@key,@type,@displayName,@icon,@version,@config,@autoValue,@langList,@voiceList,@scriptSHA256,@script)"
      )
      .run({
        key: "chattts_voice",
        type: "voice",
        displayName: "ChatTTS",
        icon: "",
        version: "1.0.0",
        config: JSON.stringify({ serverHost: "127.0.0.1", serverPort: 9966 }),
        autoValue: null,
        langList: null,
        voiceList: JSON.stringify(voiceList),
        scriptSHA256: "",
        script: pluginScript,
      });

    pluginDb.close();
    console.log("[ChatTTS] 注册成功，共 " + voiceList.length + " 个音色");
  } catch (err) {
    console.error("[ChatTTS] 注册失败:", err);
  }
}

/**
 * 启动 ChatTTS 本地服务
 * 优先使用 chattts-ui-20260614/app.exe，其次尝试 Python venv
 * @param {string} mainDir - 调用方 __dirname
 */
function startChatTTS(mainDir) {
  try {
    var chatttsDir = findChatTTSUIDir(mainDir);
    if (!chatttsDir) {
      console.log("[ChatTTS] 未找到 chattts-ui 目录，跳过自启动");
      return;
    }
    var spawn = require("child_process").spawn;

    // 优先：app.exe（预打包版）
    var exePath = path.join(chatttsDir, "app.exe");
    if (fs.existsSync(exePath)) {
      var proc = spawn("cmd.exe", ["/c", "start", "ChatTTS Service", exePath], {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      });
      proc.unref();
      console.log("[ChatTTS] 本地服务已自动启动（app.exe）");
      return;
    }

    // 后备：Python venv（源码版）
    var pythonPath = path.join(chatttsDir, "venv", "Scripts", "python.exe");
    var appPath = path.join(chatttsDir, "app.py");
    if (fs.existsSync(pythonPath) && fs.existsSync(appPath)) {
      var proc2 = spawn(pythonPath, [appPath], {
        cwd: chatttsDir,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      proc2.unref();
      console.log("[ChatTTS] Python 服务已自动启动");
    } else {
      console.log("[ChatTTS] 未找到可执行服务（app.exe 和 Python venv 均不存在）");
    }
  } catch (err) {
    console.error("[ChatTTS] 启动失败:", err);
  }
}

module.exports = { registerChatTTSPlugin, startChatTTS };
