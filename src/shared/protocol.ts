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
  "session.branches",
  "session.navigate",
  "git.status",
  "browser.bounds",
  "browser.state.get",
] as const;

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
  /** 读取审批模式（省略 sessionId 时为全局默认） */
  "approval.mode.get": {
    request: { sessionId?: string };
    response: { mode: ApprovalMode };
  };
  /** 切换审批模式（省略 sessionId 时改全局默认，否则仅改该会话） */
  "approval.mode.set": {
    request: { mode: ApprovalMode; sessionId?: string };
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
