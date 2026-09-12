/**
 * main ↔ session worker 的进程间消息契约
 * worker 侧持有 harness/lane，向 main 投影稳定 DTO（渲染层零 pi 依赖）
 * 作者：陕耀云栈WorkMate
 */

/** 对话中的一条消息（投影后） */
export interface ViewMessage {
  id: string;
  role: "user" | "assistant" | "toolResult" | "other";
  text: string;
  /** 助手消息里的工具调用 */
  toolCalls: { id: string; name: string; args: string }[];
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
  };
}

/** 模型选项（与 protocol 保持一致，避免 worker 反向依赖） */
export interface WorkerModelOption {
  id: string;
  name: string;
  contextWindow: number;
}

/** worker 启动所需的 provider 配置 */
export interface WorkerProviderConfig {
  id: string;
  name: string;
  kind: "deepseek" | "openai-compatible";
  baseUrl: string;
  models: WorkerModelOption[];
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
      provider: WorkerProviderConfig;
      model: string;
    }
  | { type: "prompt"; text: string }
  | { type: "steer"; text: string }
  | { type: "abort" }
  | { type: "setModel"; provider: WorkerProviderConfig; modelId: string }
  | { type: "compact" }
  | { type: "branches" }
  | { type: "navigate"; targetId: string }
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
  | { type: "branches"; nodes: WorkerBranchNode[] }
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
