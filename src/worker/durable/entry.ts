// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * Durable Session Worker —— **唯一的内核**（旧 JSONL worker 已删除）。
 * 存储为每会话一个 SQLite 单文件库（官方推荐：长会话不要把全量历史常驻内存）。
 *
 * 与渲染层/主进程之间仍是同一份进程契约：收发 `WorkerCommand` / `WorkerMessage`，
 * 把 durable 的 `Conversation` / `pi.*` 文档投影成 `ConversationView`。
 * 工具实现、提示词注入、审批与投影规则都在 `worker/lib/` 下，由本入口组装。
 *
 * 这一版已接：模型 / 思考等级 / 提示词注入 / 工具（含审批、ask_user、读边界）/
 * 视图投影 / 压缩 / 分支 / 技能 / MCP / 用量与工具调用落库 / 子代理（任务拥有的子对话）/
 * 崩溃恢复（durable 自带）。尚未接：任务图视图。
 */
import {
  GenerationTask,
  Harness,
  ToolTask,
  createRegistry,
  hook,
  section,
  watchEvents,
  type AgentChange,
  type AgentEvent,
  type AgentEventStream,
  type CompactionPolicy,
  type Conversation,
  type ConversationId,
  type ConversationView as DurableConversationView,
  type ConversationWatch,
  type EntryId,
  type HarnessSettings,
  type Registry,
  type Storage,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createBashTool, createEditTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type AssistantMessage, type ToolResultMessage } from "@earendil-works/pi-ai";

import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  FileBaseline,
  ViewFileChange,
  ViewRunOutcome,
  ViewSkill,
  ViewTodo,
  WorkerCommand,
  WorkerMessage,
} from "@shared/worker-protocol";
import { buildProvider } from "@shared/provider-factory";
import { APPROVAL_TIMEOUT_MS } from "@shared/limits";
import { READONLY_TOOLS } from "@shared/readonly-tools";
import { type ThinkingLevel } from "@shared/thinking-level";
import { normalizeCompactionConfig, type CompactionConfig } from "@shared/compaction-config";
import { splitModelRef } from "@shared/model-ref";

import { ApprovalBridge, trace } from "../lib/approval-bridge";
import { HostBridge } from "../lib/host-bridge";
import { createAskUserGateway, createAskUserTools, isQuestionTool } from "../lib/ask-user-tool";
import { createBrowserTools } from "../lib/browser-tool";
import { createComputerTools } from "../lib/computer-tool";
import { createMemoryTools } from "../lib/memory-tool";
import { createTodoTools } from "../lib/todo-tool";
import { createSearchTools } from "../lib/search-tools";
import { createGuardedReadTool } from "../lib/read-guard";
import { isSubagentTool } from "../lib/subagent";
import { captureBaseline } from "../lib/baseline";
import { countPatchLines, projectTranscript, toRelative } from "../lib/project";
import { createDiagnoseController, type DiagnoseController } from "../lib/diagnose";
import { createMcpRuntime, mcpUserHome, type McpRuntime } from "../lib/mcp-tools";
import { composeMcpInstructions } from "../lib/mcp-reload";
import {
  composeSystemPrompt,
  enabledSkills,
  loadSkillsForSessionWithConfig,
  toViewSkills,
} from "../lib/skills";
import { skillsUserHome } from "@shared/skills-config";
import {
  createSkillsRuntime,
  handleSkillsCommand,
  resolveSkillInvocation,
  type SkillsRuntime,
} from "../lib/skills-command";
import {
  compactMemoryReminder,
  createMemoryIndexReporter,
  createMemoryInjector,
  describeMemory,
  loadProjectMemory,
  memoryFilePath,
  readMemoryFile,
  userMemoryFilePath,
} from "../lib/memory";
import {
  createAgentsMdInjector,
  describeAgentsMd,
  loadAgentsMd,
} from "../lib/agents-md";
import { createWikiMapInjector } from "../lib/wiki-map";
import { agentDirs, describeAgents, loadAgentDefs, renderAgentCatalog } from "../lib/agent-defs";
import { systemPrompt } from "../lib/system-prompt";
import { ProviderRegistry } from "../lib/provider-registry";
import { renderTodoBlock } from "@shared/todo";
import { toImageContent } from "../lib/attachments";
import { describeCompactOutcome } from "../lib/compact-error";

import { projectDisplay, projectDurableView, type ProjectedDisplay } from "./project";
import { appendDisplayEntries, loadDisplayState, type DisplayState } from "./display";
import { DurableSubagents } from "./subagent";
import { runMemoryTidy } from "./memory-tidy";

const context: Context = BACKGROUND_CONTEXT;

function send(message: WorkerMessage): void {
  process.parentPort?.postMessage(message);
}

/** 审批往返（发请求 → 阻塞 → approvalResult 唤醒）；主进程持有策略与界面 */
const approvals = new ApprovalBridge(send);
/** 提问往返：与审批同形不同义（默认「没答案」，不走审批策略） */
const questions = createAskUserGateway(send, APPROVAL_TIMEOUT_MS);
/** 宿主能力（浏览器 / 桌面 / 记忆 / 待办 / provider 密钥）只在主进程执行 */
const hostBridge = new HostBridge(send);

/**
 * 一次性「临时提醒」：下一次模型请求前注入，不进 transcript、也不触发运行。
 * durable 的对应扩展点是 `GenerationTask.beforeRequest`（只影响那一次请求）。
 */
const pendingEphemeralNotices: string[] = [];

/** 待办清单镜像：主进程是唯一写入方，每次写入后整份推来（缓存，不是真源） */
let todoMirror: ViewTodo[] = [];

/** 流式期间合并推送，避免每个 token 一次 IPC */
let flushTimer: NodeJS.Timeout | undefined;
/** 已落盘的工具图片记账 */
const spilledImages = new Set<string>();
let lastPushedDigest = "";

interface WorkerMeta {
  sessionId: string;
  cwd: string;
  model: string;
  imageInput: boolean;
  thinkingLevel: ThinkingLevel;
  skills: ViewSkill[];
  fileChanges: ViewFileChange[];
  todos: ViewTodo[];
}

interface WorkerState {
  harness: Harness;
  conversation: Conversation;
  /** 会话库句柄：界面历史要从**全部条目**重建（压缩只改模型上下文） */
  storage: Storage;
  registry: Registry<ToolRegistration>;
  watch: ConversationWatch;
  events: AgentEventStream;
  latest: DurableConversationView;
  /** 界面历史缓存：全部条目（含压缩前），与 `latest.entries` 的 head 截断无关 */
  display: DisplayState;
  /** 界面投影缓存：条目没变就不重投影（流式期间每 50ms 会推一次视图） */
  displayProjected: ProjectedDisplay | undefined;
  /** 技能清单的签名：变了要重投影（read 卡片上的技能标记依赖它） */
  displaySkillsKey: string;
  models: ReturnType<typeof createModels>;
  providerId: string;
  cwd: string;
  toolOutputDir: string;
  mcp: McpRuntime;
  skills: SkillsRuntime;
  diagnose: DiagnoseController;
  agentsMd: ReturnType<typeof createAgentsMdInjector>;
  memory: ReturnType<typeof createMemoryInjector>;
  userMemory: ReturnType<typeof createMemoryInjector>;
  wiki: ReturnType<typeof createWikiMapInjector>;
  reportMemoryIndex: (scope: "project" | "user", content: string | null) => void;
  basePrompt: string;
  /** 子代理目录（装载时定稿；与旧 worker 每请求重拼等价——定义在本会话内不变） */
  agentCatalog: string;
  /** 设置页改压缩配置：直接改活配置对象，下一次操作起生效 */
  applyCompaction: (config: CompactionConfig) => void;
  meta: WorkerMeta;
  lastRun: ViewRunOutcome | null;
  abortRequested: boolean;
  generationFailure: string | undefined;
  gatedToolCalls: Set<string>;
  pendingBaselines: Map<string, FileBaseline>;
  baselineSent: Set<string>;
  toolStarts: Map<string, { name: string; argsJson: string | null; at: number }>;
  /** 子代理编排：每个子代理是一个由本次工具调用拥有的子对话 */
  subagents: DurableSubagents;
  /** MCP 工具每次重载后重建扩展用：保留当前自研工具清单（它们不随 MCP 变） */
  customTools: ToolRegistration[];
  /** durable 原生工具（read / write / edit / bash）：与 MCP 重载无关，建一次复用 */
  builtinTools: ToolRegistration[];
}

let state: WorkerState | undefined;

function scheduleFlush(): void {
  if (flushTimer || !state) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    pushView();
  }, 50);
}

/**
 * 推一次完整视图——所有 `session.view` 的唯一出口。
 * 与旧 worker 同款：先落盘工具图片，再投影，最后用 SHA-256 去重。
 */
function pushView(): void {
  if (!state) return;
  // 界面历史与模型上下文是两件事：消息来自**全部条目**（压缩掉的历史照样显示），
  // 「上下文占用」这类模型侧指标仍取 latest（head 之后的可见范围）。
  const skillsKey = state.meta.skills
    .map((skill) => `${skill.name}:${skill.disabled ? 1 : 0}`)
    .join(",");
  if (state.displayProjected === undefined || state.displaySkillsKey !== skillsKey) {
    state.displayProjected = projectDisplay(state.display.entries, {
      skills: state.meta.skills,
      cwd: state.cwd,
      toolOutputDir: state.toolOutputDir,
      spilled: spilledImages,
    });
    state.displaySkillsKey = skillsKey;
  }
  const view = projectDurableView(
    state.latest,
    {
      sessionId: state.meta.sessionId,
      cwd: state.cwd,
      model: state.meta.model,
      imageInput: state.meta.imageInput,
      thinkingLevel: state.meta.thinkingLevel,
      skills: state.meta.skills,
      fileChanges: state.meta.fileChanges,
      todos: state.meta.todos,
      lastRun: state.lastRun,
      subagents: state.subagents.toView(),
    },
    { entries: state.display.entries, projected: state.displayProjected },
  );
  const digest = createHash("sha256").update(JSON.stringify(view)).digest("hex");
  if (digest === lastPushedDigest) return;
  lastPushedDigest = digest;
  send({ type: "view", view });
}

/** `d<id>`：把 durable 的数值 conversation id 编码进主进程持久化的 `kernelSessionId` */
function encodeKernelSessionId(id: number): string {
  return `d${id}`;
}

function parseKernelSessionId(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^d(\d+)$/.exec(value);
  if (match === null) return undefined;
  const parsed = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function jsonArgs(args: unknown): string | null {
  try {
    return JSON.stringify(args ?? {});
  } catch {
    return null;
  }
}

/**
 * 工具执行前的决定：审批、基线、提问豁免。
 * 与旧 worker 的 `before_tool` 逐条对齐——这一段是安全边界，不因换内核而变。
 */
async function beforeTool(
  call: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  },
  conversationId: ConversationId,
): Promise<{ block?: string } | undefined> {
  if (!state) return undefined;
  // ask_user 不受审批管辖：走审批通道会被 auto / full-access 静默批准成「已通过」
  if (isQuestionTool(call.name)) return undefined;
  // 委派本身同样豁免：否则同一件事弹两次卡（委派一次 + 子代理内部工具各一次），
  // 而安全性不降——副作用全落在子代理的工具调用上，那里照样过本闸门。
  if (isSubagentTool(call.name)) return undefined;
  state.gatedToolCalls.add(call.id);
  if (
    (call.name === "edit" || call.name === "write") &&
    typeof call.arguments.path === "string"
  ) {
    state.pendingBaselines.set(call.id, captureBaseline(state.cwd, call.arguments.path));
  }
  trace(`hook 触发 ${call.name} ${call.id}`);
  const decision = await approvals.request(
    call.id,
    call.name,
    call.arguments,
    state.subagents.refFor(conversationId),
  );
  trace(`得到答复 ${call.name} approved=${decision.approved}`);
  if (decision.approved) return undefined;
  return { block: decision.reason };
}

/**
 * 工具执行后的观测：写后诊断、文件改动上报、纵深防御告警。
 * 返回替换后的结果（诊断会把结论追加进当次工具输出）。
 */
async function afterTool(
  call: { id: string; name: string; arguments: Record<string, unknown> },
  result: { output?: unknown; details?: unknown; isError?: boolean },
): Promise<{ output?: unknown } | undefined> {
  if (!state) return undefined;
  const current = state;

  // 纵深防御：有影响性的工具执行完却没经过闸门 → 显眼告警（与旧 worker 同一条）
  const gated = current.gatedToolCalls.has(call.id);
  current.gatedToolCalls.delete(call.id);
  if (!READONLY_TOOLS.has(call.name) && !isQuestionTool(call.name) && !isSubagentTool(call.name) && !gated) {
    send({
      type: "error",
      message:
        `安全告警：${call.name} 执行完成但未经审批闸门（toolCallId=${call.id}）。` +
        "本次调用未被拦截，请核对审批链路是否正常。",
      fatal: false,
    });
  }

  let output = result.output;
  // 写后诊断：返回非 undefined 即链式改写工具结果（与旧 worker 的注册顺序一致）
  if (result.isError !== true) {
    const diagnosed = await current.diagnose.handleAfterTool({
      toolName: call.name,
      isError: false,
      args: call.arguments,
      content: (output ?? []) as never,
    });
    if (diagnosed !== undefined) output = diagnosed.content;
  }

  // 文件改动只观测、不干预
  if (result.isError !== true && (call.name === "edit" || call.name === "write")) {
    const rawPath = call.arguments.path;
    if (typeof rawPath === "string") {
      const details = result.details as { patch?: unknown } | undefined;
      const patch = typeof details?.patch === "string" ? details.patch : null;
      const counts = patch === null ? { added: 0, removed: 0 } : countPatchLines(patch);
      const path = toRelative(current.cwd, rawPath);
      const change: ViewFileChange = {
        id: randomUUID(),
        path,
        kind: call.name === "edit" ? "edit" : "write",
        patch,
        addedLines: counts.added,
        removedLines: counts.removed,
        timestamp: Date.now(),
        netAddedLines: null,
        netRemovedLines: null,
      };
      const baseline = current.pendingBaselines.get(call.id);
      current.pendingBaselines.delete(call.id);
      const firstTouch = baseline !== undefined && !current.baselineSent.has(path);
      if (firstTouch) current.baselineSent.add(path);
      send(
        firstTouch && baseline !== undefined
          ? { type: "fileChange", change, baseline }
          : { type: "fileChange", change },
      );
      scheduleFlush();
    }
  }
  return output === result.output ? undefined : { output };
}


/** 用量行：每条助手消息的 usage 落一行，内核条目 id 作幂等键 */
function emitUsage(entryId: EntryId, message: AssistantMessage): void {
  const usage = message.usage;
  send({
    type: "usage",
    kernelUsageId: `durable:${entryId}`,
    provider: message.provider,
    model: message.model,
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    costUsd: usage.cost.total,
    timestamp: message.timestamp,
  });
}

function handleAgentEvent(event: AgentEvent): void {
  if (!state) return;
  const current = state;
  switch (event.type) {
    case "run_start":
      current.abortRequested = false;
      current.generationFailure = undefined;
      break;
    case "run_end":
      current.lastRun = current.abortRequested
        ? { status: "aborted" }
        : current.generationFailure !== undefined
          ? { status: "failed", error: current.generationFailure }
          : { status: "completed" };
      break;
    case "task_failed":
      if (event.kind === "pi.generation") current.generationFailure = event.message;
      break;
    case "message_end": {
      const message = event.entry.model?.[0];
      if (message?.role === "assistant") emitUsage(event.entry.id, message);
      break;
    }
    case "tool_execution_start":
      current.toolStarts.set(event.toolCallId, {
        name: event.toolName,
        argsJson: jsonArgs(event.args),
        at: Date.now(),
      });
      break;
    case "tool_execution_end": {
      const started = current.toolStarts.get(event.toolCallId);
      current.toolStarts.delete(event.toolCallId);
      const result = event.entry?.model?.[0] as ToolResultMessage | undefined;
      send({
        type: "toolCall",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        inputJson: started?.argsJson ?? null,
        isError: result?.isError ?? false,
        durationMs:
          typeof result?.durationMs === "number"
            ? result.durationMs
            : started === undefined
              ? null
              : Date.now() - started.at,
        timestamp: result?.timestamp ?? Date.now(),
      });
      break;
    }
    case "compaction_end":
      // 自动压缩失败必须可见：否则上下文一旦逼近上限，用户只会看到「发不出去了」
      if (event.error !== undefined) {
        send({ type: "error", message: `压缩上下文失败：${event.error}`, fatal: false });
      }
      break;
    default:
      break;
  }
  scheduleFlush();
}

function buildExtension(tools: ToolRegistration[]): Parameters<Registry["install"]>[0] {
  return {
    name: "colt",
    tools,
    sections: [
      section(
        "colt-context",
        async (input) => {
          const current = state;
          if (current === undefined) return undefined;
          // 子代理有自己的 `instructions`（定义正文 + AGENTS.md）。把它当成编码助手来注入
          // 记忆 / 技能 / 待办，等于把父的上下文偷渡过去，还会暗示「你可以调技能」（死入口）。
          if (input.conversationId !== current.conversation.id) return undefined;
          let text = composeSystemPrompt(
            current.basePrompt,
            enabledSkills(current.skills.ref.current),
          );
          text = await current.agentsMd.systemPromptFor(text);
          text = await current.userMemory.systemPromptFor(text);
          text = await current.memory.systemPromptFor(text);
          const todoBlock = renderTodoBlock(todoMirror);
          if (todoBlock !== "") text = `${text}\n\n${todoBlock}`;
          text = await current.wiki.systemPromptFor(text);
          if (current.agentCatalog !== "") text = `${text}\n\n${current.agentCatalog}`;
          return composeMcpInstructions(text, current.mcp);
        },
        { tag: false },
      ),
    ],
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api) => beforeTool(call, api.conversationId),
        afterTool: async (call, result) => (await afterTool(call, result as never)) as never,
      }),
      hook(GenerationTask, {
        beforeRequest: ({ messages }, api) => {
          // 临时提醒是**主对话**的东西：子代理的请求同样会触发本钩子，
          // 不分流的话提醒会被那一轮消费掉，主对话反而看不到。
          if (state === undefined || api.conversationId !== state.conversation.id) return undefined;
          if (pendingEphemeralNotices.length === 0) return undefined;
          const text = pendingEphemeralNotices.splice(0, pendingEphemeralNotices.length).join("\n");
          return {
            messages: [...messages, { role: "user", content: text, timestamp: Date.now() }],
          };
        },
      }),
    ],
  };
}

/**
 * 崩溃后可安全重跑的工具（durable 的 `replay: "safe"`）。
 *
 * 只收**幂等只读**：崩溃后重跑一次与跑一次的结果相同。写类工具绝不进这张表——
 * 重跑一次 `write` / `bash` 就是真实的第二次副作用，而 durable 的默认（unsafe）
 * 正是「不重跑、留一条 interrupted 结果」。
 *
 * 工具自己声明了 `replay` 的（如子代理的 safe，靠固定 requestId 找回同一次提交）
 * 以它自己的为准——这张表只兜住「没说」的那些。
 */
const REPLAY_SAFE_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "memory_search",
  "browser_read",
  "browser_screenshot",
]);

function replaySafe(name: string): boolean {
  return REPLAY_SAFE_TOOLS.has(name);
}

/** 给没有自己声明重放策略的工具补上（默认 unsafe，只读的那几个标 safe） */
function applyReplay(tool: ToolRegistration): ToolRegistration {
  if (tool.replay !== undefined) return tool;
  return replaySafe(tool.name) ? { ...tool, replay: "safe" } : tool;
}

/**
 * 工具集**唯一**的组装口径：durable 原生 + 自研 + MCP + 子代理，统一补重放策略。
 *
 * 初始化（`toolsOf`）与 MCP 热重载（`currentTools`）必须走同一份——两份拷贝时新增一类工具
 * 只改一处，另一处不会报错，只会在「重载后工具消失」这种路径上发作。
 */
function assembleTools(
  builtin: readonly ToolRegistration[],
  custom: readonly ToolRegistration[],
  mcp: readonly ToolRegistration[],
  subagent: ToolRegistration,
): ToolRegistration[] {
  return [...builtin, ...custom, ...mcp, subagent].map(applyReplay);
}

/** 当前工具集（MCP 重载后重建扩展用） */
function currentTools(current: WorkerState): ToolRegistration[] {
  return assembleTools(
    current.builtinTools,
    current.customTools,
    current.mcp.tools,
    current.subagents.tool(),
  );
}

/** MCP 热重载 / 后台补挂后重建扩展（registry 同名替换） */
function reinstallTools(current: WorkerState): void {
  current.registry.install(buildExtension(currentTools(current)));
}

async function openConversation(
  harness: Harness,
  kernelSessionId: string | undefined,
  agent: AgentChange,
): Promise<Conversation> {
  const wanted = parseKernelSessionId(kernelSessionId);
  if (wanted !== undefined) {
    const found = await harness.conversation(wanted as ConversationId, context);
    if (found !== undefined) return found;
  }
  return harness.root(context, { agent });
}

/** 把当前会话配置收敛到 init 给的那份（只在确有差异时写，避免每次开会话都多一条配置事件） */
async function configureConversation(
  conversation: Conversation,
  change: {
    model: { provider: string; modelId: string };
    thinkingLevel: ThinkingLevel;
    cwd: string;
  },
): Promise<void> {
  const current = await conversation.agent(context);
  const next: {
    model?: { provider: string; modelId: string };
    thinkingLevel?: ThinkingLevel;
    cwd?: string;
  } = {};
  if (
    current.model?.provider !== change.model.provider ||
    current.model?.modelId !== change.model.modelId
  ) {
    next.model = change.model;
  }
  if (current.thinkingLevel !== change.thinkingLevel) next.thinkingLevel = change.thinkingLevel;
  if (current.cwd !== change.cwd) next.cwd = change.cwd;
  if (Object.keys(next).length > 0) await conversation.configure(next as AgentChange, context);
}

async function init(command: Extract<WorkerCommand, { type: "init" }>): Promise<void> {
  const cwd = command.cwd;
  const models = createModels();
  models.setProvider(buildProvider(command.provider, command.apiKey));
  const model = models.getModel(command.provider.id, command.model);
  if (model === undefined) throw new Error(`模型不可用：${command.provider.id}/${command.model}`);

  // 诊断复用 durable 的执行环境（cwd 与会话一致）；工具侧的环境由 `HarnessOptions.env`
  // 按每个对话的 cwd 现建（见下方 `Harness.open`）。
  const env = new NodeExecutionEnv({ cwd });

  const diagnose = createDiagnoseController({
    cwd,
    enabled: command.diagnoseEnabled,
    exec: (cmd, opts, ctx) =>
      env.exec(
        cmd,
        {
          cwd: opts.cwd,
          timeout: opts.timeout,
          onOutput: (text) => opts.onOutput?.(text),
        },
        ctx,
      ),
    context,
    onSlowResult: (message) => pendingEphemeralNotices.push(message),
  });

  // 技能：装载 / 告警 / 设置页热更新走旧实现；durable 侧的「按名取正文」由 /skill 命令自己做
  const skills = await createSkillsRuntime({
    reload: () => loadSkillsForSessionWithConfig(cwd, skillsUserHome()),
    cwd,
    onNotice: (message) => send({ type: "notice", message, kind: "security" }),
    onViewSkills: (list) => {
      if (state) state.meta.skills = list;
    },
    onChanged: scheduleFlush,
  });

  const agents = await loadAgentDefs(agentDirs(cwd, homedir()));
  const agentsNotice = describeAgents(agents);
  if (agentsNotice !== null) send({ type: "notice", message: agentsNotice, kind: "security" });

  const agentsMd = await loadAgentsMd(cwd);
  const agentsMdNotice = describeAgentsMd(agentsMd);
  if (agentsMdNotice !== null) {
    send({ type: "notice", message: agentsMdNotice, kind: "security" });
  }
  const agentsMdInjector = createAgentsMdInjector(cwd, (message) =>
    send({ type: "notice", message, kind: "security" }),
  );
  const wiki = createWikiMapInjector(cwd, (message) => send({ type: "notice", message }));

  const memory = await loadProjectMemory(cwd);
  const memoryNotice = describeMemory(memory, "project");
  if (memoryNotice !== null) send({ type: "notice", message: memoryNotice, kind: "security" });
  const userMemoryFile = await readMemoryFile(userMemoryFilePath(homedir()));
  const userMemoryNotice = describeMemory(userMemoryFile, "user");
  if (userMemoryNotice !== null) {
    send({ type: "notice", message: userMemoryNotice, kind: "security" });
  }
  const reportMemoryIndex = createMemoryIndexReporter(send);
  if (memory.error === undefined) reportMemoryIndex("project", memory.content);
  if (userMemoryFile.error === undefined) reportMemoryIndex("user", userMemoryFile.content);
  const memoryInjector = createMemoryInjector({
    filePath: memoryFilePath(cwd),
    scope: "project",
    onError: (message) => send({ type: "notice", message, kind: "security" }),
    onLoaded: (content) => reportMemoryIndex("project", content),
  });
  const userMemoryInjector = createMemoryInjector({
    filePath: userMemoryFilePath(homedir()),
    scope: "user",
    onError: (message) => send({ type: "notice", message, kind: "security" }),
    onLoaded: (content) => reportMemoryIndex("user", content),
  });

  // provider 目录：子代理定义里写 `model: 另一家/模型` 时靠它现装那一家
  const providers = new ProviderRegistry(models, hostBridge);
  providers.setDirectory(command.providers);

  // 子代理编排：工具在 harness / state 建好之前就要交出去，故依赖全部惰性取值。
  const subagents = new DurableSubagents({
    defs: agents.agents,
    cwd,
    agentsMd: async () => (state === undefined ? "" : state.agentsMd.systemPromptFor("")),
    mainConversationId: () => state?.conversation.id,
    harness: () => state?.harness,
    ensureModel: async (providerId, modelId) => {
      const entry = await providers.ensure(providerId);
      if (models.getModel(providerId, modelId) !== undefined) return;
      const available = entry.models.map((item) => item.id).join("、") || "（没有模型）";
      throw new Error(
        `模型「${providerId}/${modelId}」不存在于该服务的模型表里。${entry.name} 现有：${available}。`,
      );
    },
    onUpdate: scheduleFlush,
  });

  const mcp = await createMcpRuntime(
    cwd,
    (message, kind) => send({ type: "notice", message, kind }),
    mcpUserHome(),
  );
  const basePrompt = systemPrompt(cwd, { computerEnabled: command.computerEnabled });

  // durable 原生工具：read 包了一层项目根边界，其余直接用内核实现（与审批闸门同名同义）
  const builtin: ToolRegistration[] = [
    createGuardedReadTool(cwd),
    createWriteTool(),
    createEditTool(),
    createBashTool(),
  ];

  const customTools: ToolRegistration[] = [
    ...createBrowserTools(hostBridge),
    ...(command.computerEnabled ? createComputerTools(hostBridge) : []),
    ...createMemoryTools(hostBridge),
    ...createTodoTools(hostBridge),
    ...createSearchTools(cwd, { rgPath: command.rgPath }),
    ...createAskUserTools(questions),
  ];

  const registry = createRegistry<ToolRegistration>();
  // 工具清单在每次请求解析时活读；MCP 重载后同名替换整个扩展即可。
  const toolsOf = (): ToolRegistration[] =>
    assembleTools(builtin, customTools, mcp.tools, subagents.tool());
  registry.install(buildExtension(toolsOf()));

  // 压缩配置必须**活读**：设置页改完下一次操作就生效（与旧内核同一承诺）。
  // durable 的 settings 每次解析都重读字段，所以这里用一个 getter 而不是快照。
  let compactionSettings: Partial<CompactionPolicy> = {
    enabled: command.compaction.enabled,
    reserveTokens: command.compaction.reserveTokens,
    keepRecentTokens: command.compaction.keepRecentTokens,
    backgroundTokens: command.compaction.backgroundTokens,
  };
  const settings: HarnessSettings = {
    get compaction() {
      return compactionSettings;
    },
  };

  const storagePath = join(command.sessionsRoot, `durable-${command.externalSessionId}.db`);
  const storage = await openNodeSqliteStorage(storagePath, { busyTimeoutMs: 5_000 });
  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      settings,
      // 工具执行环境按「每个对话自己的 cwd」现建——与旧内核「一个会话一个 env」等价，
      // 但子对话（子代理）也有自己的一份，不会互相改 cwd。
      env: (target) => new NodeExecutionEnv({ cwd: target.cwd ?? cwd }),
      onReport: (error) =>
        send({
          type: "log",
          message: `durable 内核上报：${error instanceof Error ? error.message : String(error)}`,
        }),
    },
    context,
  );
  // 恢复崩溃前未完成的任务（durable 自带的能力；旧内核只能重放 lane 运行）
  harness.resume();

  const agentChange: AgentChange = {
    model: { provider: command.provider.id, modelId: command.model },
    thinkingLevel: command.thinkingLevel,
    cwd,
  };
  const conversation = await openConversation(harness, command.kernelSessionId, agentChange);
  await configureConversation(conversation, {
    model: { provider: command.provider.id, modelId: command.model },
    thinkingLevel: command.thinkingLevel,
    cwd,
  });

  const meta: WorkerMeta = {
    sessionId: command.externalSessionId,
    cwd,
    model: `${command.provider.id}/${command.model}`,
    imageInput: model.input?.includes("image") ?? false,
    thinkingLevel: command.thinkingLevel,
    skills: toViewSkills(skills.ref.current),
    fileChanges: [],
    todos: [],
  };

  const current: WorkerState = {
    harness,
    conversation,
    storage,
    registry,
    watch: undefined as never,
    events: undefined as never,
    latest: undefined as never,
    // 全量条目（含压缩之前的历史）：界面历史与模型上下文分开维护
    display: await loadDisplayState(storage, conversation.id, context),
    displayProjected: undefined,
    displaySkillsKey: "",
    models,
    providerId: command.provider.id,
    cwd,
    toolOutputDir: command.toolOutputDir,
    mcp,
    skills,
    diagnose,
    agentsMd: agentsMdInjector,
    memory: memoryInjector,
    userMemory: userMemoryInjector,
    wiki,
    reportMemoryIndex,
    basePrompt,
    agentCatalog: renderAgentCatalog(agents.agents),
    applyCompaction: (config) => {
      compactionSettings = {
        enabled: config.enabled,
        reserveTokens: config.reserveTokens,
        keepRecentTokens: config.keepRecentTokens,
        backgroundTokens: config.backgroundTokens,
      };
    },
    meta,
    lastRun: null,
    abortRequested: false,
    generationFailure: undefined,
    gatedToolCalls: new Set(),
    pendingBaselines: new Map(),
    baselineSent: new Set(),
    toolStarts: new Map(),
    subagents,
    customTools,
    builtinTools: builtin,
  };
  state = current;

  const watch = await conversation.watch(context);
  current.watch = watch;
  current.latest = watch.value;
  watch.start(async (value) => {
    if (!state) return;
    state.latest = value;
    // 只追加、不因 head 前移而丢条目——压缩不该让用户看不到历史
    if (appendDisplayEntries(state.display, value.entries)) state.displayProjected = undefined;
    scheduleFlush();
  });

  const events = await watchEvents(harness, conversation.id, context);
  current.events = events;
  events.start(async (batch) => {
    for (const event of batch) handleAgentEvent(event);
  });

  armMcpLateAttach(current);

  send({
    type: "ready",
    externalSessionId: command.externalSessionId,
    kernelSessionId: encodeKernelSessionId(conversation.id),
    cwd,
    model: meta.model,
  });
  pushView();
}

/**
 * 首次装载超预算转后台的那几台：连上后重建扩展并回报现状。
 * 与旧 worker 的 `armLateMcpAttach` 同义，只是「写回」从 `harness.setTools` 换成 registry 替换。
 */
function armMcpLateAttach(current: WorkerState): void {
  current.mcp.onSettled(() => {
    reinstallTools(current);
    send({ type: "mcpStatus", servers: current.mcp.status() });
  });
}

async function replaceConversation(next: Conversation): Promise<void> {
  if (!state) return;
  const current = state;
  await current.watch.stop().catch(() => undefined);
  await current.events.stop().catch(() => undefined);
  current.conversation = next;
  // 切分支 = 换了一条祖先链：显示缓存必须整份重建（旧分支的条目不能混进来）
  current.display = await loadDisplayState(current.storage, next.id, context);
  current.displayProjected = undefined;
  const watch = await next.watch(context);
  current.watch = watch;
  current.latest = watch.value;
  watch.start(async (value) => {
    if (!state) return;
    state.latest = value;
    if (appendDisplayEntries(state.display, value.entries)) state.displayProjected = undefined;
    scheduleFlush();
  });
  const events = await watchEvents(current.harness, next.id, context);
  current.events = events;
  events.start(async (batch) => {
    for (const event of batch) handleAgentEvent(event);
  });
  // 新分支的 id 必须让主进程持久化——否则重开会话会回到旧分支
  send({
    type: "ready",
    externalSessionId: current.meta.sessionId,
    kernelSessionId: encodeKernelSessionId(next.id),
    cwd: current.cwd,
    model: current.meta.model,
  });
  pushView();
}

/** 把用户输入（文本 + 图片）拼成 durable 的 content */
function inputContent(
  text: string,
  images?: { data: string; mimeType: string }[],
): ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] {
  const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
    { type: "text", text },
  ];
  for (const image of toImageContent(images) ?? []) content.push(image);
  return content;
}

async function prompt(command: Extract<WorkerCommand, { type: "prompt" }>): Promise<void> {
  if (!state) throw new Error("会话尚未初始化");
  const submission = await state.conversation.submit(
    { type: "input", content: inputContent(command.text, command.images) as never },
    context,
  );
  const settled = await submission.wait(context);
  if (settled.status === "unanswered") {
    state.lastRun = { status: "aborted" };
  }
  pushView();
}

async function steer(command: Extract<WorkerCommand, { type: "steer" }>): Promise<void> {
  if (!state) throw new Error("会话尚未初始化");
  await state.conversation.submit(
    {
      type: "input",
      content: inputContent(command.text, command.images) as never,
      whenBusy: "steer",
    },
    context,
  );
}

async function compact(): Promise<void> {
  if (!state) throw new Error("会话尚未初始化");
  const taskId = await state.conversation.compact(undefined, context);
  const settled = await state.harness.waitForTask(taskId, context);
  const outcome = settled.state.outcome;
  if (outcome.status !== "completed") {
    const message =
      outcome.status === "failed" || outcome.status === "faulted"
        ? outcome.error.message
        : outcome.status === "aborted"
          ? (outcome.reason ?? "aborted")
          : `压缩无法完成：${outcome.reason}`;
    send({
      type: "error",
      message: describeCompactOutcome({ status: "failed", error: { message } }),
      fatal: false,
    });
    return;
  }
  const result = outcome.result;
  if (result.entryId === undefined && result.submissionId === undefined) {
    send({
      type: "error",
      message: "没有可压缩的内容：会话还没有消息，或刚压缩过还没有新对话。",
      fatal: false,
    });
    return;
  }
  pushView();
  send({ type: "notice", message: "上下文已压缩：较早的对话已替换为摘要。" });
  const reminder = compactMemoryReminder(state.cwd);
  if (!pendingEphemeralNotices.includes(reminder)) pendingEphemeralNotices.push(reminder);
}

/** 显式技能调用：返回要报给用户的错误文案（成功时为 undefined） */
async function runSkillCommand(
  command: Extract<WorkerCommand, { type: "skill" }>,
): Promise<string | undefined> {
  if (!state) throw new Error("会话尚未初始化");
  const current = state;
  const resolved = resolveSkillInvocation(
    current.skills.ref.current,
    command.name,
    command.instructions,
  );
  if (!resolved.ok) return resolved.error;
  const submission = await current.conversation.submit(
    { type: "input", content: [{ type: "text", text: resolved.text }] },
    context,
  );
  await submission.wait(context);
  pushView();
  return undefined;
}

async function handle(command: WorkerCommand): Promise<void> {
  switch (command.type) {
    case "init":
      await init(command);
      return;

    case "approvalResult":
      approvals.settle(command.toolCallId, command.approved, command.reason);
      return;

    case "askUserResult":
      questions.settle(command.toolCallId, command.answers, command.skipped);
      return;

    case "toolRpcResult":
      hostBridge.settle(command.requestId, command.ok, command.ok ? command.result : command.error);
      return;

    case "todoSnapshot":
      todoMirror = command.todos;
      return;

    case "prompt":
      await prompt(command);
      return;

    case "steer":
      await steer(command);
      return;

    case "browserNotice":
      pendingEphemeralNotices.push(command.text);
      return;

    case "abort": {
      if (!state) return;
      state.abortRequested = true;
      // 主会话中断 → 在跑的子代理一并收掉（它们由各自的工具任务拥有，不随主 run 自动停）
      await state.subagents.abortAll(context);
      // background: true = 连后台任务一起收（与旧 worker「主会话中断则子代理一并收掉」一致）
      await state.conversation.abort(context, { background: true });
      pushView();
      return;
    }

    case "subagentAbort": {
      if (!state) throw new Error("会话尚未初始化");
      await state.subagents.abort(command.id, context);
      return;
    }

    case "subagentTranscript": {
      if (!state) throw new Error("会话尚未初始化");
      // 注册表里有就用它；没有（worker 重启过）就按 id 里的会话号从内核读回来。
      const transcript = await state.subagents.transcript(command.id, context);
      const { messages, toolResults } =
        transcript === undefined
          ? { messages: [], toolResults: [] }
          : projectTranscript(transcript, new Map<string, number>());
      send({ type: "subagentTranscript", id: command.id, messages, toolResults });
      return;
    }

    case "setModel": {
      if (!state) throw new Error("会话尚未初始化");
      const current = state;
      if (command.provider.id !== current.providerId && !current.models.getProvider(command.provider.id)) {
        current.models.setProvider(buildProvider(command.provider, command.apiKey));
      }
      const next = current.models.getModel(command.provider.id, command.modelId);
      if (next === undefined) {
        throw new Error(`模型不可用：${command.provider.id}/${command.modelId}`);
      }
      await current.conversation.configure(
        { model: { provider: command.provider.id, modelId: command.modelId } },
        context,
      );
      current.providerId = command.provider.id;
      current.meta.model = `${command.provider.id}/${command.modelId}`;
      current.meta.imageInput = next.input?.includes("image") ?? false;
      send({
        type: "modelChanged",
        providerId: command.provider.id,
        modelId: command.modelId,
      });
      pushView();
      return;
    }

    case "setThinkingLevel": {
      if (!state) throw new Error("会话尚未初始化");
      await state.conversation.configure({ thinkingLevel: command.level }, context);
      state.meta.thinkingLevel = command.level;
      pushView();
      return;
    }

    case "compact":
      await compact();
      return;

    case "memoryTidy": {
      if (!state) throw new Error("会话尚未初始化");
      const current = state;
      // 主对话忙时拒绝：整理会重写记忆文件，而运行中的任务也可能正在沉淀记忆。
      const live = current.latest.docs["pi.live"] as { run?: unknown } | undefined;
      const inbox = current.latest.docs["pi.inbox"] as { items?: unknown[] } | undefined;
      if (live?.run !== undefined || (inbox?.items?.length ?? 0) > 0) {
        send({
          type: "error",
          message:
            "当前会话有进行中的任务，无法整理记忆：整理会重写记忆文件，可能与任务同时改它。请等任务结束。",
          fatal: false,
        });
        return;
      }
      const modelRef = splitModelRef(current.meta.model);
      const outcome = await runMemoryTidy(
        {
          harness: current.harness,
          cwd: current.cwd,
          model: { provider: modelRef.provider, modelId: modelRef.model },
          tools: current.registry.snapshot().tools().map((entry) => entry.tool),
          reportMemoryIndex: current.reportMemoryIndex,
        },
        context,
      );
      if (outcome.ok) send({ type: "notice", message: outcome.notice });
      else send({ type: "error", message: outcome.message, fatal: false });
      return;
    }

    case "skill": {
      const error = await runSkillCommand(command);
      if (error !== undefined) send({ type: "error", message: error, fatal: false });
      return;
    }

    case "skillsStatus":
    case "skillsRescan":
    case "skillsSetDisabled": {
      if (!state) throw new Error("会话尚未初始化");
      const current = state;
      const status = await current.skills.enqueue(() =>
        handleSkillsCommand(command, current.skills.host),
      );
      send({ type: "skillsStatus", status });
      return;
    }

    case "navigate": {
      if (!state) throw new Error("会话尚未初始化");
      const target = Number.parseInt(command.targetId, 10);
      if (!Number.isFinite(target)) {
        send({ type: "error", message: `无法定位分支目标：${command.targetId}`, fatal: false });
        return;
      }
      try {
        // durable 的分支语义是 fork（head write 只是回卷，不会砍掉未来）。
        // 新会话继承到目标条目为止的历史，之后的提问落在新分支上。
        const forked = await state.conversation.fork(
          target as EntryId,
          { ownership: { kind: "ownerless" } },
          context,
        );
        await replaceConversation(forked);
      } catch (error) {
        send({
          type: "error",
          message: `分支跳转失败：${error instanceof Error ? error.message : String(error)}`,
          fatal: false,
        });
      }
      return;
    }

    case "mcpStatus":
      send({ type: "mcpStatus", servers: state?.mcp.status() ?? [] });
      return;

    case "mcpReload": {
      if (!state) throw new Error("会话尚未初始化");
      const result = await state.mcp.reload();
      reinstallTools(state);
      send({ type: "mcpStatus", servers: result.statuses });
      return;
    }

    case "setCompaction": {
      if (!state) throw new Error("会话尚未初始化");
      const config: CompactionConfig = normalizeCompactionConfig(command.config);
      // 直接改活配置对象：durable 每次解析设置都重读字段（与旧内核「下一次操作起生效」同一口径）
      state.applyCompaction(config);
      return;
    }

    case "diagnoseEnabled":
      state?.diagnose.setEnabled(command.enabled);
      return;

    case "dispose": {
      if (state) {
        const current = state;
        state = undefined;
        await current.watch.stop().catch(() => undefined);
        await current.events.stop().catch(() => undefined);
        current.subagents.dispose();
        current.diagnose.dispose();
        await current.mcp.close().catch(() => undefined);
        await current.harness.close(context).catch(() => undefined);
      }
      hostBridge.dispose();
      questions.dispose();
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
