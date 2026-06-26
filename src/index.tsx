import React from "react";
import ReactDOM from "react-dom";
import "./assets/styles/reset.css";
import "./assets/styles/global.css";
import "./assets/styles/style.css";
import { Provider } from "react-redux";
import "./i18n";
import store from "./store";
import Router from "./router/index";
import StyleUtil from "./utils/reader/styleUtil";
import {
  initSystemFont,
  initTheme,
  applyCustomSystemCSS,
  applyAppBackgroundImage,
} from "./utils/reader/launchUtil";
import { migrateThemeConfig } from "./utils/reader/themeUtil";
initTheme();
initSystemFont();
migrateThemeConfig();
applyCustomSystemCSS();
applyAppBackgroundImage();

// 监听打开日志窗口
if (window.require) {
  try {
    const { ipcRenderer } = window.require("electron");
    ipcRenderer.on("open-log-window", () => {
      ipcRenderer.invoke("open-log-window");
    });
  } catch (e) {}
}

const container = document.getElementById("root")!;
ReactDOM.render(
  <Provider store={store}>
    <Router />
  </Provider>,
  container
);
StyleUtil.applyTheme();
