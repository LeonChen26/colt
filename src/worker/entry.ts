/**
 * Session Worker：每会话一个 utilityProcess
 * 持有 harness / lane / 会话存储，向 main 投影 ConversationView
 * 形态参考官方 packages/coding-agent/src/experimental/mini/worker/run.ts
 */
import {
  AgentHarness,
  BACKGROUND_CONTEXT,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  JsonlSessionRepo,
  reduceLaneSnapshot,
  type AgentLane,
  type Context,
  type JsonlSessionMetadata,
  type LaneSnapshot,
  type Session,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createModels, type ImageContent } from "@earendil-works/pi-ai";
import type {
  ConversationView,
  FileBaseline,
  ViewFileChange,
  ViewMessage,
  ViewRunOutcome,
  ViewRunningTool,
  ViewToolResult,
  WorkerBranchNode,
  WorkerCommand,
  WorkerMessage,
} from "@shared/worker-protocol";
import { buildProvider } from "@shared/provider-factory";
import { READONLY_TOOLS } from "@shared/readonly-tools";

import { randomUUID } from "node:crypto";
import {
  countPatchLines,
  extractImage,
  extractText,
  extractThinking,
  extractToolCalls,
  extractToolText,
  projectBranchNodes,
  toRelative,
  type BranchEntry,
} from "./lib/project";
import { HostBridge } from "./lib/host-bridge";
import { captureBaseline } from "./lib/baseline";
import { createBrowserTools } from "./lib/browser-tool";
import { createComputerTools } from "./lib/computer-tool";
import {
  ToolCallTracker,
  buildUsageUpload,
  contextUsedFromUsage,
  serializeArgs,
} from "./lib/telemetry";

const context: Context = BACKGROUND_CONTEXT;

/**
 * 审批往返：worker 发起请求后阻塞，等主进程的 approvalResult。
 * 主进程持有策略与用户界面，worker 只负责阻塞与执行结果。
 */
/** 启用 COLT_APPROVAL_DEBUG=1 时输出审批链路日志（排查安全功能为何未生效时用） */
function trace(message: string): void {
  if (process.env.COLT_APPROVAL_DEBUG === "1") {
    process.stderr.write(`[approval] ${message}\n`);
  }
}

const pendingApprovals = new Map<
  string,
  { resolve: (value: { approved: boolean; reason: string }) => void; timer: NodeJS.Timeout }
>();

/** 审批等待上限；超时视为拒绝，避免 lane 永久挂起 */
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

/** 已完成的工具调用耗时（toolCallId → ms），供工具卡片展示；有上限避免无界增长 */
const toolDurations = new Map<string, number>();
const TOOL_DURATION_LIMIT = 512;

/**
 * 用户手动操作浏览器（前进 / 后退 / 刷新）的提示队列，等下一次模型请求前注入。
 *
 * 不直接 `send` 给界面、也不走 `steer`：它既不是用户发言、也不该触发新一轮运行，
 * 只是告诉模型「你手里那份页面状态已经过期了」。注入点与理由见 init 里的 transform_context。
 */
const pendingBrowserNotices: string[] = [];

function rememberDuration(toolCallId: string, durationMs: number | null): void {
  if (durationMs === null) return;
  if (toolDurations.size >= TOOL_DURATION_LIMIT) {
    const oldest = toolDurations.keys().next().value;
    if (oldest !== undefined) toolDurations.delete(oldest);
  }
  toolDurations.set(toolCallId, durationMs);
}

function requestApproval(
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ approved: boolean; reason: string }> {
  let argsJson = "{}";
  try {
    argsJson = JSON.stringify(args ?? {});
  } catch {
    argsJson = "{}";
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(toolCallId);
      resolve({ approved: false, reason: "审批超时，已自动拒绝。如需执行请重新发起。" });
    }, APPROVAL_TIMEOUT_MS);
    // 不阻止进程退出
    timer.unref?.();

    pendingApprovals.set(toolCallId, { resolve, timer });
    trace(`已发出请求 ${toolName} ${toolCallId}`);
    send({ type: "approvalRequest", toolCallId, toolName, argsJson, timeoutMs: APPROVAL_TIMEOUT_MS });
  });
}

/** 主进程答复到达，唤醒对应的阻塞 */
function settleApproval(toolCallId: string, approved: boolean, reason?: string): void {
  const entry = pendingApprovals.get(toolCallId);
  if (entry === undefined) return;
  pendingApprovals.delete(toolCallId);
  clearTimeout(entry.timer);
  entry.resolve({
    approved,
    reason: reason ?? "用户拒绝了这次工具调用。请换一种做法，或先向用户说明原因。",
  });
}

function send(message: WorkerMessage): void {
  process.parentPort?.postMessage(message);
}

/** 宿主能力客户端：浏览器/桌面的实际执行在主进程，这里只发命令等结果 */
const hostBridge = new HostBridge(send);

function systemPrompt(cwd: string): string {
  return [
    "你是 Colt 桌面工作台中的编码助手，运行在用户的本地项目里。",
    `当前工作目录：${cwd}`,
    "可以使用 read / write / edit / bash 工具查看和修改文件。",
    "可以使用浏览器工具：browser_read 读取页面（snapshot 返回带 ref 的可交互元素），browser_act 打开/点击/输入/滚动，browser_screenshot 截图。操作网页前先用 snapshot 获取 ref。",
    "可以使用电脑控制工具操作桌面应用：computer_screenshot 截取整个屏幕，computer_action 点击/输入/按键/滚动。每次操作前必须先 computer_screenshot，并基于画面坐标操作；操作后再次截图确认。",
    "动手前先用一句话说明你要做什么，保持简洁、技术化。",
    "【输出语言】始终用中文回复。即使用户消息、文件内容或命令输出含有英文，你的叙述部分也必须是中文；",
    "代码、路径、命令、报错原文保持原样不要翻译。",
  ].join("\n");
}

/** 渲染层传来的附件是不带 type 的精简结构，这里补成内核要求的 ImageContent */
function toImageContent(
  images?: { data: string; mimeType: string }[],
): ImageContent[] | undefined {
  if (!images || images.length === 0) return undefined;
  return images.map((image) => ({ type: "image", ...image }));
}

/** 把 LaneSnapshot 投影成渲染层可直接消费的 DTO */
/**
 * 把内核的「最近一次操作结果」投影成 ⑥ 需要的**运行终态**（C1）。
 *
 * 只认 `kind === "run"`：压缩 / 导航也会写 `lastResult`，但它们在状态条上答非所问
 * （用户问的是「我刚交办的那件事怎么样了」）。没有跑过、或最近一次是别的操作 → `null` → 「空闲」。
 */
function projectLastRun(result: LaneSnapshot["lastResult"]): ViewRunOutcome | null {
  if (result === undefined || result.kind !== "run") return null;
  return {
    status: result.status,
    ...(result.error !== undefined ? { error: result.error.message } : {}),
  };
}

function project(
  snapshot: LaneSnapshot,
  meta: {
    sessionId: string;
    cwd: string;
    model: string;
    /** 当前模型是否支持图片输入（取自模型目录的 input 能力），决定界面能否发图 */
    imageInput: boolean;
    fileChanges: ViewFileChange[];
    /** 最近一轮上下文占用，由 usage 事件维护；重启后由主进程用 DB 回填 */
    contextUsed: number;
  },
): ConversationView {
  const messages: ViewMessage[] = [];
  const toolResults: ViewToolResult[] = [];

  for (const entry of snapshot.transcript) {
    if ((entry as { type?: string }).type !== "message") continue;
    const record = entry as unknown as {
      id: string;
      message: { role: string; content: unknown; timestamp?: number };
    };
    const role = record.message.role;

    // toolResult 消息另存一份，供工具卡片展开时按 toolCallId 查阅
    // 注意：toolCallId 在 message 层级，content 是扁平的文本/图片块
    if (role === "toolResult") {
      const result = record.message as unknown as {
        toolCallId?: string;
        content?: unknown;
        isError?: boolean;
      };
      if (typeof result.toolCallId === "string") {
        toolResults.push({
          id: result.toolCallId,
          output: extractText(result.content),
          isError: Boolean(result.isError),
          // 截图等图片结果另存一份，供工具卡片直接展示
          image: extractImage(result.content),
        });
      }
    }

    messages.push({
      id: record.id,
      role:
        role === "user" || role === "assistant" || role === "toolResult"
          ? (role as ViewMessage["role"])
          : "other",
      text: extractText(record.message.content),
      // 用户随消息发送的图片回显到对话里；与工具截图同源，均为不含前缀的 base64
      image: role === "user" ? extractImage(record.message.content) : undefined,
      toolCalls:
        role === "assistant"
          ? extractToolCalls(record.message.content).map((call) => ({
              ...call,
              durationMs: toolDurations.get(call.id),
            }))
          : [],
      thought: role === "assistant" ? extractThinking(record.message.content) || undefined : undefined,
      timestamp: record.message.timestamp,
    });
  }

  const operation = snapshot.operation;
  const streamingText = operation?.streamingMessage
    ? extractText(operation.streamingMessage.content)
    : null;
  const streamingThought = operation?.streamingMessage
    ? extractThinking(operation.streamingMessage.content)
    : "";

  const runningTools: ViewRunningTool[] = (operation?.runningTools ?? []).map((tool) => {
    const record = tool as unknown as {
      toolCallId?: string;
      id?: string;
      toolName?: string;
      name?: string;
      args?: unknown;
      startedAt?: number;
      result?: unknown;
    };
    const details = (record.result as { details?: { fullOutputPath?: string } } | undefined)?.details;
    return {
      id: record.toolCallId ?? record.id ?? "",
      name: record.toolName ?? record.name ?? "",
      // 内核在 runningTools 上已经带上了入参，序列化后供渲染层实时展示命令
      args: serializeArgs(record.args) ?? "{}",
      // bash 等工具在运行中会不断把全量输出快照写回 result
      output: extractToolText(record.result),
      fullOutputPath: details?.fullOutputPath,
      startedAt: record.startedAt ?? Date.now(),
    };
  });

  const usage = snapshot.stats?.usage;
  return {
    sessionId: meta.sessionId,
    lane: snapshot.lane,
    cwd: meta.cwd,
    model: meta.model,
    imageInput: meta.imageInput,
    messages,
    toolResults,
    fileChanges: meta.fileChanges,
    streamingText: streamingText && streamingText.length > 0 ? streamingText : null,
    thought: streamingThought.length > 0 ? streamingThought : null,
    runningTools,
    // operation 非 null 即为「有一次 run/compaction/navigation 正在飞行」：
    // 内核 reducer 在 *_start 时写入该对象，在 *_end 时才置回 null。
    // 注意不要看 operation.status —— OperationStatus 只有 running|open|aborting，
    // 而 run_start 写入的恰是 "open"（表示「进行中的操作」而非「已完成」），
    // 用它判定会把整个运行期误判为空闲。
    running: operation !== null,
    lastRun: projectLastRun(snapshot.lastResult),
    queuedCount: snapshot.queues?.length ?? 0,
    faulted: Boolean(snapshot.faulted),
    stats: {
      messageCount: snapshot.stats?.messageCount ?? 0,
      inputTokens: usage?.input ?? 0,
      outputTokens: usage?.output ?? 0,
      totalTokens: usage?.totalTokens ?? 0,
      costUsd: usage?.cost?.total ?? 0,
      contextUsed: meta.contextUsed,
    },
  };
}

async function openSession(
  repo: JsonlSessionRepo,
  kernelSessionId: string | undefined,
  cwd: string,
): Promise<Session<JsonlSessionMetadata>> {
  if (kernelSessionId === undefined) return repo.create({ cwd }, context);
  const metadata = (await repo.list(undefined, context)).find((item) => item.id === kernelSessionId);
  // 找不到历史会话时退回新建，避免整个会话打不开
  if (!metadata) return repo.create({ cwd }, context);
  return repo.open(metadata, context);
}

interface WorkerState {
  harness: Awaited<ReturnType<typeof AgentHarness.create>>["harness"];
  lane: AgentLane;
  repo: JsonlSessionRepo;
  session: Session<JsonlSessionMetadata>;
  models: ReturnType<typeof createModels>;
  providerId: string;
  snapshot: LaneSnapshot;
  /** 结构性变更（分支跳转、压缩）后需要重建快照 */
  resnapshot: () => Promise<LaneSnapshot>;
  meta: {
    sessionId: string;
    cwd: string;
    model: string;
    imageInput: boolean;
    fileChanges: ViewFileChange[];
    contextUsed: number;
  };
  unsubscribe: () => void;
}

/** 把全部条目投影成分支树（session 级扫描，含所有分支）。
 *  只保留用户输入、各轮最终回复与结构节点，折叠中间的 LLM 轮次与工具调用。 */
async function projectBranches(current: WorkerState): Promise<WorkerBranchNode[]> {
  const entries = await current.session.findEntries({ order: "asc" }, context);
  const tipId = await current.lane.getTipId(context);
  return projectBranchNodes(entries as unknown as BranchEntry[], tipId ?? null);
}

let state: WorkerState | undefined;
/** 流式期间合并推送，避免每个 token 一次 IPC */
let flushTimer: NodeJS.Timeout | undefined;

function scheduleFlush(): void {
  if (flushTimer || !state) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    if (state) send({ type: "view", view: project(state.snapshot, state.meta) });
  }, 50);
}

async function init(command: Extract<WorkerCommand, { type: "init" }>): Promise<void> {
  const { cwd, sessionsRoot, model: modelId, provider: providerConfig } = command;

  const models = createModels();
  models.setProvider(buildProvider(providerConfig));
  const model = models.getModel(providerConfig.id, modelId);
  if (!model) throw new Error(`模型不可用：${providerConfig.id}/${modelId}`);

  const executionEnv = new NodeExecutionEnv({ cwd });
  const repo = new JsonlSessionRepo({ fileSystem: executionEnv, sessionsRoot });
  const session = await openSession(repo, command.kernelSessionId, cwd);

  const { harness, open } = await AgentHarness.create(
    {
      session,
      models,
      model,
      tools: [
        createReadTool(),
        createWriteTool(),
        createEditTool(),
        createBashTool(),
        ...createBrowserTools(hostBridge),
        ...createComputerTools(hostBridge),
      ],
      toolContext: { env: executionEnv },
      systemPrompt: systemPrompt(cwd),
    },
    context,
  );

  // 审批闸门：每个工具执行前问一次主进程。
  // handler 返回 Promise，内核会 await，期间整条 lane 挂起；
  // 抛错会被内核转成 block，所以超时/异常的默认结果是拦截而非放行。
  const gatedToolCalls = new Set<string>();
  /**
   * 改动前的内容快照，按 toolCallId 暂存到 after_tool——净值（基线 → 现在）就靠它。
   *
   * 读盘**必须在工具执行之前**：after_tool 时文件已经是新内容，那时再读只会得到
   * 「改完的样子」，净值恒为 0（而且不会报错，只会让界面一直说「已还原」）。
   * 抓取放在闸门内、**等审批之前**：审批可能等很久，越晚读越可能读到别人写过的内容。
   */
  const pendingBaselines = new Map<string, FileBaseline>();
  /** 已经报过基线的路径：同一文件后续改动只报增量，不重发全文（主进程也按「最早那份」为准） */
  const baselineSent = new Set<string>();
  harness.hooks.on("before_tool", async (event) => {
    gatedToolCalls.add(event.toolCallId);
    if (
      (event.toolName === "edit" || event.toolName === "write") &&
      typeof event.args.path === "string"
    ) {
      pendingBaselines.set(event.toolCallId, captureBaseline(cwd, event.args.path));
    }
    trace(`hook 触发 ${event.toolName} ${event.toolCallId}`);
    const decision = await requestApproval(event.toolCallId, event.toolName, event.args);
    trace(`得到答复 ${event.toolName} approved=${decision.approved}`);
    if (decision.approved) return undefined;
    // terminate 不置位：只拦这一次调用，让模型知悉后自行调整，不终止整个对话
    return { block: { reason: decision.reason } };
  });

  // 用户手动操作浏览器（前进 / 后退 / 刷新）→ 告知 agent。
  //
  // 用 transform_context 而不是 steer / prompt：这两种都会**开启或插入一轮**，让 agent 去回应，
  // 而这里要的只是「它下次看页面之前先知道自己看到的那份可能过期了」。
  // transform_context 是内核为此准备的扩展点（按注释：把应用自定义的信息转成模型上下文），
  // 每个模型请求前都会跑一次、返回的 messages 只作用于**这一次请求**，故不写进 transcript——
  // 否则对话与分支树里会凭空多出一轮「用户说……」的假历史，还会被压缩摘要当成真实对话。
  harness.hooks.on("transform_context", (event) => {
    if (pendingBrowserNotices.length === 0) return undefined;
    const text = pendingBrowserNotices.splice(0, pendingBrowserNotices.length).join("\n");
    return {
      messages: [...event.messages, { role: "user", content: text, timestamp: Date.now() }],
    };
  });

  // 纵深防御：若有影响性工具执行完却没经过闸门，说明拦截链路漏了。
  // 宁可吐一个显眼告警，也不能静默地把它放过去。
  harness.hooks.on("after_tool", (event) => {
    if (READONLY_TOOLS.has(event.toolName)) return undefined;
    if (gatedToolCalls.has(event.toolCallId)) return undefined;
    trace(`安全告警：${event.toolName} 未经闸门即执行`);
    send({
      type: "error",
      message:
        `安全告警：${event.toolName} 执行完成但未经审批闸门` +
        `（toolCallId=${event.toolCallId}）。本次调用未被拦截，请核对审批链路是否正常。`,
      fatal: false,
    });
    return undefined;
  });

  // 只观测不干预：记录文件改动，返回 undefined 表示不修改工具结果
  harness.hooks.on("after_tool", (event) => {
    if (event.isError) return undefined;
    if (event.toolName !== "edit" && event.toolName !== "write") return undefined;

    const rawPath = event.args.path;
    if (typeof rawPath !== "string") return undefined;

    const details = event.details as { patch?: unknown } | undefined;
    const patch = typeof details?.patch === "string" ? details.patch : null;
    const counts = patch ? countPatchLines(patch) : { added: 0, removed: 0 };

    const path = toRelative(cwd, rawPath);
    const change: ViewFileChange = {
      id: randomUUID(),
      path,
      kind: event.toolName === "edit" ? "edit" : "write",
      patch,
      addedLines: counts.added,
      removedLines: counts.removed,
      timestamp: Date.now(),
      // 净值由主进程算（它才有基线与读盘边界），worker 只报了「这一次改了什么」
      netAddedLines: null,
      netRemovedLines: null,
    };
    // 基线只在该文件的**第一次**改动时带上：后面几次主进程已有基线，不必重发全文
    const baseline = pendingBaselines.get(event.toolCallId);
    pendingBaselines.delete(event.toolCallId);
    const firstTouch = baseline !== undefined && !baselineSent.has(path);
    if (firstTouch) baselineSent.add(path);
    // 上报给主进程落库；改动的投影真源是数据库，不在 worker 内存累积
    send(
      firstTouch && baseline !== undefined
        ? { type: "fileChange", change, baseline }
        : { type: "fileChange", change },
    );
    scheduleFlush();
    return undefined;
  });

  // 用量落库：内核每产生一条 usage 行就上报一次，不做差值推算
  // 过滤规则（非主 lane、adjustment 行）见 buildUsageUpload
  harness.events.on("usage", (event) => {
    // 同步记录最近一轮的上下文占用（prompt tokens）；重启后为空，由主进程用 DB 回填
    const used = contextUsedFromUsage(event);
    if (used !== null && state) {
      state.meta.contextUsed = used;
      // 触发一次 view 推送，让进度条实时更新；否则要等本轮结束才刷新
      scheduleFlush();
    }

    const upload = buildUsageUpload(
      event,
      state?.meta.model ?? `${providerConfig.id}/${modelId}`,
      providerConfig.id,
      Date.now(),
    );
    if (upload) send(upload);
  });

  // 工具调用落库：配对 tool_start/tool_end 得到耗时与入参，在 end 时上报一条
  const toolTracker = new ToolCallTracker();
  harness.events.on("tool_start", (event) => {
    toolTracker.start(event.toolCallId, event.args, Date.now());
  });
  harness.events.on("tool_end", (event) => {
    const upload = toolTracker.end(event, Date.now());
    if (upload) {
      rememberDuration(upload.toolCallId, upload.durationMs);
      send(upload);
    }
  });

  const lane = await harness.lane("main", context);
  // 恢复旧会话时，lane 持久化配置里的模型可能已在本进程不存在（provider 被删、模型下线、
  // 或测试残留）：内核恢复语义是原样采纳持久化配置（create 传入的模型只用于新建 lane），
  // 不校验可用性，第一条消息就会以 model_unavailable 失败。这里与主进程 resolveSessionModel
  // 的「失效回退」对齐：解析不了就用本次 init 的模型愈合（setModel 会把修复写回会话）。
  // 解析得了就不动——注册表里只有 init 装配的 provider，能解析即与 init 同源，属会话自己的选定。
  if ((await lane.getModel(context)) === undefined) {
    await lane.setModel({ provider: providerConfig.id, modelId }, context);
  }
  const watch = await lane.watch(context);
  // 投影一律使用 Colt 的会话 ID，渲染层才能正确匹配
  // fileChanges 始终为空——主进程会用数据库中的完整列表覆盖它
  const meta = {
    sessionId: command.externalSessionId,
    cwd,
    model: `${providerConfig.id}/${modelId}`,
    // 模型目录声明的输入能力；纯文本模型（如 deepseek-v4-flash）不含 "image"
    imageInput: model.input?.includes("image") ?? false,
    fileChanges: [] as ViewFileChange[],
    // 进程内初值为 0；首个 usage 事件到达后修正，切会话/重启时由主进程用 DB 覆盖
    contextUsed: 0,
  };

  state = {
    harness,
    lane,
    repo,
    session,
    models,
    providerId: providerConfig.id,
    snapshot: watch.snapshot,
    resnapshot: () => watch.resnapshot(context),
    meta,
    unsubscribe: () => watch.unsubscribe(),
  };

  // 必须 start，否则事件会无界缓冲
  watch.start((event) => {
    if (!state) return;
    reduceLaneSnapshot(state.snapshot, event);
    scheduleFlush();
  });

  send({
    type: "ready",
    externalSessionId: command.externalSessionId,
    kernelSessionId: session.metadata.id,
    cwd,
    model: meta.model,
  });
  send({ type: "view", view: project(state.snapshot, meta) });

  // 恢复上次退出时未完成的运行
  for (const operation of open) {
    void (async () => {
      try {
        const target =
          operation.lane === lane.name ? lane : await harness.lane(operation.lane, context);
        await target.resume(context);
        send({ type: "log", message: `已恢复未完成的运行：${operation.lane}` });
      } catch (error) {
        send({
          type: "error",
          message: `恢复运行失败：${error instanceof Error ? error.message : String(error)}`,
          fatal: false,
        });
      }
    })();
  }
}

async function handle(command: WorkerCommand): Promise<void> {
  switch (command.type) {
    case "init":
      await init(command);
      return;

    // 审批答复不依赖会话状态，也不能报错中断：阻塞的 hook 必须被唤醒
    case "approvalResult":
      settleApproval(command.toolCallId, command.approved, command.reason);
      return;

    // 宿主能力答复：唤醒阻塞在 callHost 的工具，同样不能依赖会话状态
    case "toolRpcResult":
      hostBridge.settle(command.requestId, command.ok, command.ok ? command.result : command.error);
      return;

    case "prompt": {
      if (!state) throw new Error("会话尚未初始化");
      await state.lane.prompt(command.text, toImageContent(command.images), context);
      // 运行结束后补推一次终态
      if (state) send({ type: "view", view: project(state.snapshot, state.meta) });
      return;
    }

    case "steer": {
      if (!state) throw new Error("会话尚未初始化");
      await state.lane.steer(command.text, toImageContent(command.images), context);
      return;
    }

    // 用户手动导航：只暂存，绝不在这里发起运行。
    // 注入时机是「下一次模型请求前」（init 里的 transform_context），所以 agent 空闲时
    // 这条提示会一直躺着直到它下次开口——不会凭空把 agent 叫醒。
    case "browserNotice": {
      pendingBrowserNotices.push(command.text);
      return;
    }

    case "abort": {
      if (!state) return;
      await state.lane.abort(context);
      return;
    }

    case "setModel": {
      if (!state) throw new Error("会话尚未初始化");
      const targetProviderId = command.provider.id;
      // provider 可能尚未注册（跨 provider 切换），先按需装配
      if (targetProviderId !== state.providerId && !state.models.getProvider(targetProviderId)) {
        state.models.setProvider(buildProvider(command.provider));
      }
      const next = state.models.getModel(targetProviderId, command.modelId);
      if (!next) throw new Error(`模型不可用：${targetProviderId}/${command.modelId}`);
      // setModel 接受的是标识（provider + modelId），不是 Model 对象
      await state.lane.setModel(
        { provider: targetProviderId, modelId: command.modelId },
        context,
      );
      state.providerId = targetProviderId;
      state.meta.model = `${targetProviderId}/${command.modelId}`;
      // 切换模型后图片能力随之变化，界面需立即据此放开/禁止发图
      state.meta.imageInput = next.input?.includes("image") ?? false;
      send({
        type: "modelChanged",
        providerId: targetProviderId,
        modelId: command.modelId,
      });
      send({ type: "view", view: project(state.snapshot, state.meta) });
      return;
    }

    case "compact": {
      if (!state) throw new Error("会话尚未初始化");
      await state.lane.compact(undefined, context);
      // 压缩重写了 transcript，增量事件不足以重建，必须重新取快照
      state.snapshot = await state.resnapshot();
      send({ type: "view", view: project(state.snapshot, state.meta) });
      return;
    }

    case "branches": {
      if (!state) throw new Error("会话尚未初始化");
      send({ type: "branches", nodes: await projectBranches(state) });
      return;
    }

    case "navigate": {
      if (!state) throw new Error("会话尚未初始化");
      // summarize: false —— 直接跳转，不花额外 token 生成分支摘要
      await state.lane.navigateTree(command.targetId, { summarize: false }, context);
      // 跳转换了整条分支，transcript 需要整体重建
      state.snapshot = await state.resnapshot();
      send({ type: "view", view: project(state.snapshot, state.meta) });
      send({ type: "branches", nodes: await projectBranches(state) });
      return;
    }

    case "dispose": {
      if (state) {
        state.unsubscribe();
        await state.harness.close(context).catch(() => undefined);
        await state.repo.close(context).catch(() => undefined);
        state = undefined;
      }
      // 作废所有待决宿主调用，否则工具会一直挂到超时
      hostBridge.dispose();
      process.exit(0);
    }
  }
}

process.parentPort?.on("message", (event) => {
  const command = event.data as WorkerCommand;
  void handle(command).catch((error: unknown) => {
    send({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
      fatal: command.type === "init",
    });
  });
});
