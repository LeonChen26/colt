/**
 * Banyan 主进程入口（server host 角色）
 */
import { app, BrowserWindow, shell } from "electron";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerIpcHandlers, importKeyFromEnvIfMissing, setFirstRunReport } from "./ipc";
import { openDatabase, closeDatabase } from "./db";
import { inspectUserData } from "./first-run";
import { hostBridge } from "./host";
import { sessionManager } from "./session-manager";

/** reload 会再次触发 ready-to-show，防止冒烟流程重入 */
let smokeStarted = false;

/**
 * 开发期判定：打包后 process.defaultApp 为 undefined。
 * 不单看 app.isPackaged —— 经验上在 dev 启动（electron .）过程中该 getter 会出现
 * 晚值漂移，在 ready-to-show 时读到 true，从而误判为「已打包」，把冒烟与 dev
 * 资源加载一起关掉（表现为窗口正常但冒烟一声不响）。
 */
const isDev = process.defaultApp === true || !app.isPackaged;

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
    // 冒烟自检：BANYAN_SMOKE 指向截图输出路径时，跑完流程自动退出。
    // 打包后一律不启用（与 worker 覆盖同一条原则）：该装置只为开发期验收，
    // 其 chunk 也未随包分发（见 electron-builder.yml 的 files 排除项）。
    const smokeTarget = process.env.BANYAN_SMOKE;
    if (smokeTarget && isDev && !smokeStarted) {
      smokeStarted = true;
      // 动态导入失败（构建产物缺失 / 语法错误）必须落盘可见，
      // 否则表现为「窗口正常但冒烟一声不响」，极难排查。
      void import("./smoke")
        .then(({ runSmoke }) => runSmoke(window, smokeTarget))
        .catch((error: unknown) => {
          console.error("[SMOKE] 加载失败", error);
          try {
            writeFileSync(
              `${smokeTarget}.log`,
              `[SMOKE] 加载失败 ${error instanceof Error ? error.stack : String(error)}\n`,
              "utf8",
            );
          } catch {
            // 兜底日志写不出去也没别的办法
          }
        });
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
  attachWindow(window);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      attachWindow(createWindow());
    }
  });
});

/**
 * 建窗后统一登记宿主窗口。
 * 会话管理（推送 view/status）与浏览器宿主（挂 WebContentsView）各要一份引用，
 * 漏掉任一处都会表现为「功能静默失效」——前者界面不刷新，后者浏览器动作直接报错。
 */
function attachWindow(window: BrowserWindow): void {
  sessionManager.attachWindow(window);
  hostBridge.attachWindow(window);
}

app.on("window-all-closed", () => {
  // 仅 Windows 目标，但保留标准行为
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  sessionManager.disposeAll();
  closeDatabase();
});
