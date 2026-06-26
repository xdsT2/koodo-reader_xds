const {
  app,
  BrowserWindow,
  WebContentsView,
  Menu,
  Tray,
  nativeImage,
  ipcMain,
  dialog,
  powerSaveBlocker,
  nativeTheme: electronNativeTheme,
  protocol,
  screen,
  systemPreferences,
} = require("electron");
const path = require("path");
const isDev = require("electron-is-dev");
const Store = require("electron-store");
const log = require("electron-log/main");
const os = require("os");
const { execFile } = require("child_process");
const store = new Store();
const fs = require("fs");
const configDir = app.getPath("userData");
const dirPath = path.join(configDir, "uploads");
const packageJson = require("./package.json");
let mainWin;
let tray = null;
let isQuitting = false;
let readerWindow;
let readerWindowList = [];
let dictWindow;
let transWindow;
let linkWindow;
let mainView;
//multi tab
// let mainViewList = []
let readerWindowReadyToClose = false;
let chatWindow;
let dbConnection = {};
let syncUtilCache = {};
let pickerUtilCache = {};
let downloadRequest = null;

const RESIZE_THROTTLE_MS = 300;

const throttle = (func, wait = RESIZE_THROTTLE_MS) => {
  let lastCall = 0;
  let timeoutId = null;
  return function (...args) {
    const now = Date.now();
    const invoke = () => {
      lastCall = Date.now();
      func.apply(this, args);
    };
    if (now - lastCall >= wait) {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      invoke();
    } else if (!timeoutId) {
      timeoutId = setTimeout(
        () => {
          timeoutId = null;
          invoke();
        },
        wait - (now - lastCall)
      );
    }
  };
};

const extractClixmlErrors = (text) => {
  if (!text) return "";
  const matches = text.match(
    /<S S="Error">([^<]*(?:<[^/][^>]*>[^<]*<\/[^>]*>)*[^<]*)<\/S>/g
  );
  if (!matches) return text;
  return matches
    .map((m) =>
      m
        .replace(/<\/?S[^>]*>/g, "")
        .replace(/<[^>]+>/g, "")
        .replace(/_x000D__x000A_/g, "\n")
        .trim()
    )
    .filter(Boolean)
    .join("\n");
};

const runPowerShellScript = (script, timeout = 30000) => {
  return new Promise((resolve, reject) => {
    const encodedCommand = Buffer.from(script, "utf16le").toString("base64");
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Sta",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encodedCommand,
      ],
      {
        windowsHide: true,
        timeout,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const rawMessage = (stderr || stdout || error.message || "").trim();
          const cleanMessage = extractClixmlErrors(rawMessage) || rawMessage;
          reject(new Error(cleanMessage));
          return;
        }
        resolve((stdout || "").trim());
      }
    );
  });
};

const getWindowHandleValue = (win) => {
  if (!win || typeof win.getNativeWindowHandle !== "function") {
    return "";
  }

  try {
    const handle = win.getNativeWindowHandle();
    if (!Buffer.isBuffer(handle) || handle.length === 0) {
      return "";
    }

    if (handle.length >= 8 && typeof handle.readBigUInt64LE === "function") {
      return handle.readBigUInt64LE(0).toString();
    }

    return handle.readUInt32LE(0).toString();
  } catch (error) {
    console.warn("Failed to resolve native window handle:", error);
    return "";
  }
};

const loadUrlInAuxWindow = async (win, url) => {
  const wc = win.webContents;
  let currentUrl = "";
  try {
    currentUrl = wc.getURL();
  } catch (_) {
    currentUrl = "";
  }
  if (currentUrl === url) {
    wc.reload();
    return;
  }
  let needBlankIntermediate = false;
  try {
    const current = new URL(currentUrl);
    const next = new URL(url);
    // When only the hash differs, Chromium treats it as a same-page hashchange
    // and won't reload the page. Navigating through about:blank forces a full reload.
    needBlankIntermediate =
      current.origin === next.origin &&
      current.pathname === next.pathname &&
      current.search === next.search;
  } catch (_) {
    // ignore invalid URLs (e.g. empty string, about:blank)
  }
  if (needBlankIntermediate) {
    await wc.loadURL("about:blank");
  }
  await wc.loadURL(url);
};

const getWindowsHelloScript = (mode, message = "", hwnd = "") => {
  const escapedMessage = message.replace(/'/g, "''");
  const escapedHwnd = String(hwnd || "").replace(/'/g, "''");
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime

function Invoke-WinRtAsync {
  param(
    [Parameter(Mandatory = $true)] $Operation,
    [Parameter(Mandatory = $true)] [Type[]] $ResultTypes
  )

  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object {
      $_.Name -eq 'AsTask' -and
      $_.IsGenericMethodDefinition -and
      $_.GetGenericArguments().Count -eq $ResultTypes.Count -and
      $_.GetParameters().Count -eq 1
    } |
    Select-Object -First 1

  if (-not $method) {
    throw 'Unable to bridge Windows Runtime async operation.'
  }

  $genericMethod = $method.MakeGenericMethod($ResultTypes)
  $task = $genericMethod.Invoke($null, @($Operation))
  return $task.GetAwaiter().GetResult()
}

function Request-WindowsHelloVerification {
  param(
    [Parameter(Mandatory = $true)] [string] $Message,
    [string] $Hwnd
  )

  $isWindowInteropSupported = [Environment]::OSVersion.Version.Build -ge 22000 -and -not [string]::IsNullOrWhiteSpace($Hwnd)

  if (-not $isWindowInteropSupported) {
    return Invoke-WinRtAsync -Operation ($verifier::RequestVerificationAsync($Message)) -ResultTypes @([Windows.Security.Credentials.UI.UserConsentVerificationResult])
  }

  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace KoodoReaderInterop
{
    [ComImport]
    [Guid("39E050C3-4E74-441A-8DC0-B81104DF949C")]
    [InterfaceType(ComInterfaceType.InterfaceIsIInspectable)]
    public interface IUserConsentVerifierInterop
    {
        [return: MarshalAs(UnmanagedType.IInspectable)]
        object RequestVerificationForWindowAsync(
            IntPtr appWindow,
            [MarshalAs(UnmanagedType.HString)] string message,
            [In] ref Guid riid);
    }

    public static class UserConsentVerifierInteropHelper
    {
        public static object RequestVerificationForWindow(object activationFactory, long hwnd, string message, Guid riid)
        {
            IntPtr ptr = IntPtr.Zero;

            try
            {
                ptr = Marshal.GetIUnknownForObject(activationFactory);
                var interop = (IUserConsentVerifierInterop)Marshal.GetTypedObjectForIUnknown(ptr, typeof(IUserConsentVerifierInterop));
                return interop.RequestVerificationForWindowAsync(new IntPtr(hwnd), message, ref riid);
            }
            finally
            {
                if (ptr != IntPtr.Zero)
                {
                    Marshal.Release(ptr);
                }
            }
        }
    }
}
"@

  $activationFactory = [System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeMarshal]::GetActivationFactory($verifier)
  $asyncOperationGuid = [Guid]::Parse('fd596ffd-2318-558f-9dbe-d21df43764a5')
  $operation = [KoodoReaderInterop.UserConsentVerifierInteropHelper]::RequestVerificationForWindow($activationFactory, [Int64]::Parse($Hwnd), $Message, $asyncOperationGuid)
  return Invoke-WinRtAsync -Operation $operation -ResultTypes @([Windows.Security.Credentials.UI.UserConsentVerificationResult])
}

$verifier = [Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]
$availability = Invoke-WinRtAsync -Operation ($verifier::CheckAvailabilityAsync()) -ResultTypes @([Windows.Security.Credentials.UI.UserConsentVerifierAvailability])

if ('${mode}' -eq 'check') {
  [Console]::Out.Write((@{
    available = ($availability.ToString() -eq 'Available')
    status = $availability.ToString()
  } | ConvertTo-Json -Compress))
  exit 0
}

if ($availability.ToString() -ne 'Available') {
  [Console]::Out.Write((@{
    success = $false
    code = 'Unavailable'
    status = $availability.ToString()
  } | ConvertTo-Json -Compress))
  exit 0
}

try {
  $result = Request-WindowsHelloVerification -Message '${escapedMessage}' -Hwnd '${escapedHwnd}'
  [Console]::Out.Write((@{
    success = ($result.ToString() -eq 'Verified')
    code = $result.ToString()
    status = $availability.ToString()
  } | ConvertTo-Json -Compress))
} catch {
  [Console]::Out.Write((@{
    success = $false
    code = 'Error'
    status = $_.Exception.Message
  } | ConvertTo-Json -Compress))
}
`.trim();
};

const getBiometricCapability = async () => {
  if (process.platform === "darwin") {
    const available =
      typeof systemPreferences.canPromptTouchID === "function" &&
      systemPreferences.canPromptTouchID();
    return {
      available,
      provider: "Touch ID",
      platform: process.platform,
      status: available ? "Available" : "Unavailable",
    };
  }

  if (process.platform === "win32") {
    try {
      const output = await runPowerShellScript(getWindowsHelloScript("check"));
      const result = output ? JSON.parse(output) : {};
      return {
        available: !!result.available,
        provider: "Windows Hello",
        platform: process.platform,
        status: result.status || "Unavailable",
      };
    } catch (error) {
      return {
        available: false,
        provider: "Windows Hello",
        platform: process.platform,
        status: "Error",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    available: false,
    provider: "Biometric",
    platform: process.platform,
    status: "Unsupported",
  };
};

const promptBiometricAuth = async (
  promptMessage = "Authenticate",
  owningWindow = null
) => {
  if (process.platform === "darwin") {
    const available =
      typeof systemPreferences.canPromptTouchID === "function" &&
      systemPreferences.canPromptTouchID();
    if (!available) {
      return {
        success: false,
        code: "Unavailable",
        provider: "Touch ID",
      };
    }

    try {
      await systemPreferences.promptTouchID(promptMessage);
      return {
        success: true,
        code: "Verified",
        provider: "Touch ID",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        code: /cancel/i.test(message) ? "Canceled" : "Failed",
        provider: "Touch ID",
      };
    }
  }

  if (process.platform === "win32") {
    try {
      const hwnd = getWindowHandleValue(owningWindow);
      const output = await runPowerShellScript(
        getWindowsHelloScript("verify", promptMessage, hwnd),
        120000
      );
      const result = output ? JSON.parse(output) : {};
      return {
        success: !!result.success,
        code:
          result.code === "Unavailable" && result.status
            ? result.status
            : result.code || "Error",
        provider: "Windows Hello",
      };
    } catch (error) {
      console.error("Biometric verification error:", error.message);
      return {
        success: false,
        code: "Error",
        provider: "Windows Hello",
      };
    }
  }

  return {
    success: false,
    code: "Unsupported",
    provider: "Biometric",
  };
};

// Discord Rich Presence setup
let discordRPCClient = null;
let discordRPCReady = false;
let discordRPCConnecting = false;
const DISCORD_CLIENT_ID = "1490863275074781305"; // Koodo Reader Discord App ID

function initDiscordRPC() {
  if (discordRPCConnecting || discordRPCReady) return Promise.resolve();
  discordRPCConnecting = true;
  return new Promise((resolve) => {
    try {
      const DiscordRPC = require("discord-rpc");
      DiscordRPC.register(DISCORD_CLIENT_ID);
      const client = new DiscordRPC.Client({ transport: "ipc" });
      client.on("ready", () => {
        console.info("Discord RPC connected");
        discordRPCClient = client;
        discordRPCReady = true;
        discordRPCConnecting = false;
        resolve();
      });
      client.login({ clientId: DISCORD_CLIENT_ID }).catch((err) => {
        console.warn("Discord RPC login failed:", err.message);
        discordRPCClient = null;
        discordRPCReady = false;
        discordRPCConnecting = false;
        resolve();
      });
    } catch (e) {
      console.warn("Discord RPC init failed:", e.message);
      discordRPCClient = null;
      discordRPCReady = false;
      discordRPCConnecting = false;
      resolve();
    }
  });
}
function destroyDiscordRPC() {
  if (discordRPCClient) {
    try {
      discordRPCClient.destroy();
    } catch (_) {}
    discordRPCClient = null;
  }
  discordRPCReady = false;
  discordRPCConnecting = false;
}
function buildProgressBar(percentage) {
  const total = 10;
  const filled = Math.round((percentage / 100) * total);
  const empty = total - filled;
  return "▓".repeat(filled) + "░".repeat(empty);
}
const singleInstance = app.requestSingleInstanceLock();
var filePath = null;
var pendingDeepLink = null;
if (process.platform != "darwin" && process.argv.length >= 2) {
  filePath = process.argv[1];
  // Check argv for a deep link URL (cold start)
  for (const arg of process.argv) {
    if (arg.startsWith("koodo-reader://")) {
      pendingDeepLink = arg;
      break;
    }
  }
}
log.transports.file.fileName = "debug.log";
log.transports.file.maxSize = 1024 * 1024; // 1MB
log.initialize();
store.set("appVersion", packageJson.version);
store.set("appPlatform", os.platform() + " " + os.release());
const mainWinDisplayScale = store.get("mainWinDisplayScale") || 1;
let options = {
  width: parseInt(store.get("mainWinWidth") || 1050) / mainWinDisplayScale,
  height: parseInt(store.get("mainWinHeight") || 660) / mainWinDisplayScale,
  x: parseInt(store.get("mainWinX")),
  y: parseInt(store.get("mainWinY")),
  backgroundColor:
    store.get("appSkin") === "night" ? "rgba(47, 52, 55, 1)" : "#fff",
  minWidth: 300,
  minHeight: 100,
  webPreferences: {
    webSecurity: false,
    nodeIntegration: true,
    contextIsolation: false,
    nativeWindowOpen: true,
    nodeIntegrationInSubFrames: false,
    allowRunningInsecureContent: false,
    enableRemoteModule: true,
    sandbox: false,
  },
};
const Database = require("better-sqlite3");
if (os.platform() === "linux") {
  options = Object.assign({}, options, {
    icon: path.join(__dirname, "./build/assets/icon.png"),
  });
}
// Single Instance Lock
if (!singleInstance) {
  app.quit();
} else {
  app.on("second-instance", (event, argv, workingDir) => {
    if (mainWin) {
      if (!mainWin.isVisible()) mainWin.show();
      mainWin.focus();
    }
    // Handle deep link passed via second-instance argv
    const deepLink = argv.find((arg) => arg.startsWith("koodo-reader://"));
    if (deepLink) {
      handleCallback(deepLink);
    }
  });
}
if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
  // Make sure the directory exists
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  fs.writeFileSync(
    path.join(dirPath, "log.json"),
    JSON.stringify({ filePath }),
    "utf-8"
  );
}
const getDBConnection = (dbName, storagePath, sqlStatement) => {
  if (!dbConnection[dbName]) {
    if (!fs.existsSync(path.join(storagePath, "config"))) {
      fs.mkdirSync(path.join(storagePath, "config"), { recursive: true });
    }
    dbConnection[dbName] = new Database(
      path.join(storagePath, "config", `${dbName}.db`),
      {}
    );
    dbConnection[dbName].pragma("journal_mode = WAL");
    dbConnection[dbName].exec(sqlStatement["createTableStatement"][dbName]);
    if (sqlStatement["migrateStatement"][dbName]) {
      let sqlList = sqlStatement["migrateStatement"][dbName];
      for (let sql of sqlList) {
        try {
          dbConnection[dbName].exec(sql);
        } catch (error) {}
      }
    }
  }
  return dbConnection[dbName];
};
const getSyncUtil = async (config, isUseCache = true) => {
  if (!isUseCache || !syncUtilCache[config.service]) {
    const { SyncUtil } = await import("./src/assets/lib/kookit-extra.min.mjs");
    syncUtilCache[config.service] = new SyncUtil(config.service, config);
  }
  return syncUtilCache[config.service];
};
const removeSyncUtil = (config) => {
  if (syncUtilCache[config.service]) {
    syncUtilCache[config.service].clearQueue();
    delete syncUtilCache[config.service];
  }
};
const getPickerUtil = async (config, isUseCache = true) => {
  if (!isUseCache || !pickerUtilCache[config.service]) {
    const { SyncUtil } = await import("./src/assets/lib/kookit-extra.min.mjs");
    pickerUtilCache[config.service] = new SyncUtil(config.service, config);
  }
  return pickerUtilCache[config.service];
};
const removePickerUtil = (config) => {
  if (pickerUtilCache[config.service]) {
    pickerUtilCache[config.service] = null;
  }
};
const getNativeThemeSource = (appSkin) => {
  if (appSkin === "night") {
    return "dark";
  }
  if (appSkin === "light") {
    return "light";
  }
  return "system";
};
const getNativeDarkColorStatus = () => {
  if (
    typeof electronNativeTheme.shouldUseDarkColorsForSystemIntegratedUI !==
    "undefined"
  ) {
    return electronNativeTheme.shouldUseDarkColorsForSystemIntegratedUI;
  }
  return electronNativeTheme.shouldUseDarkColors;
};
const applyNativeThemeSource = (appSkin) => {
  if (process.type !== "browser") {
    return false;
  }
  electronNativeTheme.themeSource = getNativeThemeSource(appSkin);
  store.set("appSkin", appSkin || "system");
  return getNativeDarkColorStatus();
};
applyNativeThemeSource(store.get("appSkin"));
// Simple encryption function
const encrypt = (text, key) => {
  let result = "";
  for (let i = 0; i < text.length; i++) {
    const charCode = text.charCodeAt(i) ^ key.charCodeAt(i % key.length);
    result += String.fromCharCode(charCode);
  }
  return Buffer.from(result).toString("base64");
};

// Simple decryption function
const decrypt = (encryptedText, key) => {
  const buff = Buffer.from(encryptedText, "base64").toString();
  let result = "";
  for (let i = 0; i < buff.length; i++) {
    const charCode = buff.charCodeAt(i) ^ key.charCodeAt(i % key.length);
    result += String.fromCharCode(charCode);
  }
  return result;
};
// Helper to check if two rectangles intersect (for partial visibility)
const rectanglesIntersect = (rect1, rect2) => {
  return !(
    rect1.x + rect1.width <= rect2.x ||
    rect1.y + rect1.height <= rect2.y ||
    rect1.x >= rect2.x + rect2.width ||
    rect1.y >= rect2.y + rect2.height
  );
};

// Check if the window is at least partially visible on any display
const isWindowPartiallyVisible = (bounds) => {
  const displays = screen.getAllDisplays();
  for (const display of displays) {
    if (rectanglesIntersect(bounds, display.workArea)) {
      return true;
    }
  }
  return false;
};
const createTray = () => {
  let iconPath = isDev
    ? path.join(__dirname, "./public/assets/icon.png")
    : path.join(__dirname, "./build/assets/icon.png");
  let trayIcon = nativeImage.createFromPath(iconPath);
  if (os.platform() === "darwin") {
    trayIcon = trayIcon.resize({ width: 16, height: 16, quality: "best" });
    trayIcon.setTemplateImage(false);
  }
  tray = new Tray(trayIcon);
  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Open Koodo Reader",
      click: () => {
        if (mainWin) {
          mainWin.show();
          mainWin.focus();
        }
      },
    },
    {
      label: "Quit",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setToolTip("Koodo Reader");
  tray.setContextMenu(contextMenu);
  tray.on("click", () => {
    if (mainWin) {
      mainWin.show();
      mainWin.focus();
    }
  });
};
const createMainWin = () => {
  const isMainWindVisible = isWindowPartiallyVisible({
    width: parseInt(store.get("mainWinWidth") || 1050) / mainWinDisplayScale,
    height: parseInt(store.get("mainWinHeight") || 660) / mainWinDisplayScale,
    x: parseInt(store.get("mainWinX")),
    y: parseInt(store.get("mainWinY")),
  });
  if (!isMainWindVisible) {
    delete options.x;
    delete options.y;
  }
  mainWin = new BrowserWindow(options);
  if (store.get("isAlwaysOnTop") === "yes") {
    mainWin.setAlwaysOnTop(true);
  }
  if (store.get("isAutoMaximizeWin") === "yes") {
    mainWin.maximize();
  }

  if (!isDev) {
    Menu.setApplicationMenu(null);
  }

  const urlLocation = isDev
    ? "http://localhost:3000"
    : `file://${path.join(__dirname, "./build/index.html")}`;
  mainWin.loadURL(urlLocation);
  // Handle deep link on cold start: wait for renderer to mount its IPC listeners
  mainWin.webContents.once("did-finish-load", () => {
    if (pendingDeepLink) {
      const link = pendingDeepLink;
      pendingDeepLink = null;
      // Give React time to register ipcRenderer listeners before dispatching
      setTimeout(() => handleCallback(link), 1500);
    }
  });
  mainWin.on("close", (event) => {
    if (!isQuitting && store.get("isMinimizeToTray") === "yes") {
      event.preventDefault();
      mainWin.hide();
      if (!tray) {
        createTray();
      }
      return;
    }
    if (mainWin && !mainWin.isDestroyed()) {
      let bounds = mainWin.getBounds();
      const currentDisplay = screen.getDisplayMatching(bounds);
      const primaryDisplay = screen.getPrimaryDisplay();
      if (bounds.width > 300 && bounds.height > 100) {
        store.set({
          mainWinWidth: bounds.width,
          mainWinHeight: bounds.height,
          mainWinX: mainWin.isMaximized() ? 0 : bounds.x,
          mainWinY: mainWin.isMaximized() ? 0 : bounds.y,
          mainWinDisplayScale:
            currentDisplay.scaleFactor / primaryDisplay.scaleFactor,
        });
      }
    }
    mainWin = null;
  });
  const syncMainViewBounds = () => {
    if (mainView) {
      if (!mainWin) return;
      let { width, height } = mainWin.getContentBounds();
      mainView.setBounds({ x: 0, y: 0, width: width, height: height });
    }
  };
  mainWin.on("resize", throttle(syncMainViewBounds));
  mainWin.on("maximize", () => {
    if (mainView) {
      let { width, height } = mainWin.getContentBounds();
      mainView.setBounds({ x: 0, y: 0, width: width, height: height });
    }
  });
  mainWin.on("unmaximize", () => {
    if (mainView) {
      let { width, height } = mainWin.getContentBounds();
      mainView.setBounds({ x: 0, y: 0, width: width, height: height });
    }
  });
  mainWin.on("focus", () => {
    if (mainView && !mainView.webContents.isDestroyed()) {
      mainView.webContents.focus();
    }
  });
  mainWin.webContents.on(
    "console-message",
    (event, level, message, line, sourceId) => {
      console.log(`[Renderer Console] Message: ${message}`);
    }
  );
  //cancel-download-app
  ipcMain.handle("cancel-download-app", (event, arg) => {
    // Implement cancellation logic here
    // Note: In this example, we are not keeping a reference to the request,
    // so we cannot actually abort it. This is a placeholder for demonstration.
    if (downloadRequest) {
      downloadRequest.abort();
      downloadRequest = null;
    }
    event.returnValue = "cancelled";
  });
  // Discord RPC handlers
  ipcMain.handle("discord-rpc-update", async (event, config) => {
    const { bookTitle, author, percentage } = config;
    if (!discordRPCReady) {
      await initDiscordRPC();
    }
    if (!discordRPCClient || !discordRPCReady) return;
    try {
      const progressBar = buildProgressBar(percentage);
      await discordRPCClient.setActivity({
        details: bookTitle,
        state: `${progressBar} ${percentage}%  |  by ${author}`,
        largeImageKey: "koodo_reader_logo",
        largeImageText: "Koodo Reader",
        startTimestamp: Date.now(),
        instance: false,
        buttons: [
          {
            label: "Get Koodo Reader",
            url: "https://koodoreader.com",
          },
        ],
      });
    } catch (e) {
      console.warn("Failed to set Discord activity:", e.message);
    }
  });
  ipcMain.handle("discord-rpc-clear", async (event) => {
    if (discordRPCClient) {
      try {
        await discordRPCClient.clearActivity();
      } catch (e) {
        console.warn("Failed to clear Discord activity:", e.message);
      }
    }
  });
  ipcMain.handle("update-win-app", (event, config) => {
    let fileName = `koodo-reader-installer.exe`;
    let supportedArchs = ["x64", "ia32", "arm64"];
    //get system arch
    let arch = os.arch();
    if (!supportedArchs.includes(arch)) {
      return;
    }

    let url = `https://dl.koodoreader.com/v${config.version}/Koodo-Reader-${config.version}-${arch}.exe`;
    const https = require("https");
    const { spawn } = require("child_process");
    const file = fs.createWriteStream(path.join(app.getPath("temp"), fileName));
    downloadRequest = https.get(url, (res) => {
      const totalSize = parseInt(res.headers["content-length"], 10);
      let downloadedSize = 0;
      res.on("data", (chunk) => {
        downloadedSize += chunk.length;
        const progress = ((downloadedSize / totalSize) * 100).toFixed(2);
        const downloadedMB = (downloadedSize / 1024 / 1024).toFixed(2);
        const totalMB = (totalSize / 1024 / 1024).toFixed(2);
        mainWin.webContents.send("download-app-progress", {
          progress,
          downloadedMB,
          totalMB,
        });
      });

      res.pipe(file);
      file.on("finish", () => {
        console.info("\n下载完成！");
        file.close();

        let updateExePath = path.join(app.getPath("temp"), fileName);
        if (!fs.existsSync(updateExePath)) {
          console.error("更新包不存在:", updateExePath);
          return;
        }
        // 验证文件可执行性
        try {
          fs.accessSync(updateExePath, fs.constants.X_OK);
          console.info("更新包可执行性验证通过");
        } catch (err) {
          console.error("更新包不可执行:", err.message);
          return;
        }
        try {
          // 先退出应用，再启动安装程序，避免文件锁定导致覆盖安装失败
          app.once("will-quit", () => {
            const child = spawn(updateExePath, [], {
              stdio: "ignore",
              detached: true,
              shell: true,
              windowsHide: false,
            });
            child.unref();
          });
          app.quit();
        } catch (err) {
          console.error(`spawn 执行异常: ${err.message}`);
        }
      });
    });
  });
  ipcMain.handle("open-book", (event, config) => {
    let { url, isMergeWord, isAutoFullscreen, isAutoMaximize, isPreventSleep } =
      config;
    if (isMergeWord) {
      delete options.backgroundColor;
    }
    store.set({
      url,
      isMergeWord: isMergeWord || "no",
      isAutoFullscreen: isAutoFullscreen || "no",
      isAutoMaximize: isAutoMaximize || "no",
      isPreventSleep: isPreventSleep || "no",
    });
    let id;
    if (isPreventSleep === "yes") {
      id = powerSaveBlocker.start("prevent-display-sleep");
      console.info(powerSaveBlocker.isStarted(id));
    }
    if (readerWindow) {
      readerWindowList.push(readerWindow);
    }
    if (isAutoFullscreen === "yes" || isAutoMaximize === "yes") {
      readerWindow = new BrowserWindow(options);
      readerWindow.loadURL(url);
      if (isAutoFullscreen === "yes") {
        readerWindow.setFullScreen(true);
      } else if (isAutoMaximize === "yes") {
        readerWindow.maximize();
      }
    } else {
      const scaleRatio = store.get("windowDisplayScale") || 1;
      const isWindowVisible = isWindowPartiallyVisible({
        x: parseInt(store.get("windowX")),
        y: parseInt(store.get("windowY")),
        width: parseInt(store.get("windowWidth") || 1050) / scaleRatio,
        height: parseInt(store.get("windowHeight") || 660) / scaleRatio,
      });
      readerWindow = new BrowserWindow({
        ...options,
        width: parseInt(store.get("windowWidth") || 1050) / scaleRatio,
        height: parseInt(store.get("windowHeight") || 660) / scaleRatio,
        x: isWindowVisible ? parseInt(store.get("windowX")) : undefined,
        y: isWindowVisible ? parseInt(store.get("windowY")) : undefined,
        frame: isMergeWord === "yes" ? false : true,
        hasShadow: isMergeWord === "yes" ? false : true,
        transparent: isMergeWord === "yes" ? true : false,
      });
      readerWindow.loadURL(url);
      // readerWindow.webContents.openDevTools();
    }
    if (store.get("isAlwaysOnTop") === "yes") {
      readerWindow.setAlwaysOnTop(true);
    }
    readerWindowReadyToClose = false;
    readerWindow.on("close", (event) => {
      // --- Step 1: ask renderer to flush reading-time data first ---
      if (
        !readerWindowReadyToClose &&
        readerWindow &&
        !readerWindow.isDestroyed()
      ) {
        event.preventDefault();
        readerWindow.webContents.send("before-reader-close");
        return;
      }
      // --- Step 2: actual close logic (reached after renderer replied) ---
      if (readerWindow && !readerWindow.isDestroyed()) {
        let bounds = readerWindow.getBounds();
        const currentDisplay = screen.getDisplayMatching(bounds);
        const primaryDisplay = screen.getPrimaryDisplay();
        if (bounds.width > 300 && bounds.height > 100) {
          store.set({
            windowWidth: bounds.width,
            windowHeight: bounds.height,
            windowX:
              readerWindow.isMaximized() &&
              currentDisplay.id === primaryDisplay.id
                ? 0
                : bounds.x,
            windowY:
              readerWindow.isMaximized() &&
              currentDisplay.id === primaryDisplay.id
                ? 0
                : bounds.y < 0
                  ? 0
                  : bounds.y,
            windowDisplayScale:
              currentDisplay.scaleFactor / primaryDisplay.scaleFactor,
          });
        }
      }
      if (isPreventSleep && !readerWindow.isDestroyed()) {
        id && powerSaveBlocker.stop(id);
      }
      if (mainWin && !mainWin.isDestroyed()) {
        mainWin.webContents.send("reading-finished", {});
      }
      if (discordRPCClient) {
        try {
          discordRPCClient.clearActivity();
        } catch (e) {
          console.warn("Failed to clear Discord activity:", e.message);
        }
      }
    });
    // Renderer finished flushing reading-time data — proceed with actual close
    ipcMain.once("reader-close-ready", () => {
      if (readerWindow && !readerWindow.isDestroyed()) {
        readerWindowReadyToClose = true;
        readerWindow.close();
      }
    });

    event.returnValue = "success";
  });
  ipcMain.handle("generate-tts", async (event, voiceConfig) => {
    let { text, speed, plugin, config } = voiceConfig;
    // 豆包 TTS 引擎（本地 Python WebSocket 服务）
    if (plugin && plugin.key === "doubao_tts_voice") {
      try {
        const net = require("net");

        // 从 plugin.voiceList 查找完整音色名（兼容短名 vs 全名不一致的情况）
        let voiceName = config?.voiceName || "zh_female_xiaohe_uranus_bigtts";
        const matchedVoice = (plugin.voiceList || []).find(
          (v) => v.name === voiceName
        );
        if (matchedVoice) {
          // 用 voiceList 中的 config.speaker 或 name（全名）
          voiceName = matchedVoice.config?.speaker || matchedVoice.name;
        } else {
          // 查不到就尝试补齐 _uranus_bigtts 后缀
          const fullSuffix = "_uranus_bigtts";
          if (!voiceName.endsWith(fullSuffix)) {
            // 先试补全后能否在 voiceList 中找到
            const fullName = voiceName + fullSuffix;
            const fallbackVoice = (plugin.voiceList || []).find(
              (v) => v.name === fullName
            );
            if (fallbackVoice) {
              voiceName = fallbackVoice.config?.speaker || fullName;
            }
          }
        }
        ttsLog("[DoubaoTTS] generate: text.len=" + (text?.length || 0) + ", voice=" + voiceName + ", speed=" + speed);

        // 前端传入的 speed 已做 speed*100-100 转换：
        //   voiceSpeed=1.0 → speed=0, voiceSpeed=2.0 → speed=100, voiceSpeed=0.5 → speed=-50
        // 豆包双向流式 API 的 speech_rate 取值范围 [-50, 100]，含义完全一致：
        //   100 → 2.0x, -50 → 0.5x, 0 → 1.0x
        // 所以直接用，只需 clamp 到 API 允许范围
        let speechRate = Number(speed) || 0;
        if (isNaN(speechRate)) speechRate = 0;
        speechRate = Math.min(Math.max(speechRate, -50), 100);

        // 自动启动 Python TTS 服务（首次调用或服务挂掉时）
        if (!doubaoTTSProcess) {
          ttsLog("[DoubaoTTS] Python 服务未运行，自动启动...");
          const serverInfo = resolveDoubaoServer();
          if (!serverInfo) {
            ttsLog("[DoubaoTTS] 找不到 doubao_tts_server.exe 或 .py，请检查 test/doubao-tts-test/");
            return null;
          }
          ttsLog("[DoubaoTTS] cmd: " + serverInfo.cmd + " args: " + JSON.stringify(serverInfo.args));
          const { spawn } = require("child_process");
          try {
            doubaoTTSProcess = spawn(
              serverInfo.cmd,
              [...serverInfo.args, "--port", String(TTS_PORT)],
              {
                stdio: ["ignore", "pipe", "pipe"],
                cwd: serverInfo.cwd,
                env: { ...process.env, PYTHONIOENCODING: "utf-8" },
              }
            );
            doubaoTTSProcess.stdout.on("data", (d) => {
              const s = d.toString().trim();
              ttsLog("[DoubaoTTS][py] " + s);
              log.info("[DoubaoTTS] " + s);
            });
            doubaoTTSProcess.stderr.on("data", (d) => {
              const s = d.toString().trim();
              ttsLog("[DoubaoTTS][py-err] " + s);
              log.warn("[DoubaoTTS] " + s);
            });
            doubaoTTSProcess.on("exit", (code) => {
              ttsLog("[DoubaoTTS] Python 服务退出, code=" + code);
              doubaoTTSProcess = null;
            });
          } catch (spawnErr) {
            ttsLog("[DoubaoTTS] spawn 失败: " + (spawnErr.message || spawnErr));
            return null;
          }
          // 等待端口就绪（最多 8 秒）
          let ready = false;
          for (let i = 0; i < 40; i++) {
            await new Promise((r) => setTimeout(r, 200));
            ready = await new Promise((resolve) => {
              const probe = net.createConnection({ port: TTS_PORT, host: "127.0.0.1" }, () => {
                probe.end();
                resolve(true);
              });
              probe.on("error", () => resolve(false));
            });
            if (ready) break;
          }
          if (!ready) {
            ttsLog("[DoubaoTTS] Python 服务启动超时（8s）");
            return null;
          }
          ttsLog("[DoubaoTTS] Python 服务就绪");
        }

        // 调用本地 TCP 服务合成
        const wavPath = await new Promise((resolve, reject) => {
          const client = net.createConnection({ port: TTS_PORT, host: "127.0.0.1" }, () => {
            client.write(JSON.stringify({ text, voice: voiceName, format: "pcm", sample_rate: 24000, speech_rate: speechRate }));
          });
          let data = "";
          client.on("data", (chunk) => { data += chunk.toString(); });
          client.on("end", () => {
            try {
              const resp = JSON.parse(data);
              if (resp.success) {
                const audioBuf = Buffer.from(resp.audio, "base64");
                const ttsDir = path.join(dirPath, "tts");
                if (!fs.existsSync(ttsDir)) fs.mkdirSync(ttsDir, { recursive: true });
                const fileName = `doubao_${Date.now()}.wav`;
                const filePath = path.join(ttsDir, fileName);
                const sampleRate = resp.sample_rate || 24000;
                const wavHeader = Buffer.alloc(44);
                const dataSize = audioBuf.length;
                wavHeader.write("RIFF", 0);
                wavHeader.writeUInt32LE(dataSize + 36, 4);
                wavHeader.write("WAVE", 8);
                wavHeader.write("fmt ", 12);
                wavHeader.writeUInt32LE(16, 16);
                wavHeader.writeUInt16LE(1, 20);
                wavHeader.writeUInt16LE(1, 22);
                wavHeader.writeUInt32LE(sampleRate, 24);
                wavHeader.writeUInt32LE(sampleRate * 2, 28);
                wavHeader.writeUInt16LE(2, 32);
                wavHeader.writeUInt16LE(16, 34);
                wavHeader.write("data", 36);
                wavHeader.writeUInt32LE(dataSize, 40);
                fs.writeFileSync(filePath, Buffer.concat([wavHeader, audioBuf]));
                ttsLog("[DoubaoTTS] 合成成功: " + filePath + " (" + dataSize + " bytes pcm)");
                resolve(filePath);
              } else {
                ttsLog("[DoubaoTTS] 合成失败: " + (resp.error || "unknown"));
                reject(new Error(resp.error || "TTS synthesis failed"));
              }
            } catch (e) {
              ttsLog("[DoubaoTTS] 响应解析失败: " + (e.message || e));
              reject(e);
            }
          });
          client.on("error", (e) => {
            ttsLog("[DoubaoTTS] TCP 错误: " + (e.message || e));
            reject(e);
          });
          client.setTimeout(60000, () => {
            client.destroy();
            ttsLog("[DoubaoTTS] 合成超时（60s）");
            reject(new Error("timeout"));
          });
        });
        return wavPath;
      } catch (e) {
        ttsLog("[DoubaoTTS] generate 异常: " + (e.message || e));
        console.error("[DoubaoTTS] generate error:", e);
        return null;
      }
    }
    let voiceFunc = plugin.script;
    // eslint-disable-next-line no-eval
    eval(voiceFunc);
    return global.getAudioPath(text, speed, dirPath, config);
  });
  ipcMain.handle("cloud-upload", async (event, config) => {
    let syncUtil = await getSyncUtil(config, config.isUseCache);
    let result = await syncUtil.uploadFile(
      config.fileName,
      config.fileName,
      config.type
    );
    return result;
  });

  ipcMain.handle("cloud-download", async (event, config) => {
    let syncUtil = await getSyncUtil(config);
    let result = await syncUtil.downloadFile(
      config.fileName,
      (config.isTemp ? "temp-" : "") + config.fileName,
      config.type
    );
    return result;
  });
  ipcMain.handle("cloud-progress", async (event, config) => {
    let syncUtil = await getSyncUtil(config);
    let result = syncUtil.getDownloadedSize();
    return result;
  });
  ipcMain.handle("picker-download", async (event, config) => {
    let pickerUtil = await getPickerUtil(config);
    let result = await pickerUtil.remote.downloadFile(
      config.sourcePath,
      config.destPath
    );
    return result;
  });
  ipcMain.handle("picker-progress", async (event, config) => {
    let pickerUtil = await getPickerUtil(config);
    let result = await pickerUtil.getDownloadedSize();
    return result;
  });
  ipcMain.handle("cloud-reset", async (event, config) => {
    let syncUtil = await getSyncUtil(config);
    let result = syncUtil.resetCounters();
    return result;
  });
  ipcMain.handle("cloud-stats", async (event, config) => {
    let syncUtil = await getSyncUtil(config);
    let result = syncUtil.getStats();
    return result;
  });
  ipcMain.handle("cloud-delete", async (event, config) => {
    try {
      let syncUtil = await getSyncUtil(config, config.isUseCache);
      let result = await syncUtil.deleteFile(config.fileName, config.type);
      return result;
    } catch (error) {
      console.error("Error deleting file:", error);
    }
    return false;
  });

  ipcMain.handle("cloud-list", async (event, config) => {
    let syncUtil = await getSyncUtil(config);
    let result = await syncUtil.listFiles(config.type);
    return result;
  });
  ipcMain.handle("picker-list", async (event, config) => {
    let pickerUtil = await getPickerUtil(config);
    let result = await pickerUtil.listFileInfos(config.currentPath);
    return result;
  });
  ipcMain.handle("cloud-exist", async (event, config) => {
    let syncUtil = await getSyncUtil(config);
    let result = await syncUtil.isExist(config.fileName, config.type);
    return result;
  });
  ipcMain.handle("cloud-close", async (event, config) => {
    removeSyncUtil(config);
    return "pong";
  });

  ipcMain.handle("clear-tts", async (event, config) => {
    if (!fs.existsSync(path.join(dirPath, "tts"))) {
      return "pong";
    } else {
      const fsExtra = require("fs-extra");
      try {
        await fsExtra.remove(path.join(dirPath, "tts"));
        await fsExtra.mkdir(path.join(dirPath, "tts"));
        return "pong";
      } catch (err) {
        console.error(err);
        return "pong";
      }
    }
  });

  // ── 豆包 TTS 服务 ──────────────────────────────────────────
  let doubaoTTSProcess = null;
  const TTS_PORT = 18765;

  ipcMain.handle("doubao-tts-start", async () => {
    if (doubaoTTSProcess) return { ok: true, msg: "already running" };
    const serverInfo = resolveDoubaoServer();
    if (!serverInfo) return { ok: false, error: "找不到 doubao_tts_server" };
    try {
      const { spawn } = require("child_process");
      doubaoTTSProcess = spawn(
        serverInfo.cmd,
        [...serverInfo.args, "--port", String(TTS_PORT)],
        {
          stdio: ["ignore", "pipe", "pipe"],
          cwd: serverInfo.cwd,
          env: { ...process.env, PYTHONIOENCODING: "utf-8" },
        }
      );
      doubaoTTSProcess.stdout.on("data", (d) => log.info("[DoubaoTTS]" + d.toString().trim()));
      doubaoTTSProcess.stderr.on("data", (d) => log.warn("[DoubaoTTS]" + d.toString().trim()));
      doubaoTTSProcess.on("exit", () => { doubaoTTSProcess = null; });
      // 等服务就绪
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle("doubao-tts-stop", async () => {
    if (doubaoTTSProcess) {
      doubaoTTSProcess.kill();
      doubaoTTSProcess = null;
    }
    return { ok: true };
  });

  ipcMain.handle("doubao-tts-synthesize", async (event, config) => {
    const net = require("net");
    const { text, voice, format, sampleRate } = config;
    return new Promise((resolve, reject) => {
      const client = net.createConnection({ port: TTS_PORT, host: "127.0.0.1" }, () => {
        const req = JSON.stringify({
          text: text || "",
          voice: voice || "zh_female_xiaohe_uranus_bigtts",
          format: format || "pcm",
          sample_rate: sampleRate || 24000,
        });
        client.write(req);
      });
      let data = "";
      client.on("data", (chunk) => { data += chunk.toString(); });
      client.on("end", () => {
        try {
          const resp = JSON.parse(data);
          if (resp.success) {
            const audioBuf = Buffer.from(resp.audio, "base64");
            // 保存为 wav
            const ttsDir = path.join(dirPath, "tts");
            if (!fs.existsSync(ttsDir)) fs.mkdirSync(ttsDir, { recursive: true });
            const fileName = `doubao_${Date.now()}.wav`;
            const filePath = path.join(ttsDir, fileName);
            // PCM → WAV
            const wavHeader = Buffer.alloc(44);
            const dataSize = audioBuf.length;
            const fileSize = dataSize + 36;
            wavHeader.write("RIFF", 0);
            wavHeader.writeUInt32LE(fileSize, 4);
            wavHeader.write("WAVE", 8);
            wavHeader.write("fmt ", 12);
            wavHeader.writeUInt32LE(16, 16);
            wavHeader.writeUInt16LE(1, 20);
            wavHeader.writeUInt16LE(1, 22);
            wavHeader.writeUInt32LE(resp.sample_rate || 24000, 24);
            wavHeader.writeUInt32LE(resp.sample_rate * 2, 28);
            wavHeader.writeUInt16LE(2, 32);
            wavHeader.writeUInt16LE(16, 34);
            wavHeader.write("data", 36);
            wavHeader.writeUInt32LE(dataSize, 40);
            fs.writeFileSync(filePath, Buffer.concat([wavHeader, audioBuf]));
            resolve(filePath);
          } else {
            reject(new Error(resp.error || "TTS synthesis failed"));
          }
        } catch (e) {
          reject(e);
        }
      });
      client.on("error", reject);
      client.setTimeout(60000, () => { client.destroy(); reject(new Error("timeout")); });
    });
  });
  // ── 豆包 TTS 结束 ──────────────────────────────────────────
  ipcMain.handle("select-path", async (event) => {
    var path = await dialog.showOpenDialog({
      properties: ["openDirectory"],
    });
    return path.filePaths[0];
  });
  ipcMain.handle("select-file", async (event, config) => {
    const dialogOptions = { properties: ["openFile"] };
    if (config && config.filters) {
      dialogOptions.filters = config.filters;
    }
    var result = await dialog.showOpenDialog(dialogOptions);
    return result.filePaths[0];
  });
  ipcMain.handle("encrypt-data", async (event, config) => {
    const { TokenService } =
      await import("./src/assets/lib/kookit-extra.min.mjs");
    let fingerprint = await TokenService.getFingerprint();
    let encrypted = encrypt(config.token, fingerprint);
    store.set("encryptedToken", encrypted);
    return "pong";
  });
  ipcMain.handle("decrypt-data", async (event) => {
    let encrypted = store.get("encryptedToken");
    if (!encrypted) return "";
    const { TokenService } =
      await import("./src/assets/lib/kookit-extra.min.mjs");
    let fingerprint = await TokenService.getFingerprint();
    let decrypted = decrypt(encrypted, fingerprint);
    if (decrypted.startsWith("{") && decrypted.endsWith("}")) {
      return decrypted;
    } else {
      try {
        const { safeStorage } = require("electron");
        decrypted = safeStorage.decryptString(Buffer.from(encrypted, "base64"));
        let newEncrypted = encrypt(decrypted, fingerprint);
        store.set("encryptedToken", newEncrypted);
        return decrypted;
      } catch (error) {
        console.error("Decryption failed:", error);
        return "{}";
      }
    }
  });
  ipcMain.handle("check-cloud-url", async (event, config) => {
    const https = require("https");
    const http = require("http");
    const { URL } = require("url");
    const { url } = config;
    return new Promise((resolve) => {
      let parsedUrl;
      try {
        parsedUrl = new URL(url);
      } catch (e) {
        return resolve({ ok: false, reason: "invalid_url", detail: e.message });
      }
      const isHttps = parsedUrl.protocol === "https:";
      const lib = isHttps ? https : http;
      const port = parsedUrl.port
        ? parseInt(parsedUrl.port)
        : isHttps
          ? 443
          : 80;
      const options = {
        hostname: parsedUrl.hostname,
        port,
        path: parsedUrl.pathname || "/",
        method: "HEAD",
        timeout: 8000,
        rejectUnauthorized: true,
      };
      const req = lib.request(options, (res) => {
        resolve({
          ok: true,
          status: res.statusCode,
          detail: `HTTP ${res.statusCode}`,
        });
      });
      req.on("timeout", () => {
        req.destroy();
        resolve({
          ok: false,
          reason: "timeout",
          detail: `Connection to ${parsedUrl.hostname}:${port} timed out after 8s`,
        });
      });
      req.on("error", (err) => {
        let reason = "unknown";
        if (err.code === "ENOTFOUND") {
          reason = "dns_failed";
        } else if (err.code === "ECONNREFUSED") {
          reason = "connection_refused";
        } else if (err.code === "ECONNRESET") {
          reason = "connection_reset";
        } else if (err.code === "ETIMEDOUT") {
          reason = "timeout";
        } else if (
          err.code === "CERT_HAS_EXPIRED" ||
          err.code === "ERR_TLS_CERT_ALTNAME_INVALID" ||
          err.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
        ) {
          reason = "ssl_error";
        } else if (err.message && err.message.includes("SSL")) {
          reason = "ssl_error";
        }
        resolve({
          ok: false,
          reason,
          code: err.code || "",
          detail: err.message,
        });
      });
      req.end();
    });
  });
  ipcMain.handle("get-mac", async (event, config) => {
    const { machineIdSync } = require("node-machine-id");
    return machineIdSync();
  });
  ipcMain.handle("get-device-name", async () => {
    return os.hostname() || "";
  });
  ipcMain.handle("get-store-value", async (event, config) => {
    return store.get(config.key);
  });
  ipcMain.handle("get-biometric-capability", async () => {
    return await getBiometricCapability();
  });
  ipcMain.handle("prompt-biometric-auth", async (event, config) => {
    const senderWindow =
      BrowserWindow.fromWebContents(event.sender) ||
      BrowserWindow.getFocusedWindow() ||
      mainWin ||
      null;
    return await promptBiometricAuth(config?.message, senderWindow);
  });

  ipcMain.handle("reset-reader-position", async (event) => {
    store.delete("windowX");
    store.delete("windowY");
    return "success";
  });
  ipcMain.handle("reset-main-position", async (event) => {
    store.delete("mainWinX");
    store.delete("mainWinY");
    app.relaunch();
    app.exit();
    return "success";
  });

  ipcMain.handle("select-zip-file", async (event, config) => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "Zip Files", extensions: ["zip"] }],
    });

    if (result.canceled) {
      return "";
    } else {
      const filePath = result.filePaths[0];
      return filePath;
    }
  });

  ipcMain.handle("select-book", async (event, config) => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "Books",
          extensions: [
            "epub",
            "pdf",
            "txt",
            "mobi",
            "azw3",
            "azw",
            "htm",
            "html",
            "xml",
            "xhtml",
            "mhtml",
            "docx",
            "md",
            "fb2",
            "cbz",
            "cbt",
            "cbr",
            "cb7",
          ],
        },
      ],
    });

    if (result.canceled) {
      console.info("User canceled the file selection");
      return [];
    } else {
      const filePaths = result.filePaths;
      console.info("Selected file path:", filePaths);
      return filePaths;
    }
  });
  ipcMain.handle("custom-database-command", async (event, config) => {
    const { SqlStatement } =
      await import("./src/assets/lib/kookit-extra.min.mjs");
    let { query, storagePath, data, dbName, executeType } = config;
    let db = getDBConnection(dbName, storagePath, SqlStatement.sqlStatement);
    const row = db.prepare(query);
    let result;
    if (data && data.length > 0) {
      result = row[executeType](...data);
    } else {
      result = row[executeType]();
    }
    return result;
  });
  ipcMain.handle("database-command", async (event, config) => {
    const { SqlStatement } =
      await import("./src/assets/lib/kookit-extra.min.mjs");
    let { statement, statementType, executeType, dbName, data, storagePath } =
      config;
    let db = getDBConnection(dbName, storagePath, SqlStatement.sqlStatement);
    let sql = "";
    if (statementType === "string") {
      sql = SqlStatement.sqlStatement[statement][dbName];
    } else if (statementType === "function") {
      sql = SqlStatement.sqlStatement[statement][dbName](data);
    }
    const row = db.prepare(sql);
    let result;
    if (data) {
      if (statement.startsWith("save") || statement.startsWith("update")) {
        data = SqlStatement.jsonToSqlite[dbName](data);
      }
      result = row[executeType](data);
    } else {
      result = row[executeType]();
    }
    if (executeType === "all") {
      return result.map((item) => SqlStatement.sqliteToJson[dbName](item));
    } else if (executeType === "get") {
      return SqlStatement.sqliteToJson[dbName](result);
    } else {
      return result;
    }
  });
  ipcMain.handle("close-database", async (event, config) => {
    const { SqlStatement } =
      await import("./src/assets/lib/kookit-extra.min.mjs");
    let { dbName, storagePath } = config;
    let db = getDBConnection(dbName, storagePath, SqlStatement.sqlStatement);
    delete dbConnection[dbName];
    db.close();
  });
  ipcMain.handle("set-always-on-top", async (event, config) => {
    store.set("isAlwaysOnTop", config.isAlwaysOnTop);
    if (mainWin && !mainWin.isDestroyed()) {
      if (config.isAlwaysOnTop === "yes") {
        mainWin.setAlwaysOnTop(true);
      } else {
        mainWin.setAlwaysOnTop(false);
      }
    }
    if (readerWindow && !readerWindow.isDestroyed()) {
      if (config.isAlwaysOnTop === "yes") {
        readerWindow.setAlwaysOnTop(true);
      } else {
        readerWindow.setAlwaysOnTop(false);
      }
    }
    return "pong";
  });
  ipcMain.handle("set-auto-maximize", async (event, config) => {
    store.set("isAutoMaximizeWin", config.isAutoMaximizeWin);
    if (mainWin && !mainWin.isDestroyed()) {
      if (config.isAutoMaximizeWin === "yes") {
        mainWin.maximize();
      } else {
        mainWin.unmaximize();
      }
    }
    if (readerWindow && !readerWindow.isDestroyed()) {
      if (config.isAlwaysOnTop === "yes") {
        readerWindow.setAlwaysOnTop(true);
      } else {
        readerWindow.setAlwaysOnTop(false);
      }
    }
    return "pong";
  });
  ipcMain.handle("toggle-auto-launch", async (event, config) => {
    app.setLoginItemSettings({
      openAtLogin: config.isAutoLaunch === "yes",
    });
    return "pong";
  });
  ipcMain.handle("toggle-minimize-to-tray", async (event, config) => {
    store.set("isMinimizeToTray", config.isMinimizeToTray);
    if (config.isMinimizeToTray === "no" && tray) {
      tray.destroy();
      tray = null;
    }
    return "pong";
  });
  ipcMain.handle("open-explorer-folder", async (event, config) => {
    const { shell } = require("electron");
    if (config.isFolder) {
      shell.openPath(config.path);
    } else {
      shell.showItemInFolder(config.path);
    }

    return "pong";
  });
  ipcMain.handle("get-debug-logs", async (event, config) => {
    const { shell } = require("electron");
    const file = log.transports.file.getFile();
    shell.showItemInFolder(file.path);
    return "pong";
  });

  ipcMain.on("user-data", (event, arg) => {
    event.returnValue = dirPath;
  });
  ipcMain.handle("hide-reader", (event, arg) => {
    if (
      readerWindow &&
      !readerWindow.isDestroyed() &&
      readerWindow.isFocused()
    ) {
      readerWindow.minimize();
      event.returnvalue = true;
    } else if (mainWin && mainWin.isFocused()) {
      mainWin.minimize();
      event.returnvalue = true;
    } else {
      event.returnvalue = false;
    }
  });
  ipcMain.handle("open-console", (event, arg) => {
    mainWin.webContents.openDevTools();
    event.returnvalue = true;
  });
  ipcMain.handle("reload-reader", (event, arg) => {
    if (readerWindowList.length > 0) {
      readerWindowList.forEach((win) => {
        if (
          win &&
          !win.isDestroyed() &&
          win.webContents.getURL().indexOf(arg.bookKey) > -1
        ) {
          win.reload();
        }
      });
    }
    if (
      readerWindow &&
      !readerWindow.isDestroyed() &&
      readerWindow.webContents.getURL().indexOf(arg.bookKey) > -1
    ) {
      readerWindow.reload();
    }
  });
  ipcMain.handle("reload-main", (event, arg) => {
    if (mainWin) {
      mainWin.reload();
    }
  });

  ipcMain.handle("new-chat", (event, config) => {
    if (!chatWindow && mainWin) {
      let bounds = mainWin.getBounds();
      chatWindow = new BrowserWindow({
        ...options,
        width: 450,
        height: bounds.height,
        x: bounds.x + (bounds.width - 450),
        y: bounds.y,
        frame: true,
        hasShadow: true,
        transparent: false,
      });
      chatWindow.loadURL(config.url);
      chatWindow.on("close", (event) => {
        chatWindow && chatWindow.destroy();
        chatWindow = null;
      });
    } else if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.show();
      chatWindow.focus();
    }
  });
  ipcMain.handle("clear-all-data", (event, config) => {
    store.clear();
  });
  ipcMain.handle("new-tab", (event, config) => {
    if (mainWin) {
      mainView = new WebContentsView(options);
      mainWin.contentView.addChildView(mainView);
      let { width, height } = mainWin.getContentBounds();
      mainView.setBounds({ x: 0, y: 0, width: width, height: height });
      mainView.webContents.loadURL(config.url);
    }
  });
  ipcMain.handle("reload-tab", (event, config) => {
    if (mainWin && mainView) {
      mainView.webContents.reload();
    }
  });
  ipcMain.handle("adjust-tab-size", (event, config) => {
    if (mainWin && mainView) {
      let { width, height } = mainWin.getContentBounds();
      mainView.setBounds({ x: 0, y: 0, width: width, height: height });
    }
  });
  ipcMain.handle("exit-tab", (event, message) => {
    return new Promise((resolve) => {
      const doRemoveTab = () => {
        if (mainWin && mainView) {
          mainWin.contentView.removeChildView(mainView);
        }
        if (discordRPCClient) {
          try {
            discordRPCClient.clearActivity();
          } catch (e) {
            console.warn("Failed to clear Discord activity:", e.message);
          }
        }
        resolve(undefined);
      };

      // Ask the tab renderer to flush reading-time data first, then close
      if (mainView && !mainView.webContents.isDestroyed()) {
        const timeoutId = setTimeout(() => {
          // Fallback: if renderer doesn't reply within 3s, close anyway
          ipcMain.removeListener("tab-close-ready", onTabCloseReady);
          doRemoveTab();
        }, 3000);
        const onTabCloseReady = () => {
          clearTimeout(timeoutId);
          doRemoveTab();
        };
        ipcMain.once("tab-close-ready", onTabCloseReady);
        mainView.webContents.send("before-tab-close");
      } else {
        doRemoveTab();
      }
    });
  });
  ipcMain.handle("enter-tab-fullscreen", () => {
    if (mainWin && mainView) {
      mainWin.setFullScreen(true);
      console.info("enter full");
    }
  });
  ipcMain.handle("exit-tab-fullscreen", () => {
    if (mainWin && mainView) {
      mainWin.setFullScreen(false);
      console.info("exit full");
    }
  });
  ipcMain.handle("enter-fullscreen", () => {
    if (readerWindow) {
      readerWindow.setFullScreen(true);
      console.info("enter full");
    }
  });
  ipcMain.handle("exit-fullscreen", () => {
    if (readerWindow && !readerWindow.isDestroyed()) {
      readerWindow.setFullScreen(false);
      console.info("exit full");
    }
  });
  ipcMain.handle("open-url", async (event, config) => {
    if (config.type === "dict") {
      if (!dictWindow || dictWindow.isDestroyed()) {
        dictWindow = new BrowserWindow();
      }
      dictWindow.focus();
      await loadUrlInAuxWindow(dictWindow, config.url);
    } else if (config.type === "trans") {
      if (!transWindow || transWindow.isDestroyed()) {
        transWindow = new BrowserWindow();
      }
      transWindow.focus();
      await loadUrlInAuxWindow(transWindow, config.url);
    } else {
      if (!linkWindow || linkWindow.isDestroyed()) {
        linkWindow = new BrowserWindow();
      }
      linkWindow.loadURL(config.url);
      linkWindow.focus();
    }

    event.returnvalue = true;
  });
  ipcMain.handle("switch-moyu", (event, arg) => {
    let id;
    if (store.get("isPreventSleep") === "yes") {
      id = powerSaveBlocker.start("prevent-display-sleep");
      console.info(powerSaveBlocker.isStarted(id));
    }
    if (readerWindow && !readerWindow.isDestroyed()) {
      readerWindowReadyToClose = true;
      readerWindow.close();
      if (store.get("isMergeWord") === "yes") {
        delete options.backgroundColor;
      }
      const scaleRatio = store.get("windowDisplayScale") || 1;
      Object.assign(options, {
        width: parseInt(store.get("windowWidth") || 1050) / scaleRatio,
        height: parseInt(store.get("windowHeight") || 660) / scaleRatio,
        x: parseInt(store.get("windowX")),
        y: parseInt(store.get("windowY")),
        frame: store.get("isMergeWord") !== "yes" ? false : true,
        hasShadow: store.get("isMergeWord") !== "yes" ? false : true,
        transparent: store.get("isMergeWord") !== "yes" ? true : false,
      });

      store.set(
        "isMergeWord",
        store.get("isMergeWord") !== "yes" ? "yes" : "no"
      );
      if (readerWindow) {
        readerWindowList.push(readerWindow);
      }
      readerWindow = new BrowserWindow(options);
      if (store.get("isAlwaysOnTop") === "yes") {
        readerWindow.setAlwaysOnTop(true);
      }

      readerWindow.loadURL(store.get("url"));
      readerWindowReadyToClose = false;
      readerWindow.on("close", (event) => {
        // --- Step 1: ask renderer to flush reading-time data first ---
        if (
          !readerWindowReadyToClose &&
          readerWindow &&
          !readerWindow.isDestroyed()
        ) {
          event.preventDefault();
          readerWindow.webContents.send("before-reader-close");
          return;
        }
        // --- Step 2: actual close logic (reached after renderer replied) ---
        if (!readerWindow.isDestroyed()) {
          let bounds = readerWindow.getBounds();
          const currentDisplay = screen.getDisplayMatching(bounds);
          const primaryDisplay = screen.getPrimaryDisplay();
          if (bounds.width > 300 && bounds.height > 100) {
            store.set({
              windowWidth: bounds.width,
              windowHeight: bounds.height,
              windowX:
                readerWindow.isMaximized() &&
                currentDisplay.id === primaryDisplay.id
                  ? 0
                  : bounds.x,
              windowY:
                readerWindow.isMaximized() &&
                currentDisplay.id === primaryDisplay.id
                  ? 0
                  : bounds.y < 0
                    ? 0
                    : bounds.y,
            });
          }
        }
        if (store.get("isPreventSleep") && !readerWindow.isDestroyed()) {
          id && powerSaveBlocker.stop(id);
        }
        if (mainWin && !mainWin.isDestroyed()) {
          mainWin.webContents.send("reading-finished", {});
        }
        if (discordRPCClient) {
          try {
            discordRPCClient.clearActivity();
          } catch (e) {
            console.warn("Failed to clear Discord activity:", e.message);
          }
        }
      });
      // Renderer finished flushing reading-time data — proceed with actual close
      ipcMain.once("reader-close-ready", () => {
        if (readerWindow && !readerWindow.isDestroyed()) {
          readerWindowReadyToClose = true;
          readerWindow.close();
        }
      });
    }
    event.returnvalue = false;
  });
  ipcMain.on("storage-location", (event, config) => {
    event.returnValue = path.join(dirPath, "data");
  });
  ipcMain.on("url-window-status", (event, config) => {
    if (config.type === "dict") {
      event.returnValue =
        dictWindow && !dictWindow.isDestroyed() ? true : false;
    } else if (config.type === "trans") {
      event.returnValue =
        transWindow && !transWindow.isDestroyed() ? true : false;
    } else {
      event.returnValue =
        linkWindow && !linkWindow.isDestroyed() ? true : false;
    }
  });
  ipcMain.on("get-dirname", (event, arg) => {
    event.returnValue = __dirname;
  });
  ipcMain.on("system-color", (event, arg) => {
    event.returnValue = getNativeDarkColorStatus() || false;
  });
  ipcMain.handle("set-native-theme-source", (event, appSkin) => {
    return applyNativeThemeSource(appSkin);
  });
  ipcMain.on("check-main-open", (event, arg) => {
    event.returnValue = mainWin ? true : false;
  });
  ipcMain.on("get-file-data", function (event) {
    if (fs.existsSync(path.join(dirPath, "log.json"))) {
      try {
        const _data = JSON.parse(
          fs.readFileSync(path.join(dirPath, "log.json"), "utf-8") || "{}"
        );
        if (_data && _data.filePath) {
          filePath = _data.filePath;
          setTimeout(() => {
            fs.writeFileSync(path.join(dirPath, "log.json"), "{}", "utf-8");
          }, 1000);
        }
      } catch (error) {
        console.error("Error reading log.json:", error);
      }
    }

    event.returnValue = filePath;
    filePath = null;
  });
  ipcMain.on("check-file-data", function (event) {
    if (fs.existsSync(path.join(dirPath, "log.json"))) {
      try {
        const _data = JSON.parse(
          fs.readFileSync(path.join(dirPath, "log.json"), "utf-8") || "{}"
        );
        if (_data && _data.filePath) {
          filePath = _data.filePath;
        }
      } catch (error) {
        console.error("Error reading log.json:", error);
      }
    }

    event.returnValue = filePath;
    filePath = null;
  });
};

// ============================================
// TTS 日志写入函数
// ============================================
const ttsLog = (msg) => {
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const line = `[${timestamp}] ${msg}\n`;
  try {
    const logPath = path.join(__dirname, "tts-debug.log");
    fs.appendFileSync(logPath, line, "utf-8");
  } catch(e) {
    // silently fail
  }
};

// 查找豆包 TTS 用的 Python 解释器（项目内 venv 优先）
const resolveDoubaoPython = () => {
  const venvRoot = path.join(__dirname, "test", "doubao-tts-test", ".venv");
  const candidates = [
    path.join(venvRoot, "Scripts", "python.exe"), // Windows
    path.join(venvRoot, "bin", "python"),          // macOS/Linux
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return "python";
};

// 查找豆包 TTS 服务可执行文件：
// 优先用 PyInstaller 打包好的 doubao_tts_server.exe（正式版无需 Python），
// 回退到 Python 脚本（开发模式）。
// 返回 { cmd, args, cwd } 或 null。
const resolveDoubaoServer = () => {
  // 打包后 asar 内的路径需转成真实磁盘路径：
  // app.asar/test/... → app.asar.unpacked/test/...
  // 开发模式下 __dirname 不含 app.asar，无需替换。
  const asarUnpack = (p) => {
    if (p.includes("app.asar" + path.sep)) {
      return p.replace("app.asar" + path.sep, "app.asar.unpacked" + path.sep);
    }
    return p;
  };
  const ttsDir = path.join(__dirname, "test", "doubao-tts-test");
  const exePath = asarUnpack(path.join(ttsDir, "doubao_tts_server.exe"));
  const scriptPath = path.join(ttsDir, "doubao_tts_server.py");
  const realTtsDir = asarUnpack(ttsDir); // exe 所在真实目录（.env 也在这里）
  if (fs.existsSync(exePath)) {
    // 打包版：直接跑 exe，cwd 设为 exe 所在真实目录以便读 .env
    return { cmd: exePath, args: [], cwd: realTtsDir };
  }
  if (fs.existsSync(scriptPath)) {
    // 开发版：用 venv 里的 python 跑脚本
    const pythonPath = process.env.PYTHON_PATH || resolveDoubaoPython();
    return { cmd: pythonPath, args: [scriptPath], cwd: ttsDir };
  }
  return null;
};

// ============================================
// 自动注册豆包 TTS 插件
// ============================================
const registerDoubaoPlugin = async () => {
  try {
    const storagePath = path.join(dirPath, "data");
    const { SqlStatement } = await import("./src/assets/lib/kookit-extra.min.mjs");
    if (!SqlStatement) {
      console.log("[PluginInit] SqlStatement not available yet, will retry later");
      return;
    }
    const db = getDBConnection("plugins", storagePath, SqlStatement.sqlStatement);
    if (!db) {
      console.log("[PluginInit] Failed to get DB connection");
      return;
    }
    
    // 始终覆盖写入，确保 DB 数据与代码一致（修复旧版短名 bug）
    const existing = db.prepare("SELECT * FROM plugins WHERE key = ?").get("doubao_tts_voice");
    if (existing) {
      db.prepare("DELETE FROM plugins WHERE key = ?").run("doubao_tts_voice");
      ttsLog("[PluginInit] 删除旧版豆包插件，重新注册...");
    }
    
    const config = { apiKey: "120f2e95-4030-413a-86b5-e721533197a0", resourceId: "seed-tts-2.0" };
    
    // Read the plugin script from file
    const scriptPath = path.join(__dirname, "scripts", "doubao-tts-plugin.js");
    let script = "";
    if (fs.existsSync(scriptPath)) {
      script = fs.readFileSync(scriptPath, "utf-8");
    } else {
      ttsLog("[PluginInit] 插件脚本文件不存在: " + scriptPath);
      return;
    }
    
    const voiceList = [
      { name: "zh_female_xiaohe_uranus_bigtts", displayName: "小何 2.0", gender: "female", locale: "zh-CN", plugin: "doubao_tts_voice" },
      { name: "zh_female_vv_uranus_bigtts", displayName: "Vivi 2.0", gender: "female", locale: "zh-CN", plugin: "doubao_tts_voice" },
      { name: "zh_male_m191_uranus_bigtts", displayName: "云舟 2.0", gender: "male", locale: "zh-CN", plugin: "doubao_tts_voice" },
      { name: "zh_male_taocheng_uranus_bigtts", displayName: "小天 2.0", gender: "male", locale: "zh-CN", plugin: "doubao_tts_voice" },
      { name: "zh_female_cancan_uranus_bigtts", displayName: "知性灿灿 2.0", gender: "female", locale: "zh-CN", plugin: "doubao_tts_voice" },
      { name: "zh_female_sophie_uranus_bigtts", displayName: "魅力苏菲 2.0", gender: "female", locale: "zh-CN", plugin: "doubao_tts_voice" },
    ];
    
    const insert = db.prepare(`INSERT OR REPLACE INTO plugins (key, type, displayName, icon, version, config, autoValue, langList, voiceList, scriptSHA256, script) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insert.run(
      "doubao_tts_voice",
      "voice",
      "豆包 TTS",
      "speaker",
      "1.0.0",
      JSON.stringify(config),
      null,
      null,
      JSON.stringify(voiceList),
      "",
      script
    );
    ttsLog("[PluginInit] 豆包插件注册成功!");
  } catch (err) {
    ttsLog("[PluginInit] 注册豆包插件失败: " + (err.message || err));
  }
};

app.on("ready", async () => {
  await registerDoubaoPlugin();
  createMainWin();
});
app.on("before-quit", () => {
  isQuitting = true;
  destroyDiscordRPC();
});
app.on("window-all-closed", () => {
  app.quit();
});
app.on("open-file", (e, pathToFile) => {
  filePath = pathToFile;
});
// Register protocol handler
app.setAsDefaultProtocolClient("koodo-reader");
const serializeArg = (arg) => {
  if (arg === null) return "null";
  if (arg === undefined) return "undefined";
  if (typeof arg === "object") {
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }
  return String(arg);
};
const originalConsoleLog = console.log;
console.log = function (...args) {
  originalConsoleLog(...args); // 保留原日志
  log.info(args.map(serializeArg).join(" ")); // 写入日志文件
};
const originalConsoleError = console.error;
console.error = function (...args) {
  originalConsoleError(...args); // 保留原错误日志
  log.error(args.map(serializeArg).join(" ")); // 写入错误日志文件
};
const originalConsoleWarn = console.warn;
console.warn = function (...args) {
  originalConsoleWarn(...args); // 保留原警告日志
  log.warn(args.map(serializeArg).join(" ")); // 写入警告日志文件
};
const originalConsoleInfo = console.info;
console.info = function (...args) {
  originalConsoleInfo(...args); // 保留原信息日志
  log.info(args.map(serializeArg).join(" ")); // 写入信息日志文件
};
// Handle MacOS deep linking
app.on("open-url", (event, url) => {
  event.preventDefault();
  handleCallback(url);
});
const handleCallback = (url) => {
  try {
    // 检查 URL 是否有效
    if (!url.startsWith("koodo-reader://")) {
      console.error("Invalid URL format:", url);
      return;
    }

    // 解析 URL
    const parsedUrl = new URL(url);
    const code = parsedUrl.searchParams.get("code");
    const state = parsedUrl.searchParams.get("state");
    const pickerData = parsedUrl.searchParams.get("pickerData");

    const bookKey = parsedUrl.searchParams.get("bookKey");
    const noteKey = parsedUrl.searchParams.get("noteKey");
    const importUrl = parsedUrl.searchParams.get("importUrl");

    if (code && mainWin) {
      mainWin.webContents.send("oauth-callback", { code, state });
    }
    if (pickerData && mainWin) {
      let config = JSON.parse(decodeURIComponent(pickerData));
      mainWin.webContents.send("picker-finished", config);
    }
    if (bookKey && mainWin) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.show();
      mainWin.focus();
      mainWin.webContents.send("open-book-from-link", { bookKey });
    }
    if (noteKey && mainWin) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.show();
      mainWin.focus();
      mainWin.webContents.send("open-note-from-link", { noteKey });
    }
    if (importUrl && mainWin) {
      const decodedUrl = decodeURIComponent(importUrl);
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.show();
      mainWin.focus();
      mainWin.webContents.send("import-url-from-link", { url: decodedUrl });
    }
  } catch (error) {
    console.error("Error handling callback URL:", error);
    console.info("Problematic URL:", url);
  }
};
