/**
 * 浏览器观测的纯逻辑：控制台/网络消息的采集缓冲与格式化，以及「等待页面就绪」脚本的生成。
 *
 * 刻意不 import electron，与 input-keys.ts 同理：注入进页面的实现不好测，
 * 但这层「决定模型看到什么」的逻辑必须可信——把噪声当问题、或把问题当噪声，
 * agent 就会基于错误信息继续往下做。
 */
import { join } from "node:path";
import type {
  BrowserNavAction,
  ConsoleEntry,
  DownloadEntry,
  NetworkEntry,
} from "@shared/protocol";

/**
 * 观测条目的类型定义在 `@shared/protocol`——渲染层的观测抽屉（B2）要渲染同一份数据，
 * 契约只能有一处。这里转出去，让 `./browser-observe` 继续作为本模块既有调用方的导入点。
 */
export type { ConsoleEntry, DownloadEntry, NetworkEntry };

/** 单会话每类观测的保留上限，超出丢弃最旧的 */
export const CAPTURE_LIMIT = 300;

/** 单会话保留的下载条数上限：下载会落盘，无限累积既占磁盘也让列表失去信号 */
export const MAX_DOWNLOADS_PER_SESSION = 5;

/** 单个文件的体积上限，超过即取消，避免被页面拖着把磁盘写满 */
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

/** 单会话的观测缓冲：控制台 + 网络 + 下载 */
export class CaptureBuffer {
  readonly #console: ConsoleEntry[] = [];
  readonly #network: NetworkEntry[] = [];
  readonly #downloads: DownloadEntry[] = [];

  recordConsole(entry: ConsoleEntry): void {
    this.#console.push(entry);
    if (this.#console.length > CAPTURE_LIMIT) {
      this.#console.splice(0, this.#console.length - CAPTURE_LIMIT);
    }
  }

  recordNetwork(entry: NetworkEntry): void {
    this.#network.push(entry);
    if (this.#network.length > CAPTURE_LIMIT) {
      this.#network.splice(0, this.#network.length - CAPTURE_LIMIT);
    }
  }

  recordDownload(entry: DownloadEntry): void {
    this.#downloads.push(entry);
    if (this.#downloads.length > MAX_DOWNLOADS_PER_SESSION) {
      this.#downloads.splice(0, this.#downloads.length - MAX_DOWNLOADS_PER_SESSION);
    }
  }

  /**
   * 导航后调用：控制台与网络属于「当前页面」，旧页面的问题不该误报成新页面的。
   *
   * 下载**刻意不清空**：文件已经落盘，与页面生命周期无关；而且常见流程正是
   * 「点了导出 → 跳转了 → 想知道文件到底下来没有」。
   */
  reset(): void {
    this.#console.length = 0;
    this.#network.length = 0;
  }

  consoleText(limit = 20): string {
    return formatConsole(this.#console, limit);
  }

  networkText(limit = 30): string {
    return formatNetwork(this.#network, limit);
  }

  downloadsText(limit = MAX_DOWNLOADS_PER_SESSION): string {
    return formatDownloads(this.#downloads, limit);
  }

  /**
   * 结构化快照（B2 的 `browser.observe` 用）。
   *
   * 返回**副本**而不是内部数组：调用方（IPC 序列化）不该拿到能改到缓冲的引用，
   * 否则一次误改就会污染后续 agent 读到的观测。
   */
  consoleEntries(): ConsoleEntry[] {
    return [...this.#console];
  }

  networkEntries(): NetworkEntry[] {
    return [...this.#network];
  }

  downloadEntries(): DownloadEntry[] {
    return [...this.#downloads];
  }
}

/** 压缩空白并截断，避免一条日志吃掉整个上下文 */
function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** 源码地址压成文件名：完整 URL 在日志里只是噪声 */
function shortSource(source: string): string {
  if (source.length === 0) return "";
  const withoutQuery = source.split(/[?#]/)[0] ?? "";
  const parts = withoutQuery.split("/");
  return parts[parts.length - 1] || withoutQuery;
}

function isConsoleProblem(entry: ConsoleEntry): boolean {
  return entry.level === "error" || entry.level === "warning";
}

function consoleLine(entry: ConsoleEntry): string {
  const where = entry.source.length > 0 ? ` (${shortSource(entry.source)}:${entry.line})` : "";
  return `[${entry.level}] ${truncate(entry.message, 200)}${where}`;
}

/**
 * 控制台输出：**问题消息优先，且不被「最近 N 条」挤掉**。
 *
 * 若只按时间倒序取尾巴，几条 error 很容易被大量 info 淹掉——而 error 才是 agent 要的东西。
 * 所以先单列 error/warning，再附上最近的普通消息作为上下文。
 */
export function formatConsole(entries: readonly ConsoleEntry[], limit = 20): string {
  if (entries.length === 0) return "控制台：自上次导航以来没有输出。";

  const problems = entries.filter(isConsoleProblem);
  const others = entries.filter((entry) => !isConsoleProblem(entry));
  const errors = problems.filter((entry) => entry.level === "error").length;

  const lines = [
    `控制台：共 ${entries.length} 条（error ${errors} / warning ${problems.length - errors} / 其它 ${others.length}）`,
  ];

  if (problems.length > 0) {
    const shown = problems.slice(0, limit);
    const omitted = problems.length > shown.length ? `，仅列前 ${shown.length}` : "";
    lines.push(`问题消息（${problems.length} 条${omitted}）：`);
    for (const entry of shown) lines.push(`  ${consoleLine(entry)}`);
  }

  if (others.length > 0) {
    const shown = others.slice(-limit);
    lines.push(`其它最近 ${shown.length} 条：`);
    for (const entry of shown) lines.push(`  ${consoleLine(entry)}`);
  }

  return lines.join("\n");
}

function isNetworkProblem(entry: NetworkEntry): boolean {
  return entry.error !== undefined || (entry.statusCode ?? 0) >= 400;
}

/**
 * 网络输出：先给总量，再列问题请求（4xx/5xx/网络错误）。
 *
 * 只列失败项是刻意的——成功请求对 agent 几乎没有信息量，列出来只会淹没真正的问题；
 * 相同 URL 合并计数，避免一个循环重试刷屏。
 */
export function formatNetwork(entries: readonly NetworkEntry[], limit = 30): string {
  if (entries.length === 0) return "网络：自上次导航以来没有捕获到请求。";

  const failed = entries.filter(isNetworkProblem);
  if (failed.length === 0) {
    return `网络：共 ${entries.length} 个请求，未发现失败（无 4xx/5xx 或网络错误）。`;
  }

  const counts = { client: 0, server: 0, network: 0 };
  const merged = new Map<string, { entry: NetworkEntry; count: number }>();
  for (const entry of failed) {
    if (entry.error !== undefined) counts.network += 1;
    else if ((entry.statusCode ?? 0) >= 500) counts.server += 1;
    else counts.client += 1;

    const key = `${entry.method} ${entry.url}`;
    const existing = merged.get(key);
    if (existing === undefined) merged.set(key, { entry, count: 1 });
    else existing.count += 1;
  }

  const list = [...merged.values()];
  const shown = list.slice(0, limit);
  const omitted = list.length > shown.length ? `，仅列前 ${shown.length}` : "";
  const lines = [
    `网络：共 ${entries.length} 个请求，问题 ${failed.length} 个` +
      `（4xx ${counts.client} / 5xx ${counts.server} / 网络错误 ${counts.network}）`,
    `问题请求（去重后 ${list.length} 个${omitted}）：`,
  ];
  for (const { entry, count } of shown) {
    const tag = entry.error !== undefined ? `错误 ${entry.error}` : String(entry.statusCode ?? "?");
    const times = count > 1 ? ` ×${count}` : "";
    lines.push(`  [${tag}] ${entry.method} ${entry.url} (${entry.resourceType})${times}`);
  }
  return lines.join("\n");
}

/** 等待模式：load=页面加载完成；text=正文出现指定文本；idle=DOM 停止变化 */
export type WaitMode = "load" | "text" | "idle";

export const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
export const MAX_WAIT_TIMEOUT_MS = 60_000;
/** idle 模式判定「静止」的静默窗口 */
export const WAIT_QUIET_MS = 500;

export function isWaitMode(value: unknown): value is WaitMode {
  return value === "load" || value === "text" || value === "idle";
}

/** 把外部传入的超时收敛到合理区间，避免模型给 0 或天文数字 */
export function clampWaitTimeout(value: unknown): number {
  const raw = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_WAIT_TIMEOUT_MS;
  return Math.min(Math.max(Math.round(raw), 500), MAX_WAIT_TIMEOUT_MS);
}

/**
 * 生成页内等待脚本：返回一个 resolve 为 JSON 字符串的 Promise。
 *
 * 在页内轮询而非主进程轮询，页面卡顿时也能靠页内定时器推进；
 * 同时保留页内硬超时，防止主进程侧超时后页面里仍留着一个永不结束的 Promise。
 */
export function waitScript(mode: WaitMode, text: string, timeoutMs: number, quietMs: number): string {
  const branch =
    mode === "text"
      ? `    const want = ${JSON.stringify(text)};
    const check = () => {
      const body = document.body;
      if (body && body.innerText && body.innerText.indexOf(want) !== -1) {
        done(true, '已找到文本');
        return true;
      }
      return false;
    };
    if (check()) return;
    poll = setInterval(() => { if (check()) clearInterval(poll); }, 250);`
      : mode === "load"
        ? `    const check = () => {
      if (document.readyState === 'complete') {
        done(true, 'readyState=complete');
        return true;
      }
      return false;
    };
    if (check()) return;
    poll = setInterval(() => { if (check()) clearInterval(poll); }, 250);`
        : `    let timer = 0;
    const quiet = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { if (observer) observer.disconnect(); done(true, 'DOM 已停止变化'); }, ${quietMs});
    };
    observer = new MutationObserver(quiet);
    observer.observe(document.documentElement || document, { childList: true, subtree: true });
    quiet();`;

  return `(() => new Promise((resolve) => {
  const started = Date.now();
  let hardStop = 0;
  let poll = 0;
  let observer = null;
  const done = (ok, detail) => {
    if (hardStop) clearTimeout(hardStop);
    // 超时路径也要清掉轮询定时器 / 观察器：否则每次等待超时都在页面里留下一个
    // 永久 interval（innerText 轮询会强制布局）或 MutationObserver，多次超时层层叠加。
    if (poll) clearInterval(poll);
    if (observer) observer.disconnect();
    resolve(JSON.stringify({ ok, detail, elapsedMs: Date.now() - started }));
  };
  hardStop = setTimeout(() => done(false, '等待超时'), ${timeoutMs});
${branch}
}))()`;
}

export interface WaitOutcome {
  ok: boolean;
  elapsedMs: number;
  detail: string;
}

/** 解析页面返回的 JSON；页面被销毁或返回异常形状时降级为「未成功」而不是抛错 */
export function parseWaitOutcome(raw: unknown): WaitOutcome {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as { ok?: unknown; elapsedMs?: unknown; detail?: unknown };
      return {
        ok: parsed.ok === true,
        elapsedMs: typeof parsed.elapsedMs === "number" ? parsed.elapsedMs : 0,
        detail: typeof parsed.detail === "string" ? parsed.detail : "",
      };
    } catch {
      // 落到下面的兜底
    }
  }
  return { ok: false, elapsedMs: 0, detail: "无法解析等待结果（页面可能已销毁）" };
}

/** 等待结果转成给模型看的一句话；超时时顺带指向下一步排查动作 */
export function formatWaitResult(mode: WaitMode, text: string, ok: boolean, elapsedMs: number): string {
  const seconds = (elapsedMs / 1000).toFixed(1);
  const target =
    mode === "text"
      ? `正文出现「${truncate(text, 60)}」`
      : mode === "load"
        ? "页面加载完成"
        : "DOM 停止变化";
  return ok
    ? `等待完成：${target}（耗时 ${seconds}s）`
    : `等待超时：${seconds}s 内未等到「${target}」。页面可能仍在加载、被脚本阻塞，或条件写错了；建议改读 console / network 排查。`;
}

export interface ViewportSize {
  width: number;
  height: number;
}

/** 与开窗时的内容区尺寸保持一致 */
export const DEFAULT_VIEWPORT: ViewportSize = { width: 1100, height: 800 };

/** 视口夹取区间：下界取常见最小移动端宽度，上界避免把窗口撑到超出屏幕 */
export const MIN_VIEWPORT_WIDTH = 320;
export const MAX_VIEWPORT_WIDTH = 3840;
export const MIN_VIEWPORT_HEIGHT = 240;
export const MAX_VIEWPORT_HEIGHT = 2160;

export type ViewportResolution =
  | { ok: true; size: ViewportSize; restored: boolean }
  | { ok: false; error: string };

/**
 * 解析 viewport 入参。
 *
 * 都不给 = 恢复默认；都给 = 按值夹取；只给一个、或给的不是数字 = 明确报错。
 * 后两条是刻意的：静默补默认值会让人以为拿到了 375 宽的移动端视口，实际是 375x800，
 * 这种「看起来对」的结果比报错更难排查。
 */
export function resolveViewport(width: unknown, height: unknown): ViewportResolution {
  const hasWidth = width !== undefined && width !== null;
  const hasHeight = height !== undefined && height !== null;

  if (!hasWidth && !hasHeight) {
    return { ok: true, size: { ...DEFAULT_VIEWPORT }, restored: true };
  }
  if (!hasWidth || !hasHeight) {
    return { ok: false, error: "viewport 需要同时给出 width 与 height（或都不给以恢复默认尺寸）" };
  }

  const w = typeof width === "number" && Number.isFinite(width) ? Math.round(width) : undefined;
  const h = typeof height === "number" && Number.isFinite(height) ? Math.round(height) : undefined;
  if (w === undefined || h === undefined) {
    return { ok: false, error: "viewport 的 width 与 height 必须是数字" };
  }

  return {
    ok: true,
    restored: false,
    size: {
      width: Math.min(Math.max(w, MIN_VIEWPORT_WIDTH), MAX_VIEWPORT_WIDTH),
      height: Math.min(Math.max(h, MIN_VIEWPORT_HEIGHT), MAX_VIEWPORT_HEIGHT),
    },
  };
}

/**
 * 弹出窗口是否该在当前窗口接管。
 *
 * 只接管 http/https：其它协议（file:、自定义协议等）一律拒绝，避免绕过「仅 http/https」的沙箱边界。
 */
export function shouldAdoptPopup(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Windows 文件名禁用字符与控制字符 */
const UNSAFE_FILENAME_CHARS = /[<>:"|?*\u0000-\u001f]/g;

/**
 * 从页面给的文件名里取一个可安全落盘的名字。
 *
 * 页面给的名字不可信：可能带路径分隔符或 ".."，直接拼进下载目录就会写到目录之外。
 * 这里先取最后一段，再清掉禁用字符与结尾的点/空格（Windows 不允许以此结尾）。
 */
export function safeDownloadFilename(raw: string): string {
  const basename = raw.split(/[/\\]/).pop() ?? "";
  const cleaned = basename.replace(UNSAFE_FILENAME_CHARS, "_").replace(/[. ]+$/, "").trim();
  if (cleaned.length === 0 || /^\.+$/.test(cleaned)) return "download";
  return cleaned.length > 120 ? cleaned.slice(0, 120) : cleaned;
}

/** 下载规划结果：要么给出可落盘的目标，要么说明为何拒绝 */
export type DownloadPlan =
  | { ok: true; seq: number; filename: string; path: string }
  | { ok: false; reason: string };

/**
 * 决定一次下载怎么落盘。
 *
 * 单独的「能下就下」不够：页面可以循环触发下载把磁盘写满，所以先按会话条数设上限；
 * 文件名则统一加序号前缀，避免页面反复用同一个名字（export.csv）互相覆盖，
 * 最后再把不可信的文件名清洗一遍。
 */
export function planDownload(
  rawFilename: string,
  seq: number,
  dir: string,
  limit = MAX_DOWNLOADS_PER_SESSION,
): DownloadPlan {
  if (seq > limit) {
    return {
      ok: false,
      reason: `已取消下载：${safeDownloadFilename(rawFilename)}（本会话下载数超过上限 ${limit}）`,
    };
  }
  const filename = `${seq}-${safeDownloadFilename(rawFilename)}`;
  return { ok: true, seq, filename, path: join(dir, filename) };
}

/**
 * 下载过程中收到的字节数是否已超过单文件上限。
 *
 * 边界刻意用 `>`：恰好等于上限算合法，避免一个大小刚好卡在上限的文件被误判为超限。
 */
export function exceedsDownloadSize(receivedBytes: number, limit = MAX_DOWNLOAD_BYTES): boolean {
  return receivedBytes > limit;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 下载结束时写进控制台缓冲的一句话：让 agent 不必主动查也知道文件下落 */
export function formatDownloadNotice(entry: DownloadEntry): string {
  if (entry.state === "completed") {
    return `已下载文件：${entry.filename}（${formatBytes(entry.bytes)}）→ ${entry.path}`;
  }
  return `下载未完成（${entry.state}）：${entry.filename}${entry.note ? `，${entry.note}` : ""}`;
}

/**
 * 用户手动导航后写给 agent 的一句提示（B1）。
 *
 * 它是**环境提示而不是用户发言**：不写进 transcript（走内核的 transform_context，
 * 只影响下一次模型请求），因此对话与分支树里不会凭空多出一轮，也不会被摘要当成真实历史。
 * 文案要给到「该怎么做」——只说「页面变了」，模型仍可能接着用旧的 ref 操作。
 */
export function formatNavigationNotice(
  action: BrowserNavAction,
  url: string,
  title: string,
): string {
  const label = action === "back" ? "后退" : action === "forward" ? "前进" : "刷新";
  const where = url.length > 0 ? url : "about:blank";
  return (
    `【系统提示】用户在本次运行期间手动操作了浏览器（${label}），当前页面为 ${where}` +
    `${title.length > 0 ? `（${title}）` : ""}。` +
    "你之前掌握的元素 ref 与页面内容可能已经过期，继续操作前请先用 browser_read 的 snapshot 重新确认页面。"
  );
}

/** 下载列表：文件名、状态、落盘路径与来源，末尾给一句下一步提示 */
export function formatDownloads(
  entries: readonly DownloadEntry[],
  limit = MAX_DOWNLOADS_PER_SESSION,
): string {
  if (entries.length === 0) return "下载：本会话尚未触发任何下载。";

  const shown = entries.slice(-limit);
  const lines = [`下载：共 ${entries.length} 个（列出最近 ${shown.length} 个）`];
  for (const entry of shown) {
    const status =
      entry.state === "completed"
        ? formatBytes(entry.bytes)
        : `${entry.state}${entry.note ? `：${entry.note}` : ""}`;
    lines.push(`  ${entry.filename} [${status}] → ${entry.path}`);
    lines.push(`    来自 ${entry.url}`);
  }
  lines.push("提示：这些文件已落盘，可直接用 shell / 读文件工具查看内容。");
  return lines.join("\n");
}

/** CDP 的 node.attributes 是扁平的 [名, 值, 名, 值, ...] 数组 */
export function readNodeAttribute(
  attributes: readonly string[] | undefined,
  name: string,
): string | undefined {
  if (attributes === undefined) return undefined;
  for (let i = 0; i + 1 < attributes.length; i += 2) {
    if (attributes[i] === name) return attributes[i + 1];
  }
  return undefined;
}

/** snapshot 派发的元素编号格式；其它形状一律拒绝，避免把任意选择器带进页面 */
const REF_PATTERN = /^e\d+$/;

/**
 * 归一化外部传入的本地路径数组。
 *
 * 模型给的 paths 未必干净：可能是单个字符串、含空串、或带首尾空白。
 * 这里只保留非空字符串并 trim，剩下的交给「文件是否存在」去判定。
 */
export function readPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * upload 的目标 ref 必须来自 snapshot 且符合编号格式。
 *
 * 这条校验是安全边界的一部分：DOM 操作只走 snapshot 派发的 ref，不接受任意选择器。
 */
export function readRef(value: unknown): string {
  const ref = typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  if (ref === undefined || !REF_PATTERN.test(ref)) {
    throw new Error("需要有效的 ref（来自 browser_read 的 snapshot 结果）");
  }
  return ref;
}

/**
 * 该 DOM 节点是否是可接受文件的 input。
 *
 * 调 CDP setFileInputFiles 前必须自查：对非 file input 调用只会抛一条晦涩的协议错误，
 * agent 无法据此区分「ref 过期了」还是「这个元素本来就不能选文件」。
 */
export function isFileInput(nodeName: string, attributes: readonly string[] | undefined): boolean {
  return nodeName.toUpperCase() === "INPUT" && readNodeAttribute(attributes, "type") === "file";
}

