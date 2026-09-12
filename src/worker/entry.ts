/**
 * Session Worker：每会话一个 utilityProcess
 * 持有 harness / lane / 会话存储，向 main 投影 ConversationView
 * 形态参考官方 packages/coding-agent/src/experimental/mini/worker/run.ts
 * 作者：陕耀云栈WorkMate
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
import { createModels, createProvider, envApiKeyAuth, lazyApi } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import type {
  ConversationView,
  ViewFileChange,
  ViewMessage,
  ViewRunningTool,
  ViewToolResult,
  WorkerBranchNode,
  WorkerCommand,
  WorkerMessage,
  WorkerProviderConfig,
} from "@shared/worker-protocol";

import { randomUUID } from "node:crypto";
import { relative, isAbsolute } from "node:path";

const context: Context = BACKGROUND_CONTEXT;

function send(message: WorkerMessage): void {
  process.parentPort?.postMessage(message);
}

function systemPrompt(cwd: string): string {
  return [
    "你是 Banyan 桌面工作台中的编码助手，运行在用户的本地项目里。",
    `当前工作目录：${cwd}`,
    "可以使用 read / write / edit / bash 工具查看和修改文件。",
    "动手前先用一句话说明你要做什么，保持简洁、技术化。",
    "【输出语言】始终用中文回复。即使用户消息、文件内容或命令输出含有英文，你的叙述部分也必须是中文；",
    "代码、路径、命令、报错原文保持原样不要翻译。",
  ].join("\n");
}

/** 从消息内容块中抽取纯文本 */
function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => {
      return typeof block === "object" && block !== null && (block as { type?: string }).type === "text";
    })
    .map((block) => block.text)
    .join("");
}

/** 从助手消息中抽取工具调用 */
function extractToolCalls(content: unknown): ViewMessage["toolCalls"] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((block): block is { type: "toolCall"; id: string; name: string; arguments?: unknown } => {
      return typeof block === "object" && block !== null && (block as { type?: string }).type === "toolCall";
    })
    .map((block) => ({
      id: block.id,
      name: block.name,
      args: (() => {
        try {
          return JSON.stringify(block.arguments ?? {});
        } catch {
          return "{}";
        }
      })(),
    }));
}

/** 从工具结果的 content 块中抽取文本（与消息 content 结构一致） */
function extractToolText(result: unknown): string {
  if (typeof result !== "object" || result === null) return "";
  return extractText((result as { content?: unknown }).content);
}

/** 统计 unified patch 的增删行数 */
function countPatchLines(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    // 排除 --- / +++ 文件头
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return { added, removed };
}

/** 把绝对路径收敛为相对工作目录的路径，便于 UI 展示 */
function toRelative(cwd: string, path: string): string {
  if (!isAbsolute(path)) return path.replaceAll("\\", "/");
  const rel = relative(cwd, path);
  return (rel.startsWith("..") ? path : rel).replaceAll("\\", "/");
}

/** 把 LaneSnapshot 投影成渲染层可直接消费的 DTO */
function project(
  snapshot: LaneSnapshot,
  meta: { sessionId: string; cwd: string; model: string; fileChanges: ViewFileChange[] },
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
      toolCalls: role === "assistant" ? extractToolCalls(record.message.content) : [],
      timestamp: record.message.timestamp,
    });
  }

  const operation = snapshot.operation;
  const streamingText = operation?.streamingMessage
    ? extractText(operation.streamingMessage.content)
    : null;

  const runningTools: ViewRunningTool[] = (operation?.runningTools ?? []).map((tool) => {
    const record = tool as unknown as {
      toolCallId?: string;
      id?: string;
      toolName?: string;
      name?: string;
      startedAt?: number;
      result?: unknown;
    };
    const details = (record.result as { details?: { fullOutputPath?: string } } | undefined)?.details;
    return {
      id: record.toolCallId ?? record.id ?? "",
      name: record.toolName ?? record.name ?? "",
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
    messages,
    toolResults,
    fileChanges: meta.fileChanges,
    streamingText: streamingText && streamingText.length > 0 ? streamingText : null,
    runningTools,
    // 注意：operation 不为 null 不等于正在跑——status 为 "open" 表示已完成、等待下一步输入
    running: operation !== null && operation.status !== "open",
    queuedCount: snapshot.queues?.length ?? 0,
    faulted: Boolean(snapshot.faulted),
    stats: {
      messageCount: snapshot.stats?.messageCount ?? 0,
      inputTokens: usage?.input ?? 0,
      outputTokens: usage?.output ?? 0,
      totalTokens: usage?.totalTokens ?? 0,
      costUsd: usage?.cost?.total ?? 0,
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
  meta: { sessionId: string; cwd: string; model: string; fileChanges: ViewFileChange[] };
  unsubscribe: () => void;
}

/**
 * 根据配置装配 provider。
 * 内置 DeepSeek 走官方工厂，因为它自带 compat（thinkingFormat 等）与计价元数据；
 * 自定义 endpoint 用 createProvider 现搭，API 层复用 openai-completions。
 */
function buildProvider(config: WorkerProviderConfig): ReturnType<typeof deepseekProvider> {
  if (config.kind === "deepseek") return deepseekProvider();

  const openAICompletionsApi = lazyApi(
    () => import("@earendil-works/pi-ai/api/openai-completions"),
  );

  return createProvider({
    id: config.id,
    name: config.name,
    baseUrl: config.baseUrl,
    auth: { apiKey: envApiKeyAuth(`${config.name} API key`, ["BANYAN_PROVIDER_KEY"]) },
    models: config.models.map((option) => ({
      id: option.id,
      name: option.name,
      api: "openai-completions" as const,
      baseUrl: config.baseUrl,
      provider: config.id,
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: option.contextWindow,
      maxTokens: Math.min(option.contextWindow, 8192),
    })),
    api: openAICompletionsApi,
  }) as ReturnType<typeof deepseekProvider>;
}

/** 把全部条目投影成分支树（session 级扫描，含所有分支） */
async function projectBranches(current: WorkerState): Promise<WorkerBranchNode[]> {
  const entries = await current.session.findEntries({ order: "asc" }, context);
  const tipId = await current.lane.getTipId(context);

  // 从 tip 回溯到根，得到当前活跃路径
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const activePath = new Set<string>();
  let cursor: string | null = tipId;
  while (cursor) {
    activePath.add(cursor);
    cursor = byId.get(cursor)?.parentId ?? null;
  }

  return entries.map((entry) => {
    const record = entry as unknown as {
      id: string;
      parentId: string | null;
      type: string;
      timestamp?: number;
      message?: { role: string; content: unknown };
    };
    const role = record.message?.role;
    const text = record.message ? extractText(record.message.content) : "";
    return {
      id: record.id,
      parentId: record.parentId,
      kind: role ?? record.type,
      summary: text.slice(0, 60).replace(/\s+/g, " ").trim() || `(${record.type})`,
      timestamp: record.timestamp ?? 0,
      onActivePath: activePath.has(record.id),
      isTip: record.id === tipId,
    };
  });
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
      tools: [createReadTool(), createWriteTool(), createEditTool(), createBashTool()],
      toolContext: { env: executionEnv },
      systemPrompt: systemPrompt(cwd),
    },
    context,
  );

  // 只观测不干预：记录文件改动，返回 undefined 表示不修改工具结果
  harness.hooks.on("after_tool", (event) => {
    if (event.isError) return undefined;
    if (event.toolName !== "edit" && event.toolName !== "write") return undefined;

    const rawPath = event.args.path;
    if (typeof rawPath !== "string") return undefined;

    const details = event.details as { patch?: unknown } | undefined;
    const patch = typeof details?.patch === "string" ? details.patch : null;
    const counts = patch ? countPatchLines(patch) : { added: 0, removed: 0 };

    const change: ViewFileChange = {
      id: randomUUID(),
      path: toRelative(cwd, rawPath),
      kind: event.toolName === "edit" ? "edit" : "write",
      patch,
      addedLines: counts.added,
      removedLines: counts.removed,
      timestamp: Date.now(),
    };
    // 上报给主进程落库；改动的投影真源是数据库，不在 worker 内存累积
    send({ type: "fileChange", change });
    scheduleFlush();
    return undefined;
  });

  // 用量落库：内核每产生一条 usage 行就上报一次，不做差值推算
  harness.events.on("usage", (event) => {
    const currentModel = state?.meta.model ?? `${providerConfig.id}/${modelId}`;
    const slash = currentModel.indexOf("/");
    const usingProvider = slash === -1 ? providerConfig.id : currentModel.slice(0, slash);
    const usingModel = slash === -1 ? currentModel : currentModel.slice(slash + 1);
    const usage = event.row.usage;
    send({
      type: "usage",
      provider: usingProvider,
      model: usingModel,
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      costUsd: usage.cost.total,
      timestamp: Date.now(),
    });
  });

  // 工具调用落库：配对 tool_start/tool_end 得到耗时与入参，在 end 时上报一条
  // args 只在 tool_start 上，故一并缓存
  const toolMeta = new Map<string, { startedAt: number; argsJson: string | null }>();
  harness.events.on("tool_start", (event) => {
    let argsJson: string | null = null;
    try {
      argsJson = JSON.stringify(event.args ?? null);
    } catch {
      argsJson = null;
    }
    toolMeta.set(event.toolCallId, { startedAt: Date.now(), argsJson });
  });
  harness.events.on("tool_end", (event) => {
    const meta = toolMeta.get(event.toolCallId);
    toolMeta.delete(event.toolCallId);
    send({
      type: "toolCall",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      inputJson: meta?.argsJson ?? null,
      isError: event.isError,
      durationMs: meta === undefined ? null : Date.now() - meta.startedAt,
      timestamp: Date.now(),
    });
  });

  const lane = await harness.lane("main", context);
  const watch = await lane.watch(context);
  // 投影一律使用 Banyan 的会话 ID，渲染层才能正确匹配
  // fileChanges 始终为空——主进程会用数据库中的完整列表覆盖它
  const meta = {
    sessionId: command.externalSessionId,
    cwd,
    model: `${providerConfig.id}/${modelId}`,
    fileChanges: [] as ViewFileChange[],
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

    case "prompt": {
      if (!state) throw new Error("会话尚未初始化");
      await state.lane.prompt(command.text, undefined, context);
      // 运行结束后补推一次终态
      if (state) send({ type: "view", view: project(state.snapshot, state.meta) });
      return;
    }

    case "steer": {
      if (!state) throw new Error("会话尚未初始化");
      await state.lane.steer(command.text, undefined, context);
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
