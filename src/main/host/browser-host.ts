/**
 * 内置浏览器宿主：主进程持有真实的 WebContentsView（内嵌在应用主窗口右栏），
 * worker 通过 toolRpc 驱动。
 *
 * 用 Electron 自带能力（WebContentsView + executeJavaScript + capturePage）而非引入
 * Playwright：省去数百 MB 浏览器二进制，且截图/页面状态天然与应用同进程，便于用户旁观与授权。
 *
 * 形态：浏览器**内嵌**在主窗口右栏（规则 ⑦-C「视野跳跃为零」），不再是独立窗口。
 * 原生视图浮在渲染层之上，渲染层画不了它，因此：
 *   - 渲染层的「页面区域」占位 div 量出矩形 → `browser.bounds` → 这里 `setBounds` 摆放；
 *   - 页签切走 / 会话切走时上报 null → 这里隐藏，避免原生视图盖住别的内容。
 * 视图仍是**懒创建**：首次浏览器动作才建 WebContents（规则 ⑦-2）。
 *
 * 安全边界：页面按只浏览不注入的沙箱配置（nodeIntegration 关闭、contextIsolation 开启、
 * sandbox 开启）；仅允许 http/https；DOM 操作只走 snapshot 派发的 ref，不接受任意选择器。
 *
 * 观测：控制台取自 webContents 的 console-message；网络取自浏览器**专属 partition** 的
 * webRequest——与主应用同 session 时只能靠 webContentsId 过滤，独立 partition 后天然隔离。
 * 两者都在导航时清空。
 *
 * 文件：下载经 will-download 落盘到应用自有的下载目录（不写进用户的「下载」文件夹），并限制
 * 单会话条数与单文件体积。上传是唯一需要 CDP 的动作——input[type=file] 出于安全无法用 JS 赋值，
 * 故用 Electron 内置的 webContents.debugger 调 DOM.setFileInputFiles（不新增依赖）。
 */
import {
  app,
  session,
  WebContentsView,
  type BrowserWindow,
  type Rectangle,
  type WebContents,
} from "electron";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { BrowserNavAction, BrowserObservation, BrowserRect, BrowserViewState } from "@shared/protocol";
import type { HostResult } from "@shared/worker-protocol";
import {
  CaptureBuffer,
  clampWaitTimeout,
  exceedsDownloadSize,
  formatDownloadNotice,
  formatNavigationNotice,
  formatWaitResult,
  isFileInput,
  isWaitMode,
  MAX_DOWNLOAD_BYTES,
  parseWaitOutcome,
  planDownload,
  readPaths,
  readRef,
  resolveViewport,
  shouldAdoptPopup,
  waitScript,
  WAIT_QUIET_MS,
  type DownloadEntry,
  type WaitMode,
} from "./browser-observe";

/** 单次页面加载上限 */
const NAV_TIMEOUT_MS = 30_000;
/** did-fail-load 的 ERR_ABORTED：多为导航被新请求取代，不算页面故障 */
const ERR_ABORTED = -3;
/**
 * 浏览器专属 partition：持久化（persist: 前缀）以便登录态跨会话保留，
 * 同时与主应用的 defaultSession 隔离——网络/下载观测因此不必再靠 webContentsId
 * 把应用自身的流量剔除出去。
 */
const BROWSER_PARTITION = "persist:banyan-browser";
/**
 * 渲染层尚未上报矩形时的兜底视口。
 * 自动化冒烟（runFixture）直接驱动宿主、没有渲染层参与，页面仍需一个非退化视口
 * 才能让响应式重排可观测，故给一个合理的默认值。
 */
const DEFAULT_RECT: Rectangle = { x: 0, y: 0, width: 1024, height: 768 };

interface SessionBrowser {
  view: WebContentsView;
  /** 控制台与网络观测缓冲，导航时清空 */
  capture: CaptureBuffer;
  /** 渲染层上报的页面区域；null 表示尚未上报（用兜底矩形） */
  bounds: Rectangle | null;
  /**
   * 渲染层明确表示「当前不可见」（切到了别的页签 / 会话切走）。
   * 注意不能用 bounds === null 表达隐藏：自动化冒烟没有渲染层参与、
   * 视图从未被上报过，此时必须保持可见，否则 setBounds 不生效、响应式重排无从观测。
   */
  hidden: boolean;
  /** viewport 动作的临时覆盖尺寸（响应式联调用），null 表示未覆盖 */
  viewport: { width: number; height: number } | null;
}

/** 页面内取可交互元素：给每个元素打稳定 ref，返回一段人类/模型可读的清单 */
const SNAPSHOT_SCRIPT = `(() => {
  const selector = 'a,button,input,select,textarea,[role="button"],[role="link"],[contenteditable="true"]';
  const nodes = Array.from(document.querySelectorAll(selector)).slice(0, 200);
  let seq = Number(window.__banyanRefSeq || 0);
  const lines = nodes.map((el) => {
    let ref = el.getAttribute('data-banyan-ref');
    if (!ref) { seq += 1; ref = 'e' + seq; el.setAttribute('data-banyan-ref', ref); }
    const raw = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.innerText || el.value || '';
    const name = String(raw).replace(/\\s+/g, ' ').trim().slice(0, 80);
    const role = el.getAttribute('role') || el.tagName.toLowerCase();
    return '[' + ref + '] ' + role + ' "' + name + '"';
  });
  window.__banyanRefSeq = seq;
  return 'URL: ' + location.href + '\\nTITLE: ' + document.title + '\\n' + lines.join('\\n');
})()`;

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function assertHttpUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`非法 URL：${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`仅支持 http/https 地址：${url}`);
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function clickScript(ref: string): string {
  const selector = JSON.stringify(`[data-banyan-ref="${ref}"]`);
  return `(() => {
    const el = document.querySelector(${selector});
    if (!el) return '未找到元素 ${ref}，请重新执行 snapshot';
    el.scrollIntoView({ block: 'center' });
    if (typeof el.click === 'function') el.click();
    else el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return '已点击 ${ref}';
  })()`;
}

function typeScript(ref: string, text: string): string {
  const selector = JSON.stringify(`[data-banyan-ref="${ref}"]`);
  const value = JSON.stringify(text);
  return `(() => {
    const el = document.querySelector(${selector});
    if (!el) return '未找到元素 ${ref}，请重新执行 snapshot';
    el.focus();
    if ('value' in el) {
      el.value = ${value};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      el.textContent = ${value};
    }
    return '已输入到 ${ref}';
  })()`;
}

/** 用户手动导航的结果：给渲染层的新状态，以及（页面真变了时）给 agent 的提示 */
export interface BrowserNavigation {
  state: BrowserViewState;
  /** 给 agent 的环境提示；没有实际导航（已到头）时为空串 */
  notice: string;
}

export class BrowserHost {
  readonly #sessions = new Map<string, SessionBrowser>();
  /** webContents.id → sessionId：把 partition 级网络/下载事件收敛到对应会话 */
  readonly #webContentsToSession = new Map<number, string>();
  /** 会话 → 已触发的下载数，用于给落盘文件名加序号（否则同名会互相覆盖） */
  readonly #downloadSeq = new Map<string, number>();
  /** 承载内嵌视图的主窗口；未挂载前浏览器动作会明确报错，而不是静默失败 */
  #window: BrowserWindow | undefined;
  /** 视图状态变化回调（由 HostBridge 接到 sessionManager 的推送出口） */
  #onState: ((state: BrowserViewState) => void) | undefined;
  #networkHooked = false;
  #downloadHooked = false;
  #browserSession: Electron.Session | undefined;

  /** 主进程建好主窗口后调用（内嵌视图必须有宿主窗口） */
  attachWindow(window: BrowserWindow): void {
    this.#window = window;
  }

  /** 注册视图状态回调；重复注册以最后一次为准 */
  onState(listener: (state: BrowserViewState) => void): void {
    this.#onState = listener;
  }

  /**
   * 渲染层上报页面区域矩形（窗口内容坐标）。
   * null = 该视图当前不可见（切到别的页签 / 会话切走）：原生视图不参与 DOM 叠层，
   * 不隐藏就会浮在界面上盖住别的内容。
   */
  setBounds(sessionId: string, rect: BrowserRect | null): void {
    const entry = this.#sessions.get(sessionId);
    if (entry === undefined) return;
    if (rect === null) {
      entry.hidden = true;
    } else {
      entry.bounds = { ...rect };
      entry.hidden = false;
    }
    this.#applyBounds(sessionId);
  }

  /** 读取视图状态（渲染层挂载时对齐已加载的视图） */
  stateOf(sessionId: string): BrowserViewState {
    const entry = this.#sessions.get(sessionId);
    if (entry === undefined) {
      return {
        sessionId,
        loaded: false,
        url: "",
        title: "",
        canGoBack: false,
        canGoForward: false,
        viewport: null,
      };
    }
    const contents = entry.view.webContents;
    const history = contents.navigationHistory;
    return {
      sessionId,
      loaded: true,
      url: contents.getURL(),
      title: contents.getTitle(),
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
      viewport: entry.viewport === null ? null : { ...entry.viewport },
    };
  }

  /**
   * 撤销「视口联调」覆盖（用户在浏览器头部点「恢复」）。
   *
   * 覆盖是**持久**状态：只有显式撤销才结束（导航、切页签都不清），
   * 所以必须给用户一个出口——否则 agent 忘了恢复，面板就一直按那个尺寸摆放。
   */
  resetViewport(sessionId: string): BrowserViewState {
    const entry = this.#sessions.get(sessionId);
    if (entry === undefined) throw new Error("浏览器尚未加载，没有可恢复的视口");
    entry.viewport = null;
    this.#applyBounds(sessionId);
    // 推给界面：头部据此收起「视口 × 恢复」标记
    this.#emitState(sessionId, true);
    return this.stateOf(sessionId);
  }

  /**
   * 用户手动导航（B1）：后退 / 前进 / 刷新。
   *
   * 与 `handle()` 那条 agent 链路**刻意分开**：它不接受任意 URL、不做 upload 这类落到本地磁盘的动作，
   * 只做浏览器本身就有的三个浏览动作——因此没有「越界」可言，也就不需要审批
   * （审批裁决的是模型给出的工具入参，而这里根本没有模型参与）。
   *
   * 但页面确实被换掉了，agent 手里那份「页面是什么样」随之过期，故同时给出 `notice`，
   * 由调用方（IPC 层）转给 worker 告知 agent。
   *
   * 已经到头（退无可退 / 进无可进）时不动作、也不产生提示：页面没变，没什么可告知的。
   */
  navigate(sessionId: string, action: BrowserNavAction): BrowserNavigation {
    const entry = this.#sessions.get(sessionId);
    if (entry === undefined) throw new Error("浏览器尚未加载，无法后退 / 前进 / 刷新");
    const contents = entry.view.webContents;
    if (contents.isDestroyed()) throw new Error("浏览器视图已销毁");
    const history = contents.navigationHistory;

    if (action === "back" && !history.canGoBack()) {
      return { state: this.stateOf(sessionId), notice: "" };
    }
    if (action === "forward" && !history.canGoForward()) {
      return { state: this.stateOf(sessionId), notice: "" };
    }

    // 目的页从历史里**现取**：goBack()/goForward() 是异步的，此后再读 getURL() 拿到的还是旧页面，
    // 那样提示里写的地址就是错的——写错比不写更糟。上面已按 canGoBack/canGoForward 保证下标在界内。
    const index = history.getActiveIndex();
    const targetIndex = action === "back" ? index - 1 : action === "forward" ? index + 1 : index;
    const target = history.getEntryAtIndex(targetIndex);

    if (action === "back") history.goBack();
    else if (action === "forward") history.goForward();
    else contents.reload();

    return {
      // 这里读到的是**发起时**的状态；真正的新状态由 did-navigate 随后推送
      state: this.stateOf(sessionId),
      notice: formatNavigationNotice(action, target.url, target.title),
    };
  }

  /**
   * 观测快照（B2）：控制台 / 网络 / 下载三份结构化缓冲。
   *
   * 与 `browser_read` 的 console/network/downloads 读的是**同一份** `CaptureBuffer`——
   * 抽屉不是另一套数据源，只是把同一份观测用 UI 呈现出来（⑦-A「现场」那一半）。
   * 会话还没建过浏览器视图时返回空快照 + `loaded: false`，而不是抛错：
   * 「还没开始」和「开始了但没有输出」在界面上必须能区分。
   */
  observe(sessionId: string): BrowserObservation {
    const entry = this.#sessions.get(sessionId);
    if (entry === undefined) {
      return { sessionId, loaded: false, console: [], network: [], downloads: [] };
    }
    return {
      sessionId,
      loaded: true,
      console: entry.capture.consoleEntries(),
      network: entry.capture.networkEntries(),
      downloads: entry.capture.downloadEntries(),
    };
  }

  /**
   * 按「视口覆盖 > 渲染层矩形 > 兜底矩形」摆放视图。
   *
   * viewport 覆盖存在时只改尺寸、锚点仍取矩形左上角，这样响应式联调的页面宽度
   * 与真实停靠位置一致。
   *
   * ⚠️ 覆盖**不会**因为渲染层重新上报而让位——它只在显式「恢复」时撤销。
   * （此处原注释写「渲染层一旦重新上报，覆盖即让位于真实布局」，与实现相反，已订正。）
   * 这一点很要紧：渲染层现在每 400ms 会重申一次矩形，若覆盖真的让位，联调功能就会当场失效；
   * 反过来，覆盖不退出的代价是它会**持久**盖住布局，所以尺寸必须报给界面
   * （`BrowserViewState.viewport`），由头部显示并提供「恢复」入口——
   * 实测覆盖 1280×800、停靠区 823×643 时，右侧 209px 被窗口边缘裁掉、下方 157px 压住观测抽屉，
   * 而从界面上完全看不出这是联调尺寸，只会以为渲染坏了。
   */
  #applyBounds(sessionId: string): void {
    const entry = this.#sessions.get(sessionId);
    if (entry === undefined) return;
    const base = entry.bounds ?? DEFAULT_RECT;
    const size = entry.viewport ?? { width: base.width, height: base.height };
    try {
      entry.view.setBounds({ x: base.x, y: base.y, width: size.width, height: size.height });
      entry.view.setVisible(!entry.hidden);
    } catch {
      // 视图可能正好在销毁中；摆放失败不该打断调用方
    }
  }

  /** 浏览器专属 session；首次使用时创建，必须晚于 app ready */
  #session(): Electron.Session {
    if (this.#browserSession === undefined) {
      this.#browserSession = session.fromPartition(BROWSER_PARTITION);
    }
    return this.#browserSession;
  }

  /** 视图状态变化时推给渲染层 */
  #emitState(sessionId: string, loaded: boolean): void {
    if (this.#onState === undefined) return;
    const state = loaded
      ? this.stateOf(sessionId)
      : ({
          sessionId,
          loaded: false,
          url: "",
          title: "",
          canGoBack: false,
          canGoForward: false,
          viewport: null,
        } satisfies BrowserViewState);
    this.#onState(state);
  }

  /**
   * 注册网络观测。
   *
   * webRequest 按 session 注册，这里挂在浏览器专属 partition 上：该 session 只承载
   * 浏览器页面，因此不再需要把应用自身的流量过滤掉（与 defaultSession 天然隔离）。
   * 必须等 app ready 之后（即首次开视图时）再调用，否则拿不到 session。
   */
  #hookNetwork(): void {
    if (this.#networkHooked) return;
    this.#networkHooked = true;
    const webRequest = this.#session().webRequest;

    webRequest.onCompleted({ urls: ["<all_urls>"] }, (details) => {
      this.#captureOf(details.webContentsId)?.recordNetwork({
        url: details.url,
        method: details.method,
        resourceType: details.resourceType,
        statusCode: details.statusCode,
      });
    });
    webRequest.onErrorOccurred({ urls: ["<all_urls>"] }, (details) => {
      this.#captureOf(details.webContentsId)?.recordNetwork({
        url: details.url,
        method: details.method,
        resourceType: details.resourceType,
        error: details.error,
      });
    });
  }

  #captureOf(webContentsId: number | undefined): CaptureBuffer | undefined {
    if (webContentsId === undefined) return undefined;
    const sessionId = this.#webContentsToSession.get(webContentsId);
    if (sessionId === undefined) return undefined;
    return this.#sessions.get(sessionId)?.capture;
  }

  /** 本会话的下载目录：放应用数据目录下，既不污染项目工作区，也不写进用户的「下载」文件夹 */
  #downloadDir(sessionId: string): string {
    return join(app.getPath("userData"), "browser-downloads", sessionId);
  }

  /**
   * 接管下载。
   *
   * 与网络同理，will-download 是 session 级；这里挂在浏览器专属 partition 上，
   * 不属于本类管辖的窗口（例如应用自身）根本不在该 session，天然不干预。
   */
  #hookDownload(): void {
    if (this.#downloadHooked) return;
    this.#downloadHooked = true;

    this.#session().on("will-download", (_event, item, webContents) => {
      // 类型上非空，但并非所有下载来源都会带上它，故按可选处理
      const source = webContents as WebContents | undefined;
      const sessionId = source === undefined ? undefined : this.#webContentsToSession.get(source.id);
      if (sessionId === undefined) return;
      const capture = this.#sessions.get(sessionId)?.capture;
      if (capture === undefined) return;

      const url = item.getURL();
      const seq = (this.#downloadSeq.get(sessionId) ?? 0) + 1;
      this.#downloadSeq.set(sessionId, seq);

      const dir = this.#downloadDir(sessionId);
      const plan = planDownload(item.getFilename(), seq, dir);
      if (!plan.ok) {
        item.cancel();
        capture.recordConsole({ level: "warning", message: plan.reason, source: url, line: 0 });
        return;
      }

      try {
        mkdirSync(dir, { recursive: true });
        item.setSavePath(plan.path);
      } catch (error) {
        capture.recordConsole({
          level: "error",
          message: `下载无法落盘：${error instanceof Error ? error.message : String(error)}`,
          source: url,
          line: 0,
        });
        return;
      }

      // 页面能反复触发下载，故设体积上限，避免被拖着把磁盘写满
      let overSizeLimit = false;
      item.on("updated", (_updated, state) => {
        if (state === "progressing" && exceedsDownloadSize(item.getReceivedBytes())) {
          overSizeLimit = true;
          item.cancel();
        }
      });

      item.once("done", (_done, state) => {
        const entry: DownloadEntry = {
          filename: plan.filename,
          path: plan.path,
          url,
          bytes: item.getReceivedBytes(),
          state,
          note: overSizeLimit ? `超过体积上限（${MAX_DOWNLOAD_BYTES} 字节），已取消` : undefined,
        };
        capture.recordDownload(entry);
        capture.recordConsole({
          level: state === "completed" ? "info" : "warning",
          message: formatDownloadNotice(entry),
          source: url,
          line: 0,
        });
      });
    });
  }

  /**
   * 懒创建：某会话首次使用浏览器时才建 WebContents（规则 ⑦-2）。
   *
   * 视图挂到主窗口的 contentView 上，初始隐藏——位置要等渲染层上报矩形，
   * 或 viewport 动作显式给出尺寸，在此之前不该浮在界面上。
   */
  #viewFor(sessionId: string): WebContentsView {
    const existing = this.#sessions.get(sessionId);
    if (existing !== undefined) return existing.view;

    const owner = this.#window;
    if (owner === undefined || owner.isDestroyed()) {
      throw new Error("浏览器宿主尚未挂载主窗口，无法创建内嵌视图");
    }

    const view = new WebContentsView({
      webPreferences: {
        // 独立 partition：与应用自身隔离（网络/下载观测因此不必按 webContentsId 过滤）
        partition: BROWSER_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    view.setBackgroundColor("#ffffff");
    view.setVisible(false);
    view.setBounds(DEFAULT_RECT);

    const capture = new CaptureBuffer();
    const contents = view.webContents;
    // webContents 会随视图销毁，之后访问它的任何属性都会抛「Object has been destroyed」；
    // destroyed 回调正是在这个时点触发的，所以 id 必须在这里先取好，回调里不能再碰 contents。
    const contentsId = contents.id;

    contents.on("console-message", (details) => {
      capture.recordConsole({
        level: details.level,
        message: details.message,
        source: details.sourceId,
        line: details.lineNumber,
      });
    });
    // 主文档加载失败不会经过 console，但同样属于「页面有问题」，补一条便于 agent 定位
    contents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame || errorCode === ERR_ABORTED) return;
        capture.recordConsole({
          level: "error",
          message: `页面加载失败：${errorDescription}（${errorCode}）`,
          source: validatedURL,
          line: 0,
        });
      },
    );
    // 地址/标题变化都要同步给渲染层（右栏浏览器视图的 URL 展示）
    contents.on("did-navigate", () => this.#emitState(sessionId, true));
    contents.on("did-navigate-in-page", () => this.#emitState(sessionId, true));
    contents.on("page-title-updated", () => this.#emitState(sessionId, true));
    // 新窗口一律不开：默认行为会生出一个不受本类管理的窗口——读不到、disposeAll 也回收不掉，
    // 而 agent 后续的 snapshot/text 仍停在旧页面上，表现为「点了没反应」。改为在当前视图接管。
    // 接管与否记一条 info 到控制台缓冲（这里没有独立的通知通道，靠文案自证来源）。
    contents.setWindowOpenHandler((details) => {
      if (!shouldAdoptPopup(details.url)) {
        capture.recordConsole({
          level: "info",
          message: `已拦截非 http(s) 的新窗口请求：${details.url}`,
          source: details.url,
          line: 0,
        });
        return { action: "deny" };
      }
      capture.reset();
      capture.recordConsole({
        level: "info",
        message: `拦截新窗口请求，已在当前窗口打开：${details.url}`,
        source: details.url,
        line: 0,
      });
      void contents.loadURL(details.url).catch(() => undefined);
      return { action: "deny" };
    });

    this.#hookNetwork();
    this.#hookDownload();
    this.#webContentsToSession.set(contentsId, sessionId);
    this.#sessions.set(sessionId, { view, capture, bounds: null, hidden: false, viewport: null });
    owner.contentView.addChildView(view);
    return view;
  }

  /**
   * 向 file input 选择本地文件。
   *
   * input[type=file].value 出于安全不允许用 JS 赋值，唯一可行路径是 CDP 的
   * DOM.setFileInputFiles —— 用 Electron 内置的 webContents.debugger（本身就是 CDP），
   * 不引入额外依赖。挂载是按需的，用完即摘，避免长期占用调试通道。
   *
   * 路径是否越界由审批层（policy.ts）把关，与本仓 write/edit 的既有分工一致。
   */
  async #uploadFiles(contents: WebContents, ref: string, paths: string[]): Promise<string> {
    const missing = paths.filter((file) => !existsSync(file));
    if (missing.length > 0) throw new Error(`文件不存在：${missing.join("、")}`);

    const cdp = contents.debugger;
    const attachedHere = !cdp.isAttached();
    if (attachedHere) {
      try {
        cdp.attach("1.3");
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`无法挂载调试协议（可能已有 DevTools 打开）：${reason}`);
      }
    }

    try {
      await cdp.sendCommand("DOM.enable");
      const document = await cdp.sendCommand("DOM.getDocument", { depth: 0 });
      const found = await cdp.sendCommand("DOM.querySelector", {
        nodeId: document.root.nodeId,
        selector: `[data-banyan-ref="${ref}"]`,
      });
      if (!found.nodeId) throw new Error(`未找到元素 ${ref}，请重新执行 snapshot`);

      const described = await cdp.sendCommand("DOM.describeNode", { nodeId: found.nodeId });
      const node = described.node as { nodeName: string; attributes?: string[] };
      if (!isFileInput(node.nodeName, node.attributes)) {
        throw new Error(`${ref} 不是 file 类型的 input（实际为 ${node.nodeName}），无法选择文件`);
      }

      await cdp.sendCommand("DOM.setFileInputFiles", { nodeId: found.nodeId, files: paths });
      return `已向 ${ref} 选择 ${paths.length} 个文件：${paths.join("、")}`;
    } finally {
      if (attachedHere) cdp.detach();
    }
  }

  async handle(sessionId: string, action: string, params: Record<string, unknown>): Promise<HostResult> {
    const view = this.#viewFor(sessionId);
    const contents = view.webContents;
    const capture = this.#sessions.get(sessionId)?.capture;

    switch (action) {
      case "navigate": {
        const url = readString(params.url);
        if (url === undefined) throw new Error("navigate 需要 url 参数");
        assertHttpUrl(url);
        // 新页面的控制台/网络与旧页面无关：先清空再加载，此后捕获的即为本次导航的流量
        capture?.reset();
        await withTimeout(contents.loadURL(url), NAV_TIMEOUT_MS, `页面加载超时：${url}`);
        // 首次加载即通知渲染层：右栏显示「浏览器」页签并自动切过去（规则 ⑦-F）
        this.#emitState(sessionId, true);
        return { text: `已打开 ${contents.getURL() || url}` };
      }
      case "snapshot":
        return { text: String(await contents.executeJavaScript(SNAPSHOT_SCRIPT, true)) };
      case "text":
        return {
          text: String(await contents.executeJavaScript("document.body ? document.body.innerText : ''", true)),
        };
      case "url":
        return { text: contents.getURL() || "about:blank" };
      case "title":
        return { text: contents.getTitle() };
      case "console":
        return { text: capture?.consoleText() ?? "控制台：自上次导航以来没有输出。" };
      case "network":
        return { text: capture?.networkText() ?? "网络：自上次导航以来没有捕获到请求。" };
      case "downloads":
        return { text: capture?.downloadsText() ?? "下载：本会话尚未触发任何下载。" };
      case "wait": {
        // 省略 mode 时按参数推断：给了 text 就等文本出现，否则等 DOM 静止
        const mode: WaitMode = isWaitMode(params.mode)
          ? params.mode
          : readString(params.text) !== undefined
            ? "text"
            : "idle";
        const text = readString(params.text) ?? "";
        if (mode === "text" && text.length === 0) {
          throw new Error("wait 的 text 模式需要 text 参数");
        }
        const timeoutMs = clampWaitTimeout(params.timeoutMs);
        const raw = await withTimeout(
          contents.executeJavaScript(waitScript(mode, text, timeoutMs, WAIT_QUIET_MS), true),
          timeoutMs + 5_000,
          `等待超时（${timeoutMs}ms）`,
        );
        const outcome = parseWaitOutcome(raw);
        return { text: formatWaitResult(mode, text, outcome.ok, outcome.elapsedMs) };
      }
      case "viewport": {
        const resolution = resolveViewport(params.width, params.height);
        if (!resolution.ok) throw new Error(resolution.error);
        const entry = this.#sessions.get(sessionId);
        if (entry === undefined) throw new Error("浏览器视图尚未创建");
        // 内嵌形态下没有「窗口内容尺寸」可调，改为临时覆盖视图尺寸：
        // 恢复默认 = 撤销覆盖，交还给渲染层上报的布局。
        entry.viewport = resolution.restored ? null : { ...resolution.size };
        this.#applyBounds(sessionId);
        // 覆盖是**持久**状态且会让原生视图与停靠区不一致，所以界面必须知道它变了——
        // 头部要据此显示「视口 1280×800 · 恢复」，否则用户只会看到一个像渲染坏了的面板。
        this.#emitState(sessionId, true);
        // 用实际生效值回话：与旧实现一致，别把请求值当成结果
        const bounds = entry.view.getBounds();
        return {
          text: resolution.restored
            ? `已恢复默认视口：${bounds.width}x${bounds.height}`
            : `已设置视口：${bounds.width}x${bounds.height}。媒体查询已按此尺寸生效；截图前如需确认重排完成，可先 wait（mode=idle）。`,
        };
      }
      case "click": {
        const ref = readRef(params.ref);
        return { text: String(await contents.executeJavaScript(clickScript(ref), true)) };
      }
      case "type": {
        const ref = readRef(params.ref);
        const text = readString(params.text) ?? "";
        return { text: String(await contents.executeJavaScript(typeScript(ref, text), true)) };
      }
      case "upload": {
        const ref = readRef(params.ref);
        const paths = readPaths(params.paths);
        if (paths.length === 0) throw new Error("upload 需要 paths 参数（本地文件的绝对路径数组）");
        return { text: await this.#uploadFiles(contents, ref, paths) };
      }
      case "scroll": {
        const up = params.direction === "up";
        await contents.executeJavaScript(`window.scrollBy(0, ${up ? -600 : 600}); true`, true);
        return { text: up ? "已向上滚动" : "已向下滚动" };
      }
      case "screenshot": {
        const image = await contents.capturePage();
        const title = contents.getTitle();
        const url = contents.getURL();
        return {
          text: `已截取页面：${title || "(无标题)"} ${url}`.trim(),
          image: { data: image.toPNG().toString("base64"), mimeType: "image/png" },
        };
      }
      default:
        throw new Error(`未知的浏览器动作：${action}`);
    }
  }

  /**
   * 会话关闭时销毁对应视图。
   *
   * 注意顺序与判活：webContents 一旦 destroyed，访问它的任何属性都会抛
   * 「Object has been destroyed」。这里先把视图摘出树、再关 webContents，
   * 并且每一步前都判活——这条路径正是历史上出过「关会话弹主进程错误框」的地方
   * （见 BROWSER-TEST-CASES 断言 22）。
   */
  closeSession(sessionId: string): void {
    const entry = this.#sessions.get(sessionId);
    if (entry === undefined) return;
    this.#sessions.delete(sessionId);
    this.#downloadSeq.delete(sessionId);

    const contents = entry.view.webContents;
    if (!contents.isDestroyed()) this.#webContentsToSession.delete(contents.id);
    try {
      this.#window?.contentView.removeChildView(entry.view);
    } catch {
      // 宿主窗口可能已先一步销毁
    }
    if (!contents.isDestroyed()) contents.close();
    // 通知渲染层收起「浏览器」页签与页面区域占位
    this.#emitState(sessionId, false);
  }

  disposeAll(): void {
    for (const sessionId of [...this.#sessions.keys()]) this.closeSession(sessionId);
  }
}
