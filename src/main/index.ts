/**
 * Colt 主进程入口（server host 角色）
 */
import { app, BrowserWindow, shell } from "electron";
import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
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
  app.setName("Colt");
  app.setPath("userData", join(app.getPath("appData"), "Colt"));
}

/**
 * 冒烟产物目录：编译后的主进程位于 out/main，向上一级即 out/。
 * 产物（截图 / 日志）一律落在这里，不再散到仓库根目录；out/ 已被 .gitignore
 * 覆盖、且随构建重建，所以这些文件天然是「生成物」而非需要手工清理的垃圾。
 */
const SMOKE_OUT_DIR = join(__dirname, "..");

/**
 * 把 COLT_SMOKE 归一化成 out/ 下的产物路径。
 * 该变量现在只表示**文件名**——即便传进来的是绝对路径，也只取其 basename，
 * 目录固定为 out/。
 */
function smokeArtifactPath(name: string): string {
  return join(SMOKE_OUT_DIR, basename(name) || ".smoke.png");
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
    title: "Colt",
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
    // 冒烟自检：COLT_SMOKE 给出产物文件名时，跑完流程自动退出。
    // 产物路径统一归一到 out/（见 smokeArtifactPath），不会落到仓库根目录。
    // 打包后一律不启用（与 worker 覆盖同一条原则）：该装置只为开发期验收，
    // 其 chunk 也未随包分发（见 electron-builder.yml 的 files 排除项）。
    const smokeName = process.env.COLT_SMOKE;
    const smokeTarget = smokeName ? smokeArtifactPath(smokeName) : undefined;
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
  // 审批策略设置需在库打开后才能读（sessionManager 是模块级单例，构造期库尚未就绪）
  sessionManager.reloadAnalyzeCommandAllowlist();
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
