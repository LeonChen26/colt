/**
 * main ↔ session worker 的进程间消息契约
 * worker 侧持有 harness/lane，向 main 投影稳定 DTO（渲染层零 pi 依赖）
 */

import type { ProviderBuildConfig } from "./provider-factory";

/** 对话中的一条消息（投影后） */
export interface ViewMessage {
  id: string;
  role: "user" | "assistant" | "toolResult" | "other";
  text: string;
  /** 助手消息里的工具调用 */
  toolCalls: { id: string; name: string; args: string; durationMs?: number }[];
  /** 助手消息的思考过程（思考轨），无则为空 */
  thought?: string;
  timestamp?: number;
}

/** 工具执行结果（已完成） */
export interface ViewToolResult {
  /** 对应的 toolCallId */
  id: string;
  output: string;
  isError: boolean;
}

/** 正在执行的工具 */
export interface ViewRunningTool {
  id: string;
  name: string;
  /** 工具入参的 JSON 字符串；渲染层据此展示运行中的命令、路径等 */
  args: string;
  /** 已产生的输出（内核推的是全量快照，非增量） */
  output: string;
  /** 输出被截断时的完整日志落盘路径 */
  fullOutputPath?: string;
  startedAt: number;
}

/** 一次文件改动 */
export interface ViewFileChange {
  id: string;
  /** 相对于工作目录的路径 */
  path: string;
  kind: "write" | "edit";
  /** edit 工具产出的标准 unified patch；write 无 patch */
  patch: string | null;
  addedLines: number;
  removedLines: number;
  timestamp: number;
}

/** 会话视图：渲染层唯一的数据结构 */
export interface ConversationView {
  sessionId: string;
  lane: string;
  cwd: string;
  model: string;
  messages: ViewMessage[];
  /** toolCallId → 工具结果，供工具卡片展开时查阅 */
  toolResults: ViewToolResult[];
  /** 本会话累计的文件改动 */
  fileChanges: ViewFileChange[];
  /** 正在流式输出的助手文本，null 表示当前没有流 */
  streamingText: string | null;
  /** 正在流式输出的思考文本（思考轨），null 表示当前没有在思考 */
  thought: string | null;
  /** 正在执行的工具 */
  runningTools: ViewRunningTool[];
  /** 是否有进行中的操作 */
  running: boolean;
  /** 排队中的消息条数（steer / followUp） */
  queuedCount: number;
  faulted: boolean;
  stats: {
    messageCount: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number;
    /**
     * 当前上下文占用：最近一轮主 lane 非 adjustment 调用的 prompt tokens
     * （input + cacheRead + cacheWrite）。累计的 totalTokens 不能用作上下文占用，
     * 它随轮次二次增长，几个问题就能把进度条顶满。
     */
    contextUsed: number;
  };
}

/** main → worker */
export type WorkerCommand =
  | {
      type: "init";
      sessionsRoot: string;
      cwd: string;
      /** Banyan 自有的会话 ID，投影与路由均以它为准 */
      externalSessionId: string;
      /** 内核 JSONL 会话 ID，有则续接历史，无则新建 */
      kernelSessionId?: string;
      provider: ProviderBuildConfig;
      model: string;
    }
  | { type: "prompt"; text: string }
  | { type: "steer"; text: string }
  | { type: "abort" }
  | { type: "setModel"; provider: ProviderBuildConfig; modelId: string }
  | { type: "compact" }
  | { type: "branches" }
  | { type: "navigate"; targetId: string }
  /** 主进程对一条审批的答复，worker 据此决定放行还是阻断 */
  | { type: "approvalResult"; toolCallId: string; approved: boolean; reason?: string }
  | { type: "dispose" };

/** worker → main */
export type WorkerMessage =
  | {
      type: "ready";
      externalSessionId: string;
      /** 实际使用的内核会话 ID，主进程需持久化以便下次续接 */
      kernelSessionId: string;
      cwd: string;
      model: string;
    }
  | { type: "view"; view: ConversationView }
  | { type: "fileChange"; change: ViewFileChange }
  | {
      type: "usage";
      /** 内核 usage 行的稳定 ID，作为幂等键，防事件重放 */
      kernelUsageId: string;
      /** 本次记录对应的 provider/model（"providerId/modelId" 拆分后的两段） */
      provider: string;
      model: string;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      costUsd: number;
      /** 该条 usage 对应的时间戳（毫秒） */
      timestamp: number;
    }
  | {
      type: "toolCall";
      /** 内核工具调用 ID，天然唯一，作为数据库主键 */
      toolCallId: string;
      /** 所属运行 ID，用于按一次运行聚合 */
      runId: string;
      toolName: string;
      /** 工具入参的 JSON 字符串，无法序列化时为 null */
      inputJson: string | null;
      isError: boolean;
      /** 仅当配到 tool_start 时才有值 */
      durationMs: number | null;
      timestamp: number;
    }
  | { type: "branches"; nodes: WorkerBranchNode[] }
  /** 工具需要审批：worker 已阻塞在 before_tool，等主进程回 approvalResult */
  | {
      type: "approvalRequest";
      toolCallId: string;
      toolName: string;
      /** 完整入参的 JSON 串；无法序列化时为 "{}" */
      argsJson: string;
      /** 审批等待上限（毫秒），主进程与界面据此显示倒计时 */
      timeoutMs: number;
    }
  | { type: "modelChanged"; providerId: string; modelId: string }
  | { type: "error"; message: string; fatal: boolean }
  | { type: "log"; message: string };

/** 分支树节点（投影后） */
export interface WorkerBranchNode {
  id: string;
  parentId: string | null;
  kind: string;
  summary: string;
  timestamp: number;
  onActivePath: boolean;
  isTip: boolean;
}
