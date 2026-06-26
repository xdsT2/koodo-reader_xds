import axios from "axios";
import toast from "react-hot-toast";
import i18n from "../../i18n";
import { SSE } from "sse.js";
import {
  CommonTool,
  ConfigService,
  TokenService,
} from "../../assets/lib/kookit-extra-browser.min";
import { getServerRegion, reloadManager } from "../common";
import { resetReaderRequest } from "./reader";
import { resetUserRequest } from "./user";
import { resetThirdpartyRequest } from "./thirdparty";
const PUBLIC_URL = "https://api.koodoreader.com";
const CN_PUBLIC_URL = "https://api.koodoreader.cn";
let cachedPluginList: any[] | null = null;
export const getPublicUrl = () => {
  return getServerRegion() === "china" ? CN_PUBLIC_URL : PUBLIC_URL;
};
export const checkDeveloperUpdate = async () => {
  let res = await axios.get(
    getPublicUrl() + `/api/update_dev?name=${navigator.language}`
  );
  return res.data.log;
};
export const getPluginList = async () => {
  if (cachedPluginList) {
    return cachedPluginList;
  }
  let res = await axios.get(
    getPublicUrl() + `/api/get_plugins?name=${navigator.language}`
  );
  cachedPluginList = res.data.plugins;
  // 本地注入豆包语音合成插件（HTTP 单向流式，与官方插件一致）
  const doubaoPlugin = {
    plugin: {
      identifier: "doubao_tts_voice",
      type: "voice",
      displayName: "豆包语音合成",
      icon: "speaker",
      version: "1.0.0",
      config: {
        apiKey: {
          label: "API Key",
          type: "text",
          default: "",
          description: "火山引擎 API Key（从控制台获取）",
        },
        resourceId: {
          label: "模型版本",
          type: "select",
          default: "seed-tts-2.0",
          options: [
            { label: "豆包语音合成2.0", value: "seed-tts-2.0" },
            { label: "豆包声音复刻2.0", value: "seed-icl-2.0" },
          ],
          description: "选择使用的模型版本",
        },
      },
      voiceList: [],
      scriptSHA256: "doubao_http_v1",
      script: "placeholder",
    },
    name: "豆包语音合成",
    configuration: "需要火山引擎 API Key，从控制台获取。",
  };
  cachedPluginList!.push(doubaoPlugin);
  return cachedPluginList;
};
export const uploadFile = async (url: string, file: any) => {
  return new Promise<boolean>((resolve) => {
    axios
      .put(url, file, {})
      .then(() => {
        resolve(true);
      })
      .catch((err) => {
        console.error(err);
        resolve(false);
      });
  });
};
export const checkStableUpdate = async () => {
  let res = await axios.get(
    getPublicUrl() + `/api/update?name=${navigator.language}`
  );
  return res.data.log;
};
export const handleExitApp = async () => {
  toast.error(i18n.t("Authorization failed, please login again"));
  await handleClearToken();
  //路由到login页面
  reloadManager();
};
export const handleClearToken = async () => {
  await TokenService.deleteToken("is_authed");
  await TokenService.deleteToken("access_token");
  await TokenService.deleteToken("refresh_token");
  let dataSourceList = ConfigService.getAllListConfig("dataSourceList") || [];
  for (let i = 0; i < dataSourceList.length; i++) {
    let targetDrive = dataSourceList[i];
    await TokenService.setToken(targetDrive + "_token", "");
  }
  ConfigService.removeItem("defaultSyncOption");
  ConfigService.removeItem("dataSourceList");
  resetReaderRequest();
  resetUserRequest();
  resetThirdpartyRequest();
};

export const chatStream = async (
  url: string,
  providerId: string,
  apiKey: string,
  model: string,
  prompt: string,
  chat: any[],
  onMessage: (result) => void
) => {
  return new Promise<{ done: boolean }>((resolve, reject) => {
    const messages = [...chat, { role: "user", content: prompt }];
    const source = new SSE(url + "/chat/completions", {
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey,
      },
      payload: JSON.stringify({
        model,
        messages,
        stream: true,
        ...CommonTool.getDisableThinkingParams(providerId || ""),
      }),
      method: "POST",
    });

    source.addEventListener("open", () => {
      console.info("ChatStream connection established.");
    });

    source.addEventListener("message", (e: any) => {
      if (!e.data) return;
      if (e.data === "[DONE]") {
        source.close();
        resolve({ done: true });
        return;
      }
      try {
        const json = JSON.parse(e.data);
        const text = json?.choices?.[0]?.delta?.content;
        if (text) {
          onMessage({ text });
        }
      } catch (err) {
        console.error("ChatStream parse error:", err);
      }
    });

    source.addEventListener("error", (e: any) => {
      console.error("ChatStream error:", e);
      toast.error(e.data ? JSON.stringify(e.data) : "Unknown error", {
        id: "chat-stream-error",
        duration: 5000,
      });
      source.close();
      reject(e);
    });
  });
};
