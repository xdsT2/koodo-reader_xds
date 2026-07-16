import { Howl } from "howler";
import PluginModel from "../../models/Plugin";
import { getAllVoices, getFormatFromAudioPath } from "../common";
import { getTTSAudio } from "../request/reader";
import { isElectron } from "react-device-detect";

// TTS 调试日志：写入文件而非 console（无 DevTools 时可用）
export async function ttsLog(message: string) {
  try {
    if (isElectron) {
      await window.require("electron").ipcRenderer.invoke("tts-write-log", message);
    }
  } catch (_) {
    // 静默失败
  }
}

class TTSUtil {
  static player: any;
  static audioPaths: { index: number; audioPath: string }[] = [];
  static isPaused: boolean = false;
  static pausedMidSentence: boolean = false;
  static processingIndexes: Set<number> = new Set();
  // 会话代次：每次 stop/setAudioPaths 递增，用于让旧的 cacheAudio 知道自己已过期
  static sessionId: number = 0;
  static async readAloud(currentIndex: number) {
    // 清理比当前 index 小 10 的已朗读缓存
    this.audioPaths = this.audioPaths.filter(
      (item) => item.index >= currentIndex - 10
    );
    return new Promise<string>(async (resolve) => {
      const checkInterval = 200;

      ttsLog("[TTSUtil] readAloud: waiting for index=" + currentIndex + ", processing=" + this.processingIndexes.has(currentIndex));

      while (true) {
        let audioPath = this.audioPaths.find(
          (item) => item.index === currentIndex
        )?.audioPath;

        if (audioPath) {
          ttsLog("[TTSUtil] readAloud: audio ready for index=" + currentIndex);
          var sound = new Howl({
            src: [audioPath],
            format: [getFormatFromAudioPath(audioPath)],
            onloaderror: () => {
              resolve("loaderror");
            },
            onload: async () => {
              this.player.play();
              resolve("load");
            },
          });
          this.player = sound;
          return;
        }

        await new Promise(r => setTimeout(r, checkInterval));
      }
    });
  }
  static async cacheAudio(
    startIndex: number,
    speed: number,
    plugins: PluginModel[],
    audioNodeList: {
      text: string;
      voiceName: string;
      voiceEngine: string;
    }[],
    targetCacheCount: number,
    isFirst: boolean,
    isOfficialAIVoice: boolean
  ) {
    this.isPaused = false;
    const mySession = this.sessionId;

    ttsLog("[TTSUtil] cacheAudio start: startIndex=" + startIndex + ", isOfficialAI=" + isOfficialAIVoice + ", targetCache=" + targetCacheCount + ", total=" + audioNodeList.length + ", session=" + mySession);
    if (isOfficialAIVoice) {
      const cacheCount = Math.min(
        targetCacheCount,
        audioNodeList.length - startIndex
      );
      // 并发执行，并发数量为3，但保证添加顺序
      const CONCURRENT_LIMIT = 10;
      //删除index小于startIndex的缓存
      this.audioPaths = this.audioPaths.filter(
        (item) => item.index >= startIndex - 5
      );

      for (let i = 0; i < cacheCount; i += CONCURRENT_LIMIT) {
        const batch: any[] = [];

        for (let j = 0; j < CONCURRENT_LIMIT && i + j < cacheCount; j++) {
          const index = startIndex + i + j;
          if (index >= audioNodeList.length) break;

          // 如果已经缓存过或正在处理中，跳过
          if (
            this.audioPaths.find((item) => item.index === index) ||
            this.processingIndexes.has(index)
          ) {
            continue;
          }

          // 标记为正在处理
          this.processingIndexes.add(index);

          const audioNode = audioNodeList[index];
          let plugin = plugins.find(
            (item) => item.key === audioNode.voiceEngine
          );
          if (!plugin) {
            ttsLog("[TTSUtil] cacheAudio: plugin not found for engine=" + audioNode.voiceEngine);
            return "error";
          }
          let voice = (plugin.voiceList as any[]).find(
            (voice) => voice.name === audioNode.voiceName
          );
          if (!voice) {
            ttsLog("[TTSUtil] cacheAudio: voice not found: name=" + audioNode.voiceName);
            return "error";
          }
          // 创建异步任务
          const task = this.getAudioPath(
            audioNode.text,
            speed,
            audioNode.voiceEngine,
            plugin,
            voice,
            isFirst
          )
            .then(async (res) => {
              // 处理完成后，从处理集合中移除
              this.processingIndexes.delete(index);
              // 会话已变更（用户重新开始/停止），丢弃过期结果
              if (this.sessionId !== mySession) {
                ttsLog("[TTSUtil] cacheAudio: session expired, discarding index=" + index);
                return null;
              }
              if (res) {
                return { index, audioPath: res };
              } else {
                ttsLog("[TTSUtil] cacheAudio: getAudioPath returned empty for index=" + index);
                this.isPaused = true;
                return null;
              }
            })
            .catch((error) => {
              // 出错时也要从处理集合中移除
              this.processingIndexes.delete(index);
              ttsLog("[TTSUtil] Error caching audio for index " + index + ": " + (error?.message || error));
              return null;
            });
          batch.push(task);
        }

        // 等待当前批次完成
        const batchResults = await Promise.all(batch);

        // 会话已变更，停止缓存
        if (this.sessionId !== mySession) {
          ttsLog("[TTSUtil] cacheAudio: session expired during batch, aborting");
          return;
        }

        // 将结果存储到 Map 中
        for (const result of batchResults) {
          if (result) {
            if (this.audioPaths.find((item) => item.index === result.index)) {
              this.audioPaths = this.audioPaths.map((item) => {
                if (item.index === result.index) {
                  return result;
                } else {
                  return item;
                }
              });
            } else {
              this.audioPaths.push(result);
            }
          } else {
            this.isPaused = true;
            ttsLog("[TTSUtil] cacheAudio: batch failed, pausing");
            return "error";
          }
        }
      }
    } else {
      let maxCacheIndex = Math.min(
        startIndex + targetCacheCount,
        audioNodeList.length
      );
      ttsLog("[TTSUtil] cacheAudio: custom plugin, range=" + startIndex + "-" + (maxCacheIndex - 1));
      for (let index = startIndex; index < maxCacheIndex; index++) {
        if (this.isPaused) {
          ttsLog("[TTSUtil] cacheAudio: paused at index=" + index);
          break;
        }
        // 如果已经缓存过或正在处理中，跳过
        if (
          this.audioPaths.find((item) => item.index === index) ||
          this.processingIndexes.has(index)
        ) {
          continue;
        }
        // 标记为正在处理
        this.processingIndexes.add(index);
        const audioNode = audioNodeList[index];
        ttsLog("[TTSUtil] cacheAudio: caching index=" + index + " engine=" + audioNode.voiceEngine + " voice=" + audioNode.voiceName);
        let plugin = plugins.find((item) => item.key === audioNode.voiceEngine);
        if (!plugin) {
          ttsLog("[TTSUtil] cacheAudio: plugin not found for engine=" + audioNode.voiceEngine);
          return "error";
        }
        let voice = (plugin.voiceList as any[]).find(
          (voice) => voice.name === audioNode.voiceName
        );
        if (!voice) {
          ttsLog("[TTSUtil] cacheAudio: voice not found: name=" + audioNode.voiceName);
          return "error";
        }
        let audioPath = await this.getAudioPath(
          audioNode.text,
          speed,
          audioNode.voiceEngine,
          plugin,
          voice,
          isFirst
        );
        // 处理完成后，从处理集合中移除
        this.processingIndexes.delete(index);
        // 会话已变更（用户重新开始/停止），丢弃过期结果
        if (this.sessionId !== mySession) {
          ttsLog("[TTSUtil] cacheAudio: session expired after getAudioPath, discarding index=" + index);
          return;
        }
        if (audioPath) {
          ttsLog("[TTSUtil] cacheAudio: cached index=" + index + " OK");
          this.audioPaths.push({ index: index, audioPath: audioPath });
        } else {
          ttsLog("[TTSUtil] cacheAudio: failed for index=" + index + ", pausing");
          this.isPaused = true;
          break;
        }
      }
    }
    ttsLog("[TTSUtil] cacheAudio done, cached=" + this.audioPaths.length + " paths");
  }
  static async pauseAudio() {
    if (this.player) {
      this.player.pause();
      this.isPaused = true;
      this.pausedMidSentence = true;
    }
  }
  static resumeAudio(): boolean {
    if (this.player && this.pausedMidSentence) {
      this.player.play();
      this.isPaused = false;
      this.pausedMidSentence = false;
      return true;
    }
    return false;
  }
  static async stopAudio() {
    if (this.player && this.player.stop) {
      this.player.stop();
    }
    this.player = null;
    // 递增 sessionId，让所有在途的 cacheAudio 知道自己已过期
    this.sessionId++;
    // isPaused = true 让正在运行的 cacheAudio 循环尽快 break
    this.isPaused = true;
    this.pausedMidSentence = false;
    // 立即清理，不延迟 —— 延迟清理会在快速重新开始时清掉新会话的缓存
    this.audioPaths = [];
    this.processingIndexes.clear();
    this.clearAudioPaths();
  }
  static async clearAudioPaths() {
    if (!isElectron) return;
    window.require("electron").ipcRenderer.invoke("clear-tts");
  }
  static getAudioPaths() {
    return this.audioPaths;
  }
  static async getAudioPath(
    text: string,
    speed: number,
    voiceEngine: string,
    plugin,
    voice,
    isFirst: boolean
  ) {
    if (voiceEngine === "official-ai-voice-plugin") {
      ttsLog("[TTSUtil] getAudioPath: official-ai-voice, text.length=" + text.length);
      let res = await getTTSAudio(
        text,
        voice.language,
        voice.name,
        (speed + 100) / 100,
        1.0,
        isFirst
      );
      if (res && res.data && res.data.audio_base64) {
        ttsLog("[TTSUtil] getAudioPath: official-ai-voice SUCCESS");
        return res.data.audio_base64;
      }
      ttsLog("[TTSUtil] getAudioPath: official-ai-voice returned empty");
      return "";
    } else {
      ttsLog("[TTSUtil] getAudioPath: plugin=" + voiceEngine + ", text.length=" + text.length + ", speed=" + speed + ", voiceName=" + (voice?.name || "UNDEFINED") + ", pluginConfig=" + JSON.stringify(plugin.config));
      let startTime = Date.now();
      let audioPath = await window
        .require("electron")
        .ipcRenderer.invoke("generate-tts", {
          text: text,
          speed,
          plugin: plugin,
          config: { ...plugin.config, voiceName: voice?.name },
        });
      let elapsed = Date.now() - startTime;
      ttsLog("[TTSUtil] getAudioPath: IPC return after " + elapsed + "ms, result=" + (audioPath ? "path:" + audioPath : "null/empty"));
      return audioPath;
    }
  }
  static setAudioPaths() {
    this.sessionId++;
    this.audioPaths = [];
    this.processingIndexes.clear();
    this.pausedMidSentence = false;
    this.isPaused = false;
  }
  static getPlayer() {
    return this.player;
  }
  static getVoiceList(plugins: PluginModel[]) {
    let voices = getAllVoices(plugins);

    return voices;
  }
}
export default TTSUtil;
