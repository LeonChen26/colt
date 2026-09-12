/**
 * Banyan IPC 契约（单一真源）
 * 主进程、预加载、渲染进程共享此定义。
 * 作者：陕耀云栈WorkMate
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

/** 项目 */
export interface Project {
  id: string;
  name: string;
  rootPath: string;
  createdAt: number;
  lastOpenedAt: number;
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
export type SessionRunState = "idle" | "running";

/** 渲染进程 → 主进程的调用通道 */
export interface IpcInvokeMap {
  "env.check": {
    request: void;
    response: EnvReport;
  };
  "app.info": {
    request: void;
    response: { version: string; userDataPath: string };
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
    request: { sessionId: string; text: string };
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

/** 主进程 → 渲染进程的推送通道 */
export interface IpcEventMap {
  /** 会话视图更新（由 worker 投影而来） */
  "session.view": ConversationView;
  /** 会话运行状态变化 */
  "session.status": { sessionId: string; state: SessionRunState };
  /** 会话错误 */
  "session.error": { sessionId: string; message: string };
  /** 文件改动（M2 接入） */
  "file.changed": { sessionId: string; change: ViewFileChange };
}

export type IpcEventName = keyof IpcEventMap;
export type IpcEventPayload<E extends IpcEventName> = IpcEventMap[E];

/** 预加载脚本暴露给渲染进程的 API 形状 */
export interface BanyanApi {
  invoke<C extends IpcChannel>(channel: C, request: IpcRequest<C>): Promise<IpcResponse<C>>;
  on<E extends IpcEventName>(event: E, handler: (payload: IpcEventPayload<E>) => void): () => void;
}

/** 全部合法的调用通道名，用于预加载白名单校验 */
export const IPC_CHANNELS = [
  "env.check",
  "app.info",
  "project.pick",
  "project.list",
  "session.create",
  "session.list",
  "session.open",
  "session.prompt",
  "session.abort",
  "session.close",
  "session.view",
  "secrets.status",
  "secrets.set",
  "changes.list",
  "usage.list",
  "providers.list",
  "providers.save",
  "providers.remove",
  "session.setModel",
  "session.steer",
  "session.compact",
  "session.branches",
  "session.navigate",
] as const satisfies readonly IpcChannel[];

/** 全部合法的事件名 */
export const IPC_EVENTS = [
  "session.view",
  "session.status",
  "session.error",
  "file.changed",
] as const satisfies readonly IpcEventName[];
