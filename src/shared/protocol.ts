/**
 * Banyan IPC 契约（单一真源）
 * 主进程、预加载、渲染进程共享此定义。
 */

import type { ConversationView, ViewFileChange } from "./worker-protocol";

/** 环境体检结果 */
export interface EnvReport {
  /** Electron 版本 */
  electron: string;
  /** 内置 Node 版本 */
  node: string;
  /** Chrome 版本 */
  chrome: string;
  platform: string;
  arch: string;
  /** node:sqlite 是否可用 */
  sqliteAvailable: boolean;
  /** bash 可执行文件路径，未找到时为 undefined */
  bashPath?: string;
  /** bash 来源：git / path / custom */
  bashSource?: "git" | "path" | "custom";
  /** 体检是否整体通过 */
  ok: boolean;
  /** 未通过时的说明 */
  problems: string[];
}

/** 首次运行 / 历史数据检测结果 */
export interface FirstRunReport {
  /** 是否存在历史数据目录（%APPDATA%\Banyan 已存在） */
  hasHistoricalData: boolean;
  /** 历史数据库文件是否存在 */
  hasDatabase: boolean;
  /** 历史项目数量 */
  projectCount: number;
  /** 历史会话数量 */
  sessionCount: number;
  /** 是否已配置过任何密钥 */
  hasSecret: boolean;
  /** 用户数据目录绝对路径 */
  userDataPath: string;
  /** 是否已完成首启引导（写入了标志文件） */
  onboardingDone: boolean;
}

/** 用户对首启历史数据的选择 */
export type FirstRunChoice = "import" | "fresh";

/** 项目 */
export interface Project {
  id: string;
  name: string;
  rootPath: string;
  createdAt: number;
  lastOpenedAt: number;
}

/** 会话工作目录的 git 状态 */
export interface GitStatus {
  /** 目录是否位于某个 git 仓库内 */
  isRepo: boolean;
  /** 当前分支名；游离 HEAD 或非仓库时为 null */
  branch: string | null;
  /** 是否处于游离 HEAD（HEAD 直接指向提交） */
  detached: boolean;
}

/** 矩形（窗口内容坐标，CSS px 即 DIP） */
export interface BrowserRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 内嵌浏览器视图状态。
 *
 * 浏览器本体现在是挂在主窗口上的 WebContentsView（原生视图，浮在渲染层之上），
 * 渲染层无法直接绘制它，只能：① 上报「页面区域」矩形让主进程摆放；② 展示 URL 等元信息。
 * loaded 为 false 表示尚未创建 WebContents（懒创建，见 UI-REGIONS ⑦-2）。
 */
export interface BrowserViewState {
  sessionId: string;
  loaded: boolean;
  url: string;
  title: string;
  /**
   * 能否后退 / 前进（B1）。
   *
   * 由主进程从 `webContents.navigationHistory` 现读，渲染层**只据此决定按钮可用性**，
   * 不自己维护一份历史——那必然与真实 webContents 的历史走偏（页面内的 JS 跳转、
   * 重定向都会改历史，渲染层看不见）。
   */
  canGoBack: boolean;
  canGoForward: boolean;
  /**
   * 是否处于「视口联调」状态（agent 的 `browser_act viewport` 设过尺寸且**未恢复**）。
   *
   * 覆盖生效时页面按这个尺寸重排，而原生视图的摆放锚点仍是页面区域左上角——
   * 于是覆盖尺寸一旦大于停靠区，多出的部分既看不到（被窗口边缘裁掉）又看着像渲染坏了。
   * 它是**只在显式「恢复」时才撤销**的持久状态，因此必须报给界面：头部要显示它、并提供撤销入口。
   */
  viewport: { width: number; height: number } | null;
}

/**
 * 用户在界面里对浏览器发起的导航动作（B1）。
 *
 * 仅这三种：它们是**浏览**动作，不改变页面内容也不触及本地文件/磁盘，
 * 因此与 agent 发起的 `browser_act`（走审批）不同——用户自己点浏览器的后退键，
 * 本来就是「直接操作这个浏览器」，没有可审批的对象（审批的是模型给出的入参）。
 */
export type BrowserNavAction = "back" | "forward" | "reload";

/**
 * 浏览器观测条目（B2）。类型定义放在共享契约里，是因为**两侧都要用**：
 * 主进程的 `CaptureBuffer` 采集它，渲染层的观测抽屉渲染它。
 *
 * 刻意保留结构化字段而不是复用给模型的格式化文本：抽屉要按级别染色、按状态分组，
 * 而那段文本是**为模型压缩过**的（问题优先、去重、截断），拿来做 UI 会丢信息。
 */

/** 控制台条目 */
export interface ConsoleEntry {
  /** info / warning / error / debug */
  level: string;
  message: string;
  /** 日志来源地址 */
  source: string;
  /** 日志来源行号，未知为 0 */
  line: number;
}

/** 网络条目 */
export interface NetworkEntry {
  url: string;
  method: string;
  /** mainFrame / xhr / script / image 等 */
  resourceType: string;
  /** 请求失败（未拿到响应）时的错误描述，如 net::ERR_CONNECTION_REFUSED */
  error?: string;
  /** 拿到响应时的状态码 */
  statusCode?: number;
}

/** 下载条目 */
export interface DownloadEntry {
  /** 落盘后的文件名（带序号前缀，避免同名互相覆盖） */
  filename: string;
  /** 落盘的绝对路径 */
  path: string;
  /** 触发下载的 URL */
  url: string;
  bytes: number;
  /** completed / cancelled / interrupted */
  state: string;
  /** 未完成时的原因，如体积超限被取消 */
  note?: string;
}

/**
 * 一次观测快照（`browser.observe` 的返回）：控制台 + 网络 + 下载三份结构化缓冲。
 *
 * `loaded` 为 false 表示该会话还没建过浏览器视图——此时三份都是空数组，
 * 渲染层据此区分「还没开始」与「开始了但确实没有输出」。
 */
export interface BrowserObservation {
  sessionId: string;
  loaded: boolean;
  console: ConsoleEntry[];
  network: NetworkEntry[];
  downloads: DownloadEntry[];
}

/** 会话（索引信息，本体在 JSONL） */
export interface SessionInfo {
  id: string;
  projectId: string;
  title: string;
  jsonlPath: string;
  /** 内核 JSONL 会话 ID，首次打开前为 null */
  kernelSessionId: string | null;
  presetId: string | null;
  /** 会话选定模型，格式 "providerId/modelId"，未选时为 null */
  modelRef: string | null;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  status: "active" | "archived";
}

/** 会话运行态 */
export type SessionRunState = "idle" | "running" | "dormant" | "crashed";

/**
 * 运行时调用通道白名单：preload 据此拒绝未授权通道。
 * 通道的类型真源是下面的 IpcInvokeMap；本数组与它的键由紧随其后的断言在
 * 编译期强制对齐（漏登记会让渲染层调用被白名单拒绝并崩溃，类型检查却无感），
 * 故不再需要「正则解析本文件源码比对白名单」的测试。
 */
export const IPC_CHANNELS = [
  "env.check",
  "app.info",
  "firstRun.check",
  "firstRun.resolve",
  "project.pick",
  "project.list",
  "session.create",
  "session.list",
  "session.open",
  "session.prompt",
  "session.abort",
  "session.close",
  "session.delete",
  "session.view",
  "secrets.status",
  "secrets.set",
  "changes.list",
  "usage.list",
  "toolCalls.list",
  "providers.list",
  "providers.save",
  "providers.remove",
  "session.setModel",
  "session.steer",
  "session.compact",
  "approval.list",
  "approval.resolve",
  "approval.mode.get",
  "approval.mode.set",
  "approval.rules.list",
  "approval.rules.remove",
  "approval.rules.clear",
  "approval.analyzeConfig.get",
  "approval.analyzeConfig.set",
  "session.branches",
  "session.navigate",
  "git.status",
  "browser.bounds",
  "browser.state.get",
  "browser.observe",
  "browser.navigate",
  "browser.viewport.reset",
  "file.read",
] as const;

/**
 * 项目内文件的预览内容（`file.read` 的返回）。
 *
 * 用判别联合而不是「统一带 text」，是因为不同形态在界面上的呈现完全不同：
 * 文本要渲染、图片要给 dataUrl、二进制与超大只给提示——渲染层据此分流，
 * 不必去猜「这段字符串到底是不是内容」。
 */
export type FileReadResult =
  | { kind: "text"; text: string; size: number }
  | { kind: "image"; dataUrl: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "too-large"; size: number; limit: number };

/** 渲染进程 → 主进程的调用通道契约（类型真源） */
export interface IpcInvokeMap {
  "env.check": {
    request: void;
    response: EnvReport;
  };
  "app.info": {
    request: void;
    response: { version: string; userDataPath: string };
  };
  /** 首启检测：是否发现历史数据、是否需要引导 */
  "firstRun.check": {
    request: void;
    response: FirstRunReport;
  };
  /** 用户对历史数据的选择：import=沿用历史数据，fresh=清空重来 */
  "firstRun.resolve": {
    request: { choice: FirstRunChoice };
    response: { ok: true; cleared: boolean };
  };
  "project.pick": {
    request: void;
    response: Project | null;
  };
  "project.list": {
    request: void;
    response: Project[];
  };
  "session.create": {
    request: { projectId: string; presetId?: string };
    response: SessionInfo;
  };
  "session.list": {
    request: { projectId?: string };
    response: SessionInfo[];
  };
  "session.open": {
    request: { sessionId: string; cwd: string; model?: string };
    response: { ok: true };
  };
  "session.prompt": {
    request: {
      sessionId: string;
      text: string;
      /** 随消息发送的图片；data 为 base64，不含 data URI 前缀 */
      images?: { data: string; mimeType: string }[];
      /**
       * 会话工作目录。worker 被空闲回收后主进程凭它自动重建会话进程，
       * 因此渲染层必须回传（与 session.open 同源）。
       */
      cwd?: string;
    };
    response: { ok: true };
  };
  "session.abort": {
    request: { sessionId: string };
    response: { ok: true };
  };
  /** 关闭会话 worker（渲染层卸载时调用）；运行中的会话会被拒绝 */
  "session.close": {
    request: { sessionId: string };
    response: { ok: true; closed: boolean };
  };
  /** 永久删除会话：清 DB 记录、关联用量/工具/改动与 JSONL 历史；运行中的会话会被拒绝 */
  "session.delete": {
    request: { sessionId: string };
    response: { ok: true };
  };
  "session.view": {
    request: { sessionId: string };
    response: ConversationView | null;
  };
  "secrets.status": {
    request: void;
    response: { deepseek: boolean; deepseekMask?: string };
  };
  "secrets.set": {
    request: { key: "deepseek"; value: string };
    response: { ok: true };
  };
  /** 跨会话的项目级改动汇总 */
  "changes.list": {
    request: { projectId: string };
    response: ProjectFileChange[];
  };
  /** 会话用量历史与汇总 */
  "usage.list": {
    request: { sessionId: string };
    response: SessionUsage;
  };
  /** 会话工具调用历史 */
  "toolCalls.list": {
    request: { sessionId: string };
    response: ToolCallRecord[];
  };
  /** 当前待审批的工具调用 */
  "approval.list": {
    request: { sessionId: string };
    response: ApprovalRequest[];
  };
  /** 处置一条审批 */
  "approval.resolve": {
    request: { sessionId: string } & ApprovalResolution;
    response: { ok: true };
  };
  /** 读取会话的审批模式（审批模式是会话级状态，无全局设定） */
  "approval.mode.get": {
    request: { sessionId: string };
    response: { mode: ApprovalMode };
  };
  /** 切换会话的审批模式，仅影响该会话 */
  "approval.mode.set": {
    request: { mode: ApprovalMode; sessionId: string };
    response: { mode: ApprovalMode };
  };
  /** 列出会话内已记忆的放行/拒绝规则 */
  "approval.rules.list": {
    request: { sessionId: string };
    response: ApprovalRuleView[];
  };
  /** 删除一条已记忆的规则 */
  "approval.rules.remove": {
    request: { sessionId: string; ruleId: string };
    response: { ok: true };
  };
  /** 清空会话内全部规则（可按类别） */
  "approval.rules.clear": {
    request: { sessionId: string; kind?: ApprovalRuleKind };
    response: { ok: true };
  };
  /**
   * 读取「分析器自动放行的命令白名单」（审批策略，全局设置）。
   * 返回的是生效值：从未配置过时为内置默认。
   */
  "approval.analyzeConfig.get": {
    request: void;
    response: { commands: string[] };
  };
  /** 保存命令白名单；传空列表即关闭分析器自动放行（moderate 操作一律转人工） */
  "approval.analyzeConfig.set": {
    request: { commands: string[] };
    response: { commands: string[] };
  };
  /** 列出全部 provider */
  "providers.list": {
    request: void;
    response: ProviderConfig[];
  };
  /** 新增或更新自定义 provider */
  "providers.save": {
    request: { id: string; name: string; baseUrl: string; models: ModelOption[]; apiKey?: string };
    response: { ok: true };
  };
  /** 删除自定义 provider */
  "providers.remove": {
    request: { id: string };
    response: { ok: true };
  };
  /** 切换会话使用的模型 */
  "session.setModel": {
    request: { sessionId: string; providerId: string; modelId: string };
    response: { ok: true };
  };
  /** 显式插话 */
  "session.steer": {
    request: { sessionId: string; text: string };
    response: { ok: true };
  };
  /** 手动触发上下文压缩 */
  "session.compact": {
    request: { sessionId: string };
    response: { ok: true };
  };
  /** 分支树 */
  "session.branches": {
    request: { sessionId: string };
    response: BranchNode[];
  };
  /** 切换到指定节点 */
  "session.navigate": {
    request: { sessionId: string; targetId: string };
    response: { ok: true };
  };
  /** 读取会话工作目录的 git 分支（会话头展示） */
  "git.status": {
    request: { cwd: string };
    response: GitStatus;
  };
  /**
   * 渲染层上报内嵌浏览器的「页面区域」矩形（窗口内容坐标），主进程据此摆放 WebContentsView。
   * rect 为 null 表示该视图当前不可见（用户切到了别的页签 / 窗口过窄），主进程隐藏原生视图。
   */
  "browser.bounds": {
    request: { sessionId: string; rect: BrowserRect | null };
    response: { ok: true };
  };
  /** 读取会话的内嵌浏览器状态（渲染层挂载时对齐已加载的视图，避免切会话后丢页签） */
  "browser.state.get": {
    request: { sessionId: string };
    response: BrowserViewState;
  };
  /**
   * 读取浏览器观测快照（B2）：控制台 / 网络 / 下载三份结构化缓冲。
   *
   * 渲染层按 1s 轮询（只在「浏览器」页签挂载时），而不是由主进程逐条推送——
   * 页面产生的 console/network 事件可以非常密集，逐条推会变成 IPC 洪泛；
   * 而抽屉展示的是「缓冲区的当前样子」，轮询语义上更贴合，也不改 agent 那条读取路径。
   */
  "browser.observe": {
    request: { sessionId: string };
    response: BrowserObservation;
  };
  /**
   * 用户手动操作内嵌浏览器（B1）：后退 / 前进 / 刷新。
   *
   * 与 agent 的 `browser_act` 分开，是因为**发起方不同**：这条链路的每一跳都由用户的点击触发，
   * 所以不走审批（审批裁决的是模型给出的工具入参）；也因此它必须**告知 agent**——
   * 页面已经不是 agent 离开时那一页了，继续按旧页面操作会出错（见 sessionManager.notifyUserBrowserNavigation）。
   *
   * 返回**发起时读到**的视图状态。导航是异步的，完成后的状态由随后推送的 `browser.state`
   * 给出（did-navigate 时读到的就是新页面的历史）；返回值主要覆盖「点了没动作」的情形——
   * 比如已经退到底了再点后退，不会产生任何事件，此时渲染层靠它把按钮态保持正确。
   */
  "browser.navigate": {
    request: { sessionId: string; action: BrowserNavAction };
    response: BrowserViewState;
  };
  /**
   * 撤销「视口联调」覆盖（用户在浏览器头部点「恢复」）。
   *
   * 与 agent 的 `browser_act viewport`（不给尺寸即恢复）是同一件事，只是发起方变成了用户：
   * 覆盖是**持久**状态，只有显式撤销才结束，所以必须给用户一个入口——
   * 否则 agent 忘了恢复，用户就只能看着一个「像渲染坏了」的面板，无从下手。
   */
  "browser.viewport.reset": {
    request: { sessionId: string };
    response: BrowserViewState;
  };
  /**
   * 读取**项目内**文件用于预览。
   *
   * 路径**必须落在项目内**（相对路径按项目根展开；绝对路径也收，同样要落在项目内——
   * 工具入参里的 path 由模型给出，可能是绝对路径）。根由主进程按 sessionId → 项目查出来，
   * 渲染层无从指定——否则等于把任意读盘能力交给渲染层（而渲染层会渲染 agent 生成的 Markdown）。
   * 越界在**任何 fs 访问之前**即被拒。校验与上限见 `src/main/file-read.ts`。
   */
  "file.read": {
    request: { sessionId: string; path: string };
    response: FileReadResult;
  };
}

/** 模型选项 */
export interface ModelOption {
  id: string;
  name: string;
  contextWindow: number;
}

/** Provider 配置 */
export interface ProviderConfig {
  id: string;
  name: string;
  kind: "deepseek" | "openai-compatible";
  baseUrl: string;
  /** 内置项不可删改 */
  builtin: boolean;
  models: ModelOption[];
  /** 密钥是否已配置（不返回明文） */
  hasKey?: boolean;
}

/** 会话分支树节点 */
export interface BranchNode {
  id: string;
  parentId: string | null;
  /** 消息角色或条目类型 */
  kind: string;
  /** 摘要文本 */
  summary: string;
  timestamp: number;
  /** 是否在当前活跃路径上 */
  onActivePath: boolean;
  /** 是否是当前指针 */
  isTip: boolean;
}

/** 一条工具调用记录 */
export interface ToolCallRecord {
  id: string;
  /** 所属运行 ID，用于按一次运行聚合；历史数据可能为 null */
  runId: string | null;
  toolName: string;
  inputJson: string | null;
  isError: boolean;
  durationMs: number | null;
  createdAt: number;
}

/** 一条用量记录 */
export interface UsageRecord {
  id: number;
  provider: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  createdAt: number;
}

/** 会话用量历史与累计汇总 */
export interface SessionUsage {
  records: UsageRecord[];
  totals: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
    /** 记录条数，即模型调用轮次 */
    calls: number;
  };
}

/** 项目级文件改动（带会话归属） */
export interface ProjectFileChange {
  id: number;
  sessionId: string;
  sessionTitle: string;
  path: string;
  kind: string;
  patch: string | null;
  addedLines: number;
  removedLines: number;
  createdAt: number;
}

export type IpcChannel = keyof IpcInvokeMap;
export type IpcRequest<C extends IpcChannel> = IpcInvokeMap[C]["request"];
export type IpcResponse<C extends IpcChannel> = IpcInvokeMap[C]["response"];

/**
 * 键对齐断言：IPC_CHANNELS（运行时白名单）与契约表必须双向一致。
 * 两个方向任一不匹配都会报
 * 「Type '"xxx"' does not satisfy the constraint 'never'」，直接指名通道。
 */
type MustBeNever<T extends never> = T;
export type ChannelParityChecked = [
  MustBeNever<Exclude<IpcChannel, (typeof IPC_CHANNELS)[number]>>,
  MustBeNever<Exclude<(typeof IPC_CHANNELS)[number], IpcChannel>>,
];

/** 运行时事件白名单（同 IPC_CHANNELS：类型真源是下面的 IpcEventMap） */
export const IPC_EVENTS = [
  "session.view",
  "session.status",
  "session.error",
  "file.changed",
  "approval.pending",
  "browser.state",
] as const;

/** 主进程 → 渲染进程的推送通道（类型真源） */
export interface IpcEventMap {
  /** 会话视图更新（由 worker 投影而来） */
  "session.view": ConversationView;
  /** 会话状态变化：worker 进程启停与 Agent 运行态 */
  "session.status": { sessionId: string; state: SessionRunState };
  /** 会话错误 */
  "session.error": { sessionId: string; message: string };
  /** 文件改动（M2 接入） */
  "file.changed": { sessionId: string; change: ViewFileChange };
  /** 待审批的工具调用（新增或清空时推送全量） */
  "approval.pending": { sessionId: string; requests: ApprovalRequest[] };
  /** 内嵌浏览器视图状态变化（首次加载 / 导航 / 标题变化 / 销毁） */
  "browser.state": BrowserViewState;
}

export type IpcEventName = keyof IpcEventMap;
export type IpcEventPayload<E extends IpcEventName> = IpcEventMap[E];

/** 事件名的键对齐断言（同通道） */
export type EventParityChecked = [
  MustBeNever<Exclude<IpcEventName, (typeof IPC_EVENTS)[number]>>,
  MustBeNever<Exclude<(typeof IPC_EVENTS)[number], IpcEventName>>,
];

/**
 * 审批模式：
 *   - approval：只读白名单放行，其余都需确认；
 *   - auto：白名单放行 + 普通操作自动放行，仅高风险需确认；
 *   - full-access：一律放行（等价于旧的全权执行）。
 */
export type ApprovalMode = "approval" | "auto" | "full-access";

/** 风险档位 */
export type ApprovalRisk = "safe" | "moderate" | "dangerous";

/** 一条待审批的工具调用 */
export interface ApprovalRequest {
  /** 内核工具调用 ID，作为应答时的关联键 */
  toolCallId: string;
  sessionId: string;
  toolName: string;
  /** 完整入参，供用户展开查看 */
  argsJson: string;
  /** 一行可读摘要 */
  summary: string;
  risk: ApprovalRisk;
  /** 判定依据 */
  reason: string;
  /** 同类调用的签名，用于「不再询问」 */
  signature: string;
  requestedAt: number;
  /** 审批等待上限（毫秒），界面据此显示倒计时 */
  timeoutMs: number;
}

/** 规则类别：放行 or 拒绝 */
export type ApprovalRuleKind = "allow" | "deny";

/**
 * 供界面展示与管理的记忆规则视图。
 * 规则本体只存主进程内存，这里给出稳定 id 与人类可读描述，
 * 界面按 id 删除，不依赖内部数组下标。
 */
export interface ApprovalRuleView {
  /** 稳定标识，删除时回传 */
  id: string;
  kind: ApprovalRuleKind;
  toolName: string;
  /** tool：整个工具生效；signature：仅同参数签名生效 */
  scope: "tool" | "signature";
  /** scope 为 signature 时的原始命令/路径签名，供界面还原上下文 */
  signature?: string;
}

/** 用户对一条审批的处置 */
export interface ApprovalResolution {
  toolCallId: string;
  approved: boolean;
  /** 拒绝时给模型的说明，空则用默认文案 */
  reason?: string;
  /** 记住本次选择：signature 仅同签名免问，tool 整个工具免问 */
  remember?: "signature" | "tool";
  /** 记住拒绝：下次同类调用自动拒绝（与 remember 互斥语义） */
  deny?: "signature" | "tool";
}

/** 预加载脚本暴露给渲染进程的 API 形状 */
export interface BanyanApi {
  invoke<C extends IpcChannel>(channel: C, request: IpcRequest<C>): Promise<IpcResponse<C>>;
  on<E extends IpcEventName>(event: E, handler: (payload: IpcEventPayload<E>) => void): () => void;
}
