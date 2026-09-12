/**
 * Banyan 主进程入口（server host 角色）
 */
import { app, BrowserWindow, shell } from "electron";
import { join } from "node:path";
import { registerIpcHandlers, importKeyFromEnvIfMissing, setFirstRunReport } from "./ipc";
import { openDatabase, closeDatabase } from "./db";
import { inspectUserData } from "./first-run";
import { sessionManager } from "./session-manager";

/** reload 会再次触发 ready-to-show，防止冒烟流程重入 */
let smokeStarted = false;

const isDev = !app.isPackaged;

// 必须在 app ready 之前设置，userData 路径依赖应用名
appNameSetup();
function appNameSetup(): void {
  app.setName("Banyan");
  app.setPath("userData", join(app.getPath("appData"), "Banyan"));
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#0b0d10",
    title: "Banyan",
    webPreferences: {
      // electron-vite 在 ESM 工程下输出 index.mjs；Electron 支持 ESM preload（需 sandbox: false）
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  window.on("ready-to-show", () => {
    window.show();
    // 冒烟自检：BANYAN_SMOKE 指向截图输出路径时，跑完流程自动退出
    const smokeTarget = process.env.BANYAN_SMOKE;
    if (smokeTarget && !smokeStarted) {
      smokeStarted = true;
      void import("./smoke").then(({ runSmoke }) => runSmoke(window, smokeTarget));
    }
  });

  // 外部链接走系统浏览器，不在应用内打开
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (isDev && devServerUrl) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return window;
}

app.whenReady().then(() => {
  // 首启检测必须在 openDatabase 之前：后者会创建 data 目录，掩盖“全新环境”的判断
  setFirstRunReport(inspectUserData(app.getPath("userData")));
  openDatabase(app.getPath("userData"));
  importKeyFromEnvIfMissing();
  registerIpcHandlers();
  sessionManager.startIdleReaper();
  const window = createWindow();
  sessionManager.attachWindow(window);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      sessionManager.attachWindow(createWindow());
    }
  });
});

app.on("window-all-closed", () => {
  // 仅 Windows 目标，但保留标准行为
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  sessionManager.disposeAll();
  closeDatabase();
});
