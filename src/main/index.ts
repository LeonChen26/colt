/**
 * Colt 主进程入口（server host 角色）
 */
import { app, BrowserWindow, shell } from "electron";
import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { registerIpcHandlers, importKeyFromEnvIfMissing, setFirstRunReport } from "./ipc";
import { openDatabase, shutdownDatabase } from "./db";
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
  // 开发态用独立目录：与安装版共用同一份数据时，两个实例会各自 fork 一个 worker
  // 写**同一个**会话 JSONL，而内核要求 seq 跨行严格递增——双写会让整份历史在下次
  // 打开时被判为 Invalid storage 而彻底打不开（真实事故，见 commit.js 的校验）。
  // 顺带一个好处：单实例锁按 userData 路径生效，于是 dev 与安装版仍能并存。
  const dirName = isDev ? "Colt-dev" : "Colt";
  app.setPath("userData", join(app.getPath("appData"), dirName));
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

    // 冒烟自检：**仅开发期**。用 import.meta.env.DEV 守卫，生产构建会把整段
    // （含环境变量名与路径计算）树摇掉——包里不残留这套装置的任何痕迹，
    // 也就不会出现「打包后仍存在一个可被环境变量激活的入口」。
    if (import.meta.env.DEV) {
      // COLT_SMOKE 只表达文件名，目录固定为 out/（编译后主进程在 out/main，上一级即 out/）；
      // 即便传绝对路径也只取 basename，冒烟不再往仓库根目录丢文件。
      const smokeArtifactPath = (name: string): string =>
        join(__dirname, "..", basename(name) || ".smoke.png");

      const smokeName = process.env.COLT_SMOKE;
      if (smokeName && !smokeStarted) {
        smokeStarted = true;
        const smokeTarget = smokeArtifactPath(smokeName);
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

/**
 * 单实例锁：同一份 userData 只允许一个实例活着。
 *
 * 之所以是硬约束而不是礼貌：两个实例会各自 fork 一个 worker 去写**同一个**会话
 * JSONL。内核要求 seq 跨行严格递增（commit.js 的 validateCommittedWrites），
 * 两条写入流交错后，整份历史会在下一次打开时被判为 Invalid JSONL storage 而
 * **再也打不开**——这是已经发生过的事故，不是假想风险。
 *
 * 锁按 userData 路径生效，而开发态用的是独立目录（见 appNameSetup），
 * 所以 dev 与安装版仍可各跑一份，只是各自不能再开第二份。
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // 用户重复双击图标时把已有窗口放到前面，而不是静默什么都不发生
  app.on("second-instance", () => {
    const [existing] = BrowserWindow.getAllWindows();
    if (!existing) return;
    if (existing.isMinimized()) existing.restore();
    existing.focus();
  });
  bootApp();
}

function bootApp(): void {
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

  app.on("window-all-closed", () => {
    // 仅 Windows 目标，但保留标准行为
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    sessionManager.disposeAll();
    // 退出用 shutdownDatabase 而非 closeDatabase：后者保留自愈所需的路径，
    // 会让退出过程中的残余调用把库又建出来
    shutdownDatabase();
  });
}

/**
 * 建窗后统一登记宿主窗口。
 * 会话管理（推送 view/status）与浏览器宿主（挂 WebContentsView）各要一份引用，
 * 漏掉任一处都会表现为「功能静默失效」——前者界面不刷新，后者浏览器动作直接报错。
 */
function attachWindow(window: BrowserWindow): void {
  sessionManager.attachWindow(window);
  hostBridge.attachWindow(window);
}
