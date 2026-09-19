// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * main ↔ session worker 的进程间消息契约
 * worker 侧持有 harness/lane，向 main 投影稳定 DTO（渲染层零 pi 依赖）
 */

import type { ProviderBuildConfig } from "./provider-factory";
import type { ThinkingLevel } from "./thinking-level";
import type { ViewTodo } from "./todo";

/**
 * 待办清单的类型定义在 `@shared/todo`（纯契约 + 渲染，main / worker / 渲染层三方共用），
 * 这里只是转出去——读契约的人不必跳到另一个文件才知道 `todos` 里装的是什么。
 */
export type { ViewTodo };

/** 对话中的一条消息（投影后） */
export interface ViewMessage {
  id: string;
  /**
   * 只可能是这三种。**工具结果不在这里**——它不单独成条，走 `ViewToolResult`
   * （渲染层过去拿到 `role === "toolResult"` 就 `return null`，等于白传一份正文；
   * 视图是全量快照、每 50ms 重推，这种浪费要乘以推送次数）。
   */
  role: "user" | "assistant" | "other";
  text: string;
  /** 助手消息里的工具调用 */
  toolCalls: { id: string; name: string; args: string; durationMs?: number }[];
  /** 助手消息的思考过程（思考轨），无则为空 */
  thought?: string;
  /** 用户消息随附的图片（base64 不含 data URI 前缀），无则为空 */
  image?: { data: string; mimeType: string };
  timestamp?: number;
}

/** 工具执行结果（已完成） */
export interface ViewToolResult {
  /** 对应的 toolCallId */
  id: string;
  output: string;
  isError: boolean;
  /**
   * 该结果带图，但**图片不在视图里**：已由 worker 落盘，展开卡片时用
   * `session.toolOutput` 读回（命名与校验见 `@shared/tool-output`）。
   *
   * 为什么不留 base64：视图是**全量快照**，流式期间每 50ms 重推一次（`scheduleFlush`），
   * 一张几 MB 的截图会被反复序列化 + 跨进程搬运。落盘一次、按需读回，
   * 省的不只是首屏，而是**整个运行期间的重复搬运**。
   */
  hasImage?: boolean;
  /**
   * 内联图片，**只用于落不了盘的图片类型**（mime 认不出，见 `toolImageFileName`）——
   * 宁可这一条大一点，也不要让用户看不到图。能落盘的一律走 `hasImage`。
   */
  image?: { data: string; mimeType: string };
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

/**
 * 一个子代理（subagent）实例的总账。
 *
 * 为什么只带**有界尾部**而不是整份流：视图是**全量快照**，流式期间每 50ms 整份重推
 * （`worker/entry.ts` 的 `scheduleFlush`），N 个子代理的全文会按推送次数乘上去——
 * 与「工具截图不进视图、落盘按需读回」是同一条教训。完整流走 `session.subagentTranscript`
 * 按需拉（见 `@shared/protocol`）。
 *
 * ⚠️ 子代理的消息**不混进 `ConversationView.messages`**：`groupTurns` 只认 role，
 * 两条 lane 的消息混进去会被错并成同一轮。隔离靠独立承载，不靠渲染层猜。
 */
export interface ViewSubagent {
  /**
   * lane 名 = `sub:${agent}:${shortId}`，**稳定持久身份**。
   * 界面上用它取完整流（`session.subagentTranscript`）、中止单个子代理。
   */
  id: string;
  /** 主对话里那次 `subagent` 调用——④ 工具卡与「任务摘要」此刻段那一行的锚点 */
  toolCallId: string;
  /** agent 定义名（显示用） */
  name: string;
  /** 一句话任务摘要（缺省取 task 首行） */
  title: string;
  status: "running" | "completed" | "failed" | "aborted";
  startedAt: number;
  endedAt?: number;
  /** 仅 failed 时有值；摘要展示由渲染层负责 */
  error?: string;
  /** 运行中的**有界**尾部快照（视图每 50ms 全量重推，故必须有界） */
  tail: {
    streamingText: string | null;
    thought: string | null;
    runningTools: ViewRunningTool[];
    /** 最近 `MAX_SUBAGENT_STEPS_IN_VIEW` 步 */
    recentSteps: ViewMessage[];
    /** 真实总步数——截断时如实给总数，不许静默裁掉 */
    stepCount: number;
  };
  /** 子代理自己的消耗（费用计入会话；归属只在这里展示） */
  stats: { inputTokens: number; outputTokens: number; costUsd: number };
}

/**
 * 「本次会话第一次改动这个文件之前」的内容快照——净变化的**基线**。
 *
 * 内核每次只给「这一次改了什么」（patch），把一串增量加起来并**不等于**文件的最终样子：
 * 改完又退回原样的一串编辑相加是 `+10 −10`，而文件其实没变。要回答「这个文件最终
 * 被改成了什么」，就必须有「改之前是什么」——故 worker 在工具执行**前**抓这份快照
 * （见 `before_tool` 闸门）、随改动上报，由主进程落库。
 */
export interface FileBaseline {
  /** 改动前文件是否存在：false 表示这次是「新建」，净变化就是整份新增 */
  existed: boolean;
  /** 改动前的内容；null 表示未留存（文件过大 / 二进制 / 读取失败），净值因而算不出 */
  text: string | null;
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
  /**
   * 该文件在本次会话里的**净变化**（基线 → 现在），由**主进程**在改动落库时算好写库。
   * null = 算不出来（没有基线，或文件已读不到）——界面据此**不下结论**，而不是显示 0。
   * worker 不参与这件事，故它上报的改动里这两个字段恒为 null。
   */
  netAddedLines: number | null;
  netRemovedLines: number | null;
}

/**
 * 一轮**运行**的终态（C1）。投影自内核 `LaneSnapshot.lastResult`，只取 `kind === "run"` 的那些——
 * 压缩 / 导航的终态不该影响 ⑥ 上「这次任务怎么样了」这一问。
 *
 * ⚠️ 别拿 `faulted` 表达这件事：那是 harness 的 `fault` 事件（会话级硬故障，且内核从不复位它），
 * 与「这一轮跑完没有、怎么结束的」是两回事。终态只有 `run_end.status` 说得清：
 * 用户中断走 `session.abort` → `aborted`，异常 → `failed`，跑完 → `completed`。
 *
 * （`declined` 是终端状态的全集里的一员，属授权类操作；`run` 不会产出它，渲染层按「无特殊终态」处理。）
 */
export interface ViewRunOutcome {
  status: "completed" | "declined" | "aborted" | "failed";
  /** 仅 `failed` 时有值；摘要展示由渲染层负责 */
  error?: string;
}

/** 会话视图：渲染层唯一的数据结构 */
export interface ConversationView {
  sessionId: string;
  /*
   * 这里曾经还有 `lane` / `cwd` / `faulted`，三者都在 worker 里投影出来、推给主进程，
   * 然后**全仓没有一处读过**（渲染层、主进程都零读取）。空推的字段留在契约里是负债：
   *   - `faulted` 尤其危险——名字看着像「本轮失败了」，实际是 harness `fault` 事件的
   *     **会话级硬故障标记，且内核从不复位**（`ERRORS.md` §三、`AGENTS.md` §四 都记了这次翻车）。
   *     它留在契约里，等于给下一个想表达「任务失败」的人准备了一个现成的错误答案；
   *   - `lane` / `cwd` 则是「推了不用」，会让读契约的人以为这里有会话身份信息可依赖。
   * 需要它们时按真实需求重新加（并补上读取点），别顺手恢复。
   */
  model: string;
  /**
   * 当前模型是否支持图片输入。不支持时渲染层必须阻止发送图片并给出提示——
   * 否则适配器会按 `model.input.includes("image")` 静默丢弃图片，用户只看到"发了但 AI 没反应"。
   */
  imageInput: boolean;
  /**
   * 当前会话的思考等级。**必须由主进程显式下发**（不是内核对新 lane 的种子值）：
   * 内核只在新 lane 时套用种子，老会话会沿用自己持久化的值——而老会话存的 off
   * 会让不带工具的请求（压缩、审批）被「始终思考」的模型 400 掉。
   */
  thinkingLevel: ThinkingLevel;
  /**
   * 本会话装载到的技能**名字**（装载后固定，投影自 worker 装载时的清单）。
   *
   * 渲染层拿它在**本地**判「这个名字存不存在」，然后才决定发不发：名字打错时它**不清空输入**、
   * 把可用名报出来，用户改一个字母就能重敲。少了这个字段，渲染层只能先清空再发，
   * 那半句额外指示会跟着输入一起没掉（用户看得见的现象：打错一个字母，白敲一整句话）。
   *
   * ⚠️ 判据要按「**知道**才知道」来用：拿不到视图时（没有 worker / 还没上报，`view?.skills`
   * 就是 `undefined`）**不要**拦——那时候清单是**不知道**，不是「空的」，凭它拒绝会把一次
   * 有效调用误判成失败，那是**另一种丢输入**。
   */
  skills: string[];
  messages: ViewMessage[];
  /** toolCallId → 工具结果，供工具卡片展开时查阅 */
  toolResults: ViewToolResult[];
  /** 本会话累计的文件改动 */
  fileChanges: ViewFileChange[];
  /**
   * 本会话的待办清单（`todo` 工具维护）。
   *
   * **真源在主进程的库**（`todos` 表），这里这一份是主进程经本视图推给渲染层的那份；
   * worker 自己另有一份**镜像**，只用于每请求注入（见 `todoSnapshot` 命令）。
   * 空清单是 `[]`，不是「一列全是 pending 的幽灵清单」。
   */
  todos: ViewTodo[];
  /** 正在流式输出的助手文本，null 表示当前没有流 */
  streamingText: string | null;
  /** 正在流式输出的思考文本（思考轨），null 表示当前没有在思考 */
  thought: string | null;
  /** 正在执行的工具 */
  runningTools: ViewRunningTool[];
  /**
   * 本次会话里的子代理实例（`subagent` 工具委派的那些），按开始时间排列。
   *
   * 它是「任务摘要」此刻段与 ④ 子代理卡的**唯一**数据源（零新事件，搭 `session.view` 顺风车）。
   * `tail` 有界（见 `ViewSubagent`）；完整流按需拉。
   */
  subagents: ViewSubagent[];
  /** 是否有进行中的操作 */
  running: boolean;
  /**
   * 最近一轮运行的终态；`null` = 本会话还没跑过任何一轮。
   * ⑥ 据此把「空闲 / 已中断 / 已失败」分开（C1）——正常跑完（`completed`）与「没跑过」一样回到「空闲」，
   * 只有中断与失败才值得在状态条上单独留一行。
   */
  lastRun: ViewRunOutcome | null;
  /** 排队中的消息条数（steer / followUp） */
  queuedCount: number;
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

/**
 * 宿主能力标识：由主进程（Electron GUI 侧）实现，worker 通过 toolRpc 远程调用。
 * 浏览器/桌面这类能力必须由宿主进程持有（窗口与 OS 权限），故 worker 只能发命令。
 */
export type HostCapability = "browser" | "computer" | "memory" | "todo";

/** 一次宿主能力的调用返回：文本 + 可选图片（截图等） */
export interface HostResult {
  /** 给模型与界面看的文本 */
  text: string;
  /** 图片结果，base64 不含 data URI 前缀 */
  image?: { data: string; mimeType: string };
}

/**
 * 模型向用户提的一个问题（`ask_user` 工具）。
 *
 * 上限不是随手定的：`MAX_QUESTIONS` / `MAX_OPTIONS` 与界面一屏能放下多少直接相关，
 * `header` 长度限制是为了让多题分组标题不换行。校验在 worker 侧做（见
 * `worker/lib/ask-user-tool.ts`），主进程只做转发、不重复校验。
 */
export interface AskUserQuestion {
  question: string;
  /** 短标签（≤12 字符），多题时作为分组标题；单题可省 */
  header?: string;
  /** 2~4 个选项 */
  options: { label: string; description: string }[];
  multiSelect?: boolean;
}

/** 用户跳过了提问——必须区分是超时还是中断，两者的文案与后续动作不同 */
/**
 * 没拿到答案的原因。三档都必须是**如实**的：模型据此决定怎么继续，
 * 把「用户点了跳过」说成「对话被中断」就是撒谎（`docs/ERRORS.md`）。
 */
export type AskUserSkipReason = "timeout" | "skipped" | "cancelled";

/** main → worker */
export type WorkerCommand =
  | {
      type: "init";
      sessionsRoot: string;
      cwd: string;
      /** Colt 自有的会话 ID，投影与路由均以它为准 */
      externalSessionId: string;
      /** 内核 JSONL 会话 ID，有则续接历史，无则新建 */
      kernelSessionId?: string;
      provider: ProviderBuildConfig;
      model: string;
      /** 思考等级；主进程已按「会话存值 → 默认值」收敛过，worker 原样下发 */
      thinkingLevel: ThinkingLevel;
      /**
       * 工具图片的落盘目录（绝对路径，由主进程按会话算好下发）。
       *
       * 为什么由主进程给：路径一旦由渲染层指定就等于把任意读盘交出去，
       * 而 worker 也无从知道 userData 在哪。目录里放的是 `<toolCallId>.<ext>`，
       * 主进程据此读回、会话删除时整目录清掉。
       */
      toolOutputDir: string;
    }
  | { type: "prompt"; text: string; images?: { data: string; mimeType: string }[] }
  | { type: "steer"; text: string; images?: { data: string; mimeType: string }[] }
  | { type: "abort" }
  | { type: "setModel"; provider: ProviderBuildConfig; modelId: string }
  | { type: "setThinkingLevel"; level: ThinkingLevel }
  | { type: "compact" }
  /**
   * 显式调用一个技能：内核按名从 `resources.skills` 取出**整份正文**，作为一条 user 消息发出
   * （不只是提示词里那份清单）。名字不存在时**不回落**成普通提问——worker 回一条可见报错并
   * 列出可用名：技能名是用户在磁盘上自己定的，打错时必须给回正确写法（见 `@shared/skill-error`）。
   */
  | { type: "skill"; name: string; instructions?: string }
  /**
   * 显式整理记忆（/memory-tidy）：worker 在独立子 lane 跑一轮「合并重复、删过时」，
   * 需要时重写项目记忆文件。与 compact 的区别：不重写对话，只整记忆文件；
   * 子 lane 的消耗不计入会话统计（telemetry 只采主 lane）。主 lane 忙时拒绝（文件竞态）。
   */
  | { type: "memoryTidy" }
  /**
   * 中止**单个**子代理（`ViewSubagent.id` = lane 名）。不动主对话、不动别的子代理——
   * 用户看得见某个子代理跑偏了要能就地收掉它，而不是只能中断整个会话。
   */
  | { type: "subagentAbort"; id: string }
  /**
   * 按需拉一个子代理的**完整流**（视图只带有界尾部，见 `ViewSubagent`）。
   * 与 `branches` 同形：worker 以消息形式回复，主进程排队兑现。
   */
  | { type: "subagentTranscript"; id: string }
  | { type: "branches" }
  | { type: "navigate"; targetId: string }
  /**
   * 用户手动操作了浏览器（B1：后退 / 前进 / 刷新），把这件事告知 agent。
   *
   * 与 `steer` 的区别是**它不是用户说的话、也不该触发新一轮运行**：
   * worker 把它暂存，在下一次模型请求前用内核的 `transform_context` 注入，
   * 因此不落进 transcript（对话与分支树不会凭空多出一轮）。
   */
  | { type: "browserNotice"; text: string }
  /**
   * 待办清单镜像（主进程 → worker）。
   *
   * 为什么要有这条：worker 侧 `transform_context` 是**同步**的，要在每请求前把清单拼进
   * 系统提示词就必须手里有一份现成的——若改成在模型请求的热路径上现拉一次 RPC，
   * 延迟与失败模式都更差（`DESIGN-todo.md` §3 决策四）。故主进程每次写入后整份推一遍，
   * worker 只做覆盖。**它只是缓存，真源是主进程的库**。
   *
   * worker（重）启动时由主进程在 `ready` 之后补发一次——否则模型看不到已有清单，
   * 而清单还好好地在界面上，用户完全看不出模型已经忘了它。
   */
  | { type: "todoSnapshot"; todos: ViewTodo[] }
  /** 主进程对一条审批的答复，worker 据此决定放行还是阻断 */
  | { type: "approvalResult"; toolCallId: string; approved: boolean; reason?: string }
  /**
   * 主进程对一次提问的答复。
   *
   * ⚠️ **必须与审批分开**：审批的默认值是「放行」（`auto` / `full-access` 模式会静默批准），
   * 而提问的默认值必须是「没答案」——走审批通道的话，用户切到全权模式后模型每次提问都会
   * 收到一个「已通过」而不是答案，那比没有提问工具更糟：它会持续撒谎。
   */
  | {
      type: "askUserResult";
      toolCallId: string;
      /** 问题 → 所选 label（多选时以「、」分隔）；skipped 时无值 */
      answers?: Record<string, string>;
      skipped?: AskUserSkipReason;
    }
  /** 主进程对一次宿主能力调用的答复（成功） */
  | { type: "toolRpcResult"; requestId: string; ok: true; result: HostResult }
  /** 主进程对一次宿主能力调用的答复（失败） */
  | { type: "toolRpcResult"; requestId: string; ok: false; error: string }
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
  /**
   * 一次文件改动。`baseline` 只在该文件**本次会话的第一次**改动时携带（worker 按路径去重），
   * 那次之后的改动不再重发全文——主进程按 (session, path) 只认最早的一份（见 `recordFileBaseline`）。
   */
  | { type: "fileChange"; change: ViewFileChange; baseline?: FileBaseline }
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
  /**
   * 一个子代理的完整流（`subagentTranscript` 命令的回复）。
   * `id` 原样带回，主进程据此配对等待方（FIFO）。
   */
  | { type: "subagentTranscript"; id: string; messages: ViewMessage[]; toolResults: ViewToolResult[] }
  /** 工具需要审批：worker 已阻塞在 before_tool，等主进程回 approvalResult */
  | {
      type: "approvalRequest";
      toolCallId: string;
      toolName: string;
      /** 完整入参的 JSON 串；无法序列化时为 "{}" */
      argsJson: string;
      /** 审批等待上限（毫秒），主进程与界面据此显示倒计时 */
      timeoutMs: number;
      /**
       * 这次调用来自哪个子代理（主 lane 的调用没有这个字段）。
       * 界面据此在阻塞卡上标「来自 X」——否则用户分不清是谁在请求授权。
       */
      subagent?: { id: string; name: string };
    }
  /**
   * 模型提问：worker 已阻塞在 `ask_user` 的 execute 里，等主进程回 askUserResult。
   * 与 approvalRequest 同形不同义——它不受审批策略管辖，任何模式下都必须由人来答。
   */
  | {
      type: "askUserRequest";
      toolCallId: string;
      /** 已过校验的问卷（校验在 worker 侧，主进程不重复校验） */
      questions: AskUserQuestion[];
      timeoutMs: number;
      /** 同 approvalRequest：来自哪个子代理（主 lane 的提问没有这个字段） */
      subagent?: { id: string; name: string };
    }
  | { type: "modelChanged"; providerId: string; modelId: string }
  /** worker 请求宿主能力（浏览器/桌面）：主进程执行后回 toolRpcResult */
  | {
      type: "toolRpc";
      requestId: string;
      capability: HostCapability;
      action: string;
      params: Record<string, unknown>;
    }
  /**
   * 记忆文件快照上报：worker 每请求重读记忆文件，内容变化即发整份快照
   * （null = 文件不存在，等于把该文件的现行条目归档进冷层）。
   * 检索索引是文件内容的派生物，文件才是真源；来源路径由主进程按 scope
   * 自行推算（项目级用会话 cwd），不信任 worker 报的路径。
   */
  | { type: "memoryIndex"; scope: "project" | "user"; content: string | null }
  | { type: "error"; message: string; fatal: boolean }
  /**
   * 非错误通知：主进程原样转成 session.notice 推给渲染层。
   * kind 分流（F3）："security" 是 SECURITY.md 承诺「如实告知」的安全事件——技能装载
   * 告警、同名技能/子代理定义覆盖、AGENTS.md 与记忆读取失败等。它们**另外落库**
   * （session_events 表），toast 5 秒消失后仍可在「事件」页签回查；缺省 info 是
   * 瞬时操作反馈（压缩完成等），只走 toast 不留痕。
   */
  | { type: "notice"; message: string; kind?: "security" }
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
