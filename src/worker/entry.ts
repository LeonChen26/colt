// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

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
import { createModels } from "@earendil-works/pi-ai";
import type {
  FileBaseline,
  ViewFileChange,
  ViewSkill,
  WorkerBranchNode,
  WorkerCommand,
  WorkerMessage,
} from "@shared/worker-protocol";
import { buildProvider } from "@shared/provider-factory";
import { APPROVAL_TIMEOUT_MS } from "@shared/limits";
import type { ThinkingLevel } from "@shared/thinking-level";
import { READONLY_TOOLS } from "@shared/readonly-tools";
import { type ViewTodo, renderTodoBlock } from "@shared/todo";

import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  countPatchLines,
  project,
  projectBranchNodes,
  projectTranscript,
  toRelative,
  type BranchEntry,
} from "./lib/project";
import { foreignLaneTips, ownedEntries, visibleEntries } from "./lib/lane-ownership";
import { healLaneTools } from "./lib/lane-heal";
import { spillToolImages } from "./lib/tool-image-spill";
import { HostBridge } from "./lib/host-bridge";
import { ApprovalBridge, trace } from "./lib/approval-bridge";
import { captureBaseline } from "./lib/baseline";
import { createAskUserGateway, createAskUserTools, isQuestionTool } from "./lib/ask-user-tool";
import { agentDirs, describeAgents, loadAgentDefs, renderAgentCatalog } from "./lib/agent-defs";
import {
  Subagents,
  isSubagentLane,
  isSubagentTool,
  subagentSystemPrompt,
} from "./lib/subagent";
import {
  forgetToolLane,
  rememberDuration,
  rememberToolLane,
  subagentRefOf,
  subagentRefOfLane,
  toolDurations,
} from "./lib/tool-bookkeeping";
import { createBrowserTools } from "./lib/browser-tool";
import { createComputerTools } from "./lib/computer-tool";
import { createMemoryTools } from "./lib/memory-tool";
import { createTodoTools } from "./lib/todo-tool";
import { ToolCallTracker, MAIN_LANE, handleUsageEvent } from "./lib/telemetry";
import {
  compactDoneMessage,
  describeCompactError,
  describeCompactOutcome,
} from "./lib/compact-error";
import {
  TIDY_LANE,
  TIDY_TOOLS,
  describeTidyError,
  describeTidyOutcome,
  memoryTidyDoneNotice,
  memoryTidySystemPrompt,
  memoryTidyTask,
} from "./lib/memory-tidy";
import {
  composeSystemPrompt,
  enabledSkills,
  loadSkillsForSessionWithConfig,
  modelSkills,
} from "./lib/skills";
import { skillsUserHome } from "@shared/skills-config";
import { createSkillsRuntime, dispatchSkills, type SkillsRuntime } from "./lib/skills-command";
import {
  compactMemoryReminder,
  createMemoryInjector,
  describeMemory,
  loadProjectMemory,
  memoryFilePath,
  readMemoryFile,
  userMemoryFilePath,
} from "./lib/memory";
import { createMcpRuntime, mcpUserHome, type McpRuntime } from "./lib/mcp-tools";
import { composeMcpInstructions, handleMcpCommand } from "./lib/mcp-reload";
import { systemPrompt } from "./lib/system-prompt";
import { toImageContent } from "./lib/attachments";
import {
  createAgentsMdInjector,
  describeAgentsMd,
  loadAgentsMd,
} from "./lib/agents-md";

const context: Context = BACKGROUND_CONTEXT;

/**
 * 审批往返（实现见 `lib/approval-bridge`）：worker 发起请求后阻塞，等主进程的 approvalResult。
 * 主进程持有策略与用户界面，worker 只负责阻塞与执行结果。
 */
const approvals = new ApprovalBridge(send);

/**
 * 提问的阻塞往返（状态与超时都在这个对象里，见 `lib/ask-user-tool.ts`）。
 * 超时上限与审批共用 `APPROVAL_TIMEOUT_MS`——两侧不一致会静默挂死（`shared/limits.ts`）。
 * 来源 lane 的记账见 `lib/tool-bookkeeping`（审批与提问共用同一张表）。
 */
const questions = createAskUserGateway(send, APPROVAL_TIMEOUT_MS, subagentRefOf);

/**
 * 一次性「临时提醒」队列：等下一次模型请求前注入，不进 transcript、也不触发运行。
 *
 * 现有两类：① 用户手动操作浏览器（前进 / 后退 / 刷新）后「你手里的页面状态过期了」；
 * ② 压缩完成后的记忆沉淀提醒。都不是用户发言、也不该开启或插入一轮，
 * 只是让模型下次开口前知道这件事。注入点与理由见 init 里的 transform_context。
 */
const pendingEphemeralNotices: string[] = [];

function send(message: WorkerMessage): void {
  process.parentPort?.postMessage(message);
}

/** 宿主能力客户端：浏览器/桌面的实际执行在主进程，这里只发命令等结果 */
const hostBridge = new HostBridge(send);

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
  /** 工具图片落盘目录（主进程下发；见 @shared/tool-output） */
  toolOutputDir: string;
  snapshot: LaneSnapshot;
  /**
   * 子代理总账。放在 state 上而不是留在 init 的闭包里：`pushView` 也需要它
   * （视图里的 `subagents` 正是从这里投影的），而 pushView 在模块级。
   */
  subagents: Subagents;
  /** MCP 运行态（各 server 的连接 + 工具）；dispose 收尸与 mcpStatus/mcpReload 命令都用它 */
  mcp: McpRuntime;
  /** 技能运行期（可变清单 + 设置页宿主）：命令分发也要读它，故挂在 state 上而不是 init 闭包里 */
  skills: SkillsRuntime;
  /** 结构性变更（分支跳转、压缩）后需要重建快照 */
  resnapshot: () => Promise<LaneSnapshot>;
  /**
   * 记忆索引上报（init 里装配的去重闭包）。整理（memoryTidy）刚改写过记忆文件时
   * 立即重读上报一次用——常规同步靠下一次注入重读，那次可能很久以后才来；
   * 刚整理完就该让检索索引跟上（被清理的条目就地归档进冷层）。
   */
  reportMemoryIndex: (scope: "project" | "user", content: string | null) => void;
  meta: {
    sessionId: string;
    cwd: string;
    model: string;
    imageInput: boolean;
    /** 会话思考等级（投影到 view，供界面下拉回显） */
    thinkingLevel: ThinkingLevel;
    /**
     * 本会话装载到的技能（整份 `ViewSkill`，见 `toViewSkills`）。
     *
     * 两个用处：worker 用它给 `/skill <名字>` 兜底自查、渲染层用**名字**就地拦下打错的
     * ——所以它必须跟着 view 一起发出去，少了它用户敲错一个字母就得连那半句额外指示一起重敲。
     * 设置页「重新扫描」会就地换掉它（`state.skills` 那边同时更新，两条路径同源）。
     */
    skills: ViewSkill[];
    fileChanges: ViewFileChange[];
    /** 待办清单：投影时恒为空，主进程会用库里的完整清单覆盖它（真源在主进程） */
    todos: ViewTodo[];
    contextUsed: number;
  };
  unsubscribe: () => void;
}

/** 把全部条目投影成分支树（session 级扫描，含所有分支）。
 *  只保留用户输入、各轮最终回复与结构节点，折叠中间的 LLM 轮次与工具调用。
 *
 *  ⚠️ 会话级扫描会**连带扫到子 lane**（记忆整理 / 子代理）的条目：`fresh` 子 lane 的链
 *  自成一根，不过滤就会在左栏凭空多出一个可点的根节点。排除与导航守卫共用同一个集合
 *  （见 `lib/lane-ownership`）。 */
async function foreignLaneEntryIds(current: WorkerState): Promise<Set<string>> {
  const [entries, lanes] = await Promise.all([
    current.session.findEntries({ order: "asc" }, context),
    current.harness.lanes(context),
  ]);
  return ownedEntries(foreignLaneTips(lanes, current.lane.name), entries);
}

async function projectBranches(current: WorkerState): Promise<WorkerBranchNode[]> {
  const [entries, tipId, lanes] = await Promise.all([
    current.session.findEntries({ order: "asc" }, context),
    current.lane.getTipId(context),
    current.harness.lanes(context),
  ]);
  const owned = ownedEntries(foreignLaneTips(lanes, current.lane.name), entries);
  return projectBranchNodes(
    visibleEntries(entries as unknown as BranchEntry[], owned) as BranchEntry[],
    tipId ?? null,
  );
}

let state: WorkerState | undefined;
/**
 * 待办清单的**镜像**：主进程是唯一写入方，每次写入后整份推来一份（`todoSnapshot`）。
 *
 * 为什么 worker 手里要有这一份：`transform_context` 是**同步**的，要在每次模型请求前把
 * 清单拼进系统提示词，就不能在热路径上现拉一次 RPC（延迟与失败模式都更差）。
 * ⚠️ 它只是缓存，**真源是主进程的库**；worker 重启后由主进程在 `ready` 时补发。
 */
let todoMirror: ViewTodo[] = [];
/** 流式期间合并推送，避免每个 token 一次 IPC */
let flushTimer: NodeJS.Timeout | undefined;
/** 已落盘的工具图片记账（每个 worker 生命周期一份，见 lib/tool-image-spill） */
const spilledImages = new Set<string>();

/**
 * 推一次完整视图——**所有 `session.view` 的唯一出口**。
 *
 * 为什么要有这个漏斗：图片不进视图（见 `@shared/tool-output`），而落盘必须发生在
 * 「视图被推出去之前」——否则渲染层会先拿到一个 `hasImage`、却读不到对应文件的窗口。
 * 这段逻辑若散在 8 处各写一遍，迟早漏掉一处，故收敛到一个函数。
 *
 * 推前先用 SHA-256 摘要去重（F7 ③「无变化不重推」）：流式期间 50ms 节流会把**整份**
 * 视图在 worker→main、main→renderer 两段各克隆一次，而触发漏斗的并不全是真变化
 * （思考静默期的重复事件、多个子系统同 burst 内各触发一次）。摘要相同即跳过——省掉
 * 整段克隆 + 主进程处理 + 渲染层 diff 的开销；代价是每趟多一次序列化（结构化克隆反正
 * 也要做），「真在流式」纯付出、「静默/重复」净赚。摘要用 SHA-256 而非留存整份 JSON：
 * 2937 条消息的会话不能把整份序列化结果常驻内存。
 */
let lastPushedDigest = "";
function pushView(): void {
  if (!state) return;
  spillToolImages(state.snapshot.transcript, state.toolOutputDir, spilledImages);
  const view = project(state.snapshot, state.meta, toolDurations, state.subagents.toView());
  const digest = createHash("sha256").update(JSON.stringify(view)).digest("hex");
  if (digest === lastPushedDigest) return;
  lastPushedDigest = digest;
  send({ type: "view", view });
}

function scheduleFlush(): void {
  if (flushTimer || !state) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    pushView();
  }, 50);
}

async function init(command: Extract<WorkerCommand, { type: "init" }>): Promise<void> {
  const {
    cwd,
    sessionsRoot,
    model: modelId,
    provider: providerConfig,
    thinkingLevel,
  } = command;

  const models = createModels();
  models.setProvider(buildProvider(providerConfig));
  const model = models.getModel(providerConfig.id, modelId);
  if (!model) throw new Error(`模型不可用：${providerConfig.id}/${modelId}`);

  const executionEnv = new NodeExecutionEnv({ cwd });
  const repo = new JsonlSessionRepo({ fileSystem: executionEnv, sessionsRoot });
  const session = await openSession(repo, command.kernelSessionId, cwd);

  // 技能（Agent Skills，agentskills.io 标准）：项目级 `.agents/skills` 与用户级 `~/.agents/skills`
  // 各扫一遍，同名时项目级胜出；每请求拼进系统提示词 + 进 `resources.skills` + 随视图下发。
  // 装载 / 告警 / 设置页「重新扫描」的热更新都在 lib/skills-command.ts。技能来自磁盘且会改模型
  // 行为，是隐式信任通道，跳过了什么必须可见（`docs/SECURITY.md`）。
  const skills = await createSkillsRuntime({
    reload: () => loadSkillsForSessionWithConfig(executionEnv, cwd, skillsUserHome(), context),
    cwd,
    harness: () => state?.harness,
    onNotice: (message) => send({ type: "notice", message, kind: "security" }),
    onViewSkills: (list) => {
      if (state) state.meta.skills = list;
    },
    onChanged: scheduleFlush,
  });

  // 子代理定义（声明式 agents）：`<cwd>/.agents/agents/*.md` 与 `~/.agents/agents/*.md`，
  // 同名时项目级胜出。与技能同一条隐式信任通道——定义决定子代理的系统提示词与工具白名单，
  // 装了什么、哪个文件坏了、被谁遮蔽，都要如实报出来（docs/SECURITY.md）。
  const agents = await loadAgentDefs(agentDirs(cwd, homedir()));
  const agentsNotice = describeAgents(agents);
  if (agentsNotice !== null) send({ type: "notice", message: agentsNotice, kind: "security" });

  // AGENTS.md（agents.md 标准）：人机共同维护的项目约定文档，从 cwd 一路向上
  // 收集父目录。与记忆分工：AGENTS.md 收成文的约定（构建/风格/协作规范），
  // 记忆收助手自己的沉淀；助手可以在用户要求时写它（opencode/codex 的 /init
  // 同款语义），项目内文件、走常规审批。这里只做启动装载与告知（隐式信任通道，
  // 见 docs/SECURITY.md）；真正的注入在下面的 transform_context——每请求重新
  // 发现并读取，中途创建/更新下一次请求立即可见，文件集合变化会通知。
  const agentsMd = await loadAgentsMd(cwd);
  const agentsMdNotice = describeAgentsMd(agentsMd);
  if (agentsMdNotice !== null) send({ type: "notice", message: agentsMdNotice, kind: "security" });
  const agentsMdInjector = createAgentsMdInjector(cwd, (message) =>
    send({ type: "notice", message, kind: "security" }),
  );

  // 双级记忆（.colt/memory.md + ~/.colt/memory.md）：助手自己维护的跨会话记忆，
  // 项目级记项目内的事实，用户级记跨项目成立的偏好与习惯。
  // 这里只装载与告知；真正的注入在下面的 transform_context——每次模型请求重读，
  // 会话中途的写入立即生效。读取失败不拦会话——记忆缺位比会话打不开便宜得多。
  // 注意用户级在项目之外：助手写它按 docs/SECURITY.md 属 dangerous、每次单独确认。
  const memory = await loadProjectMemory(cwd);
  const memoryNotice = describeMemory(memory, "project");
  if (memoryNotice !== null) send({ type: "notice", message: memoryNotice, kind: "security" });
  const userMemory = await readMemoryFile(userMemoryFilePath(homedir()));
  const userMemoryNotice = describeMemory(userMemory, "user");
  if (userMemoryNotice !== null) send({ type: "notice", message: userMemoryNotice, kind: "security" });

  // 记忆检索索引（L3a）：文件是真源，主进程侧维护派生索引（data/memory.db）。
  // 启动即报快照；此后注入器每请求重读，内容变化才续报（失败不报——没消息 = 维持原状，
  // 读取失败不能被误当成「文件被删了」而把现行条目归档）。
  const lastIndexed = new Map<"project" | "user", string | null>();
  const reportMemoryIndex = (scope: "project" | "user", content: string | null) => {
    if (lastIndexed.get(scope) === content) return;
    lastIndexed.set(scope, content);
    send({ type: "memoryIndex", scope, content });
  };
  if (memory.error === undefined) reportMemoryIndex("project", memory.content);
  if (userMemory.error === undefined) reportMemoryIndex("user", userMemory.content);
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

  // 子代理编排。工具在 `AgentHarness.create` **之前**就要交出去，而那时 `state` 还不存在，
  // 故 harness 用惰性取值器——`execute` 真正被调用时 state 必然已经建好了。
  const subagents = new Subagents({
    mainLane: MAIN_LANE,
    defs: agents.agents,
    harness: () => state?.harness,
    onUpdate: () => scheduleFlush(),
  });

  const mcp = await createMcpRuntime(cwd, (message) => send({ type: "notice", message, kind: "security" }), mcpUserHome());

  // 给模型的技能副本：先滤掉被禁用的（P6），再对超长正文截断并指回文件（P7）；
  // 装载结果本身既不滤也不截——设置页要看全文、要画开关。
  const harnessSkills = modelSkills(skills.ref.current);

  const { harness, open } = await AgentHarness.create(
    {
      session,
      models,
      model,
      resources: harnessSkills.length > 0 ? { skills: harnessSkills } : undefined,
      tools: [
        createReadTool(),
        createWriteTool(),
        createEditTool(),
        createBashTool(),
        ...createBrowserTools(hostBridge),
        ...createComputerTools(hostBridge),
        ...createMemoryTools(hostBridge),
        ...createTodoTools(hostBridge),
        ...createAskUserTools(questions),
        ...subagents.tools(), ...mcp.tools,
      ],
      toolContext: { env: executionEnv },
      // create-time 静态部分只有**基础提示词**本身；技能清单、AGENTS.md、记忆块都在
      // transform_context 里每请求重拼——技能清单放那里是「重新扫描」能当轮生效的前提（A2），
      // 其余几块本来就要每请求重读。
      systemPrompt: systemPrompt(cwd),
      // 只对**新建 lane** 生效；已存在的会话沿用自己持久化的值，
      // 故下面还有一步显式下发（见 lane 拿到之后的注释）
      thinkingLevel,
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
    // lane 必须在这里记：审批与提问的入口只有 toolCallId，而它们要标出「来自哪个子代理」。
    // 记在**所有提前返回之前**——ask_user 在下一行就被放行，漏掉它就永远查不到来源。
    rememberToolLane(event.toolCallId, event.lane);
    // ask_user 不受审批管辖：它是「向人要信息」，走审批通道会被 auto / full-access
    // 模式静默批准成「已通过」——模型拿到的是假答案
    if (isQuestionTool(event.toolName)) return undefined;
    // subagent 自身同样豁免闸门（理由与 ask_user 不同，见 docs/DESIGN-subagents.md 决策四）：
    // 否则同一件事弹两次卡（委派一次 + 子代理内部工具各一次），用户会去关审批——那更糟。
    // 安全性不降：委派的副作用**全部落在子代理的工具调用上**，那里照样过本闸门。
    if (isSubagentTool(event.toolName)) return undefined;
    gatedToolCalls.add(event.toolCallId);
    if (
      (event.toolName === "edit" || event.toolName === "write") &&
      typeof event.args.path === "string"
    ) {
      pendingBaselines.set(event.toolCallId, captureBaseline(cwd, event.args.path));
    }
    trace(`hook 触发 ${event.toolName} ${event.toolCallId}`);
    const decision = await approvals.request(
      event.toolCallId,
      event.toolName,
      event.args,
      subagentRefOfLane(event.lane),
    );
    trace(`得到答复 ${event.toolName} approved=${decision.approved}`);
    if (decision.approved) return undefined;
    // terminate 不置位：只拦这一次调用，让模型知悉后自行调整，不终止整个对话
    return { block: { reason: decision.reason } };
  });

  // 临时提醒（浏览器手动操作后的页面过期提示、压缩后的沉淀提醒）→ 告知 agent。
  //
  // 用 transform_context 而不是 steer / prompt：这两种都会**开启或插入一轮**，让 agent 去回应，
  // 而这里要的只是「它下次开口前知道这件事」。transform_context 是内核为此准备的扩展点
  // （按注释：把应用自定义的信息转成模型上下文），每个模型请求前都会跑一次、
  // 返回的 messages 只作用于**这一次请求**，故不写进 transcript——
  // 否则对话与分支树里会凭空多出一轮「用户说……」的假历史，还会被压缩摘要当成真实对话。
  harness.hooks.on("transform_context", (event) => {
    // 临时提醒是**主对话**的东西：别的 lane（整理、子代理）的请求同样会触发本钩子，
    // 不分流的话提醒会被那一轮消费掉，主对话反而看不到。判据用「不是主 lane 一律不碰」——
    // 枚举「哪些 lane 要排除」的话，将来每加一种 lane 都得回来补一次。
    if (event.lane !== MAIN_LANE) return undefined;
    if (pendingEphemeralNotices.length === 0) return undefined;
    const text = pendingEphemeralNotices.splice(0, pendingEphemeralNotices.length).join("\n");
    return {
      messages: [...event.messages, { role: "user", content: text, timestamp: Date.now() }],
    };
  });

  // 每请求注入（与 messages 注入由内核按注册顺序串行组合，互不覆盖）：
  // AGENTS.md（父链约定）→ 用户级记忆 → 项目级记忆，一般 → 具体，越具体的越靠近内容。
  // 内容不变时拼出的串逐字相同，提示词缓存照常命中；变了才失效一次。
  // 读取失败由各注入器回落/降级并只报一次。
  harness.hooks.on("transform_context", async (event) => {
    // 整理 lane 用专用提示词：它不是编码助手，AGENTS.md / 记忆块对它没有意义。
    // 必须在这里返回——不返回（undefined）就会沿用 harness 级的编码系统提示词。
    if (event.lane === TIDY_LANE) {
      return { systemPrompt: memoryTidySystemPrompt(cwd) };
    }
    // 子代理：**定义正文** + AGENTS.md 块。刻意**不注入记忆、不注入技能清单**——
    // 记忆是主对话的沉淀优势，注入等于把父的上下文偷渡给子代理；技能清单会暗示
    // 「你可以调技能」，而子代理的工具面是硬白名单、根本没有 skill 能力（死入口，§3.6）。
    // 定义可能已被删掉（磁盘上的文件没了）——那时给通用兜底正文，而不是落回编码助手提示词。
    if (isSubagentLane(event.lane)) {
      const withAgentsMd = await agentsMdInjector.systemPromptFor("");
      return {
        systemPrompt: subagentSystemPrompt(
          subagents.definitionForLane(event.lane),
          withAgentsMd,
        ),
      };
    }
    // 技能清单**每请求重拼**（不是 create-time 一次）：设置页「重新扫描」才能当轮生效（A2）。
    // 拼在最前（基础提示词之后）以保持段落顺序不变，内容不变时缓存照常命中。
    let withContext = composeSystemPrompt(event.systemPrompt, enabledSkills(skills.ref.current));
    withContext = await agentsMdInjector.systemPromptFor(withContext);
    withContext = await userMemoryInjector.systemPromptFor(withContext);
    withContext = await memoryInjector.systemPromptFor(withContext);
    // 待办清单（每请求）：与记忆块同一处注入、同样走 systemPrompt。
    // 清单**必须每请求重拼**——内核只接受 create-time 的 systemPrompt，它不会帮我们重算
    // （`AGENTS.md` §四「把库提供了函数当成库会调用它」的同族坑）。内容不变时拼出的串
    // 逐字相同，提示词缓存照常命中；空清单不产出任何东西（`renderTodoBlock` 的口径）。
    const todoBlock = renderTodoBlock(todoMirror);
    if (todoBlock !== "") withContext = `${withContext}\n\n${todoBlock}`;
    // 子代理目录：**必须应用自己拼**——内核的 AgentTool 没有任何「往提示词里塞清单」的钩子，
    // 不拼的话模型根本不知道有哪些子代理可用，而装载/告警/计数全绿（§四那次翻车的同族）。
    // 只在主 lane 注入：注进子 lane 会暗示递归（而递归是明令禁止的）。
    const catalog = renderAgentCatalog(agents.agents);
    if (catalog !== "") withContext = `${withContext}\n\n${catalog}`;
    // MCP server 自报的用法说明。**必须应用自己拼**——SDK 只给 client.getInstructions() 这个
    // 取值口、一处都不替你调，不拼就是静默丢掉（§四「把库提供了函数当成库会调用它」，技能同坑）
    withContext = composeMcpInstructions(withContext, mcp);
    return { systemPrompt: withContext };
  });

  // 纵深防御：若有影响性工具执行完却没经过闸门，说明拦截链路漏了。
  // 宁可吐一个显眼告警，也不能静默地把它放过去。
  harness.hooks.on("after_tool", (event) => {
    // 记过的 lane 到这里就没人再需要了（提问/审批都已答复完），清理避免长会话无界增长
    forgetToolLane(event.toolCallId);
    // 提问与委派同样不必过闸门（见 before_tool），别让纵深防御把它们误报成「拦截链路漏了」
    if (
      READONLY_TOOLS.has(event.toolName) ||
      isQuestionTool(event.toolName) ||
      isSubagentTool(event.toolName)
    ) {
      return undefined;
    }
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

  // 用量落库：每产生一条 usage 行上报一次；过滤（非主 lane、adjustment 行）与占用写回
  // 见 handleUsageEvent——占用写回触发 view 推送让进度条实时更新；会话未就绪时跳过副作用。
  harness.events.on("usage", (event) => {
    const upload = handleUsageEvent(event, {
      modelRef: state?.meta.model ?? `${providerConfig.id}/${modelId}`,
      fallbackProvider: providerConfig.id,
      now: Date.now(),
      onContextUsed: state
        ? (used) => {
            state!.meta.contextUsed = used;
            scheduleFlush();
          }
        : undefined,
    });
    if (upload) send(upload);
  });

  // 工具调用落库：配对 tool_start/tool_end 得到耗时与入参，在 end 时上报一条
  const toolTracker = new ToolCallTracker();
  harness.events.on("tool_start", (event) => toolTracker.start(event.toolCallId, event.args, Date.now()));
  harness.events.on("tool_end", (event) => {
    const upload = toolTracker.end(event, Date.now());
    if (upload) {
      rememberDuration(upload.toolCallId, upload.durationMs);
      send(upload);
    }
  });

  const lane = await harness.lane(MAIN_LANE, context);
  // 恢复旧会话时，lane 持久化配置里的模型可能已在本进程不存在（provider 被删、模型下线、
  // 或测试残留）：内核恢复语义是原样采纳持久化配置（create 传入的模型只用于新建 lane），
  // 不校验可用性，第一条消息就会以 model_unavailable 失败。这里与主进程 resolveSessionModel
  // 的「失效回退」对齐：解析不了就用本次 init 的模型愈合（setModel 会把修复写回会话）。
  // 解析得了就不动——注册表里只有 init 装配的 provider，能解析即与 init 同源，属会话自己的选定。
  if ((await lane.getModel(context)) === undefined) {
    await lane.setModel({ provider: providerConfig.id, modelId }, context);
  }

  // 思考等级同理，但**不能**只靠 create 的种子：内核只在新 lane 时套用种子，
  // 已有会话会原样采纳自己持久化的值。老会话存的 off 是当年的默认值（谁都没选过），
  // 而 off 会被 provider 兼容层翻译成「显式关闭思考」（zai 协议必写 thinking.type=disabled），
  // 「始终思考」的模型见到就直接 400——压缩、审批分析器这类**不带工具**的请求会整条失效。
  // 仅在确有差异时写：setThinkingLevel 不做等值短路，无条件调用会让每次开会话都多一条配置事件。
  if ((await lane.getThinkingLevel(context)) !== thinkingLevel) {
    await lane.setThinkingLevel(thinkingLevel, context);
  }
  // 工具清单同理，而且**同样不能只靠 create 的种子**：内核只对新建 lane 套用 seed，
  // 存量会话沿用自己持久化的清单。不补的话，老会话永远看不到后来新增的工具（子代理就是）。
  await healLaneTools(lane, (await harness.getTools(context)).map((tool) => tool.name), context);
  const watch = await lane.watch(context);
  // 投影一律使用 Colt 的会话 ID，渲染层才能正确匹配
  // fileChanges 始终为空——主进程会用数据库中的完整列表覆盖它
  const meta = {
    sessionId: command.externalSessionId,
    cwd,
    model: `${providerConfig.id}/${modelId}`,
    // 模型目录声明的输入能力；纯文本模型（如 deepseek-v4-flash）不含 "image"
    imageInput: model.input?.includes("image") ?? false,
    thinkingLevel,
    skills: skills.view(),
    fileChanges: [] as ViewFileChange[],
    // 与 fileChanges 同理：投影时恒为空，主进程会用数据库里那份完整清单覆盖它
    todos: [] as ViewTodo[],
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
    toolOutputDir: command.toolOutputDir,
    snapshot: watch.snapshot,
    resnapshot: () => watch.resnapshot(context),
    reportMemoryIndex,
    subagents,
    mcp,
    skills,
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
  pushView();

  // 恢复上次退出时未完成的运行
  for (const operation of open) {
    void (async () => {
      try {
        const target =
          operation.lane === lane.name ? lane : await harness.lane(operation.lane, context);
        // 子代理的恢复**不做**：它的结果接收方是主 lane 那次 `subagent` 调用，而崩溃时那次调用
        // 已被合成 interrupted——没有接收方，resume 只会在后台烧到自然结束（无墙钟上限，界面
        // 也看不见它：新进程注册表是空的）。直接中止，把这个悬挂运行收干净。
        if (isSubagentLane(operation.lane)) {
          await target.abort(context).catch(() => undefined);
          send({ type: "log", message: `已中止崩溃前未完成的子代理运行：${operation.lane}` });
          return;
        }
        const resumed = await target.resume(context);
        send({ type: "log", message: `已恢复未完成的运行：${operation.lane}` });
        // 整理 lane 续跑完同样要有结果出口：子 lane 对界面不可见，崩溃打断的整理
        // 如果恢复跑完不报一声，用户只会看到文件变了而没有任何解释。
        if (operation.lane === TIDY_LANE && state && resumed.ok) {
          if (resumed.value.status === "suspended") {
            settleSuspendedTidy(target, resumed.value.operationId);
          } else {
            await settleTidyRun(state, resumed.value);
          }
        }
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

/**
 * 整理落定后的统一出口：成功 → 立即重报记忆索引 + 完成通知；否则 → 可见报错。
 *
 * 子 lane 对界面不可见（主 lane 的 watch 看不到它），这就是整理唯一的「结果出口」——
 * 正常结算、挂起后的补报、崩溃恢复后的补报三条路径共用，谁都不能悄悄结束。
 */
async function settleTidyRun(
  current: WorkerState,
  record: { status: string; error?: { code?: string; message?: string } } | undefined,
): Promise<void> {
  if (!record || record.status !== "completed") {
    send({
      type: "error",
      message: describeTidyOutcome(record ?? { status: "failed" }),
      fatal: false,
    });
    return;
  }
  // 整理刚可能重写过记忆文件：立即重读上报，让检索索引同步（被清理的条目就地归档，
  // 仍可 memory_search 找回）。不等下一次注入重读——那次可能很久以后才来。
  const fresh = await readMemoryFile(memoryFilePath(current.meta.cwd));
  if (fresh.error === undefined) current.reportMemoryIndex("project", fresh.content);
  send({ type: "notice", message: memoryTidyDoneNotice() });
}

/** 挂起的 run 落定后补报结果。通知没有别的机制会发——「完成后另行通知」必须由这里兑现 */
function settleSuspendedTidy(target: AgentLane, operationId: string): void {
  void target
    .waitForIdle(context)
    .then(() => target.getResult(operationId, context))
    .then((settled) => (state ? settleTidyRun(state, settled) : undefined))
    .catch(() => undefined);
}

async function handle(command: WorkerCommand): Promise<void> {
  switch (command.type) {
    case "init":
      await init(command);
      return;

    // 审批答复不依赖会话状态，也不能报错中断：阻塞的 hook 必须被唤醒
    case "approvalResult":
      approvals.settle(command.toolCallId, command.approved, command.reason);
      return;

    // 提问答复：同样必须能唤醒阻塞的工具（ask_user 的 execute 正挂在这上面）
    case "askUserResult":
      questions.settle(command.toolCallId, command.answers, command.skipped);
      return;

    // 宿主能力答复：唤醒阻塞在 callHost 的工具，同样不能依赖会话状态
    case "toolRpcResult":
      hostBridge.settle(command.requestId, command.ok, command.ok ? command.result : command.error);
      return;

    // 待办清单镜像：主进程每次写入后整份推来，这里**整份覆盖**。
    // 不依赖会话状态（`state` 还没建好时也要收下）——`ready` 之前主进程也可能推。
    case "todoSnapshot":
      todoMirror = command.todos;
      return;

    case "prompt": {
      if (!state) throw new Error("会话尚未初始化");
      await state.lane.prompt(command.text, toImageContent(command.images), context);
      // 运行结束后补推一次终态
      pushView();
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
      pendingEphemeralNotices.push(command.text);
      return;
    }

    case "abort": {
      if (!state) return;
      // 主会话中断 → **在跑的子代理一并收掉**。它们跑在自己的 lane 上，不会随主 lane
      // 一起停；不收就会继续烧钱跑到自然结束，而界面上已经没人在看这次委派了。
      await state.subagents.abortAll(context);
      await state.lane.abort(context);
      return;
    }

    /** 中止单个子代理（界面上那一行 / ④ 卡上的「中止」） */
    case "subagentAbort": {
      if (!state) throw new Error("会话尚未初始化");
      await state.subagents.abort(command.id, context);
      return;
    }

    /**
     * 按需拉一个子代理的完整流（视图只带有界尾部）。
     *
     * 注册表里有就用它（运行中 / 刚跑完）；没有（worker 重启过，注册表是空的）
     * 就按 lane 名从会话里复活一份快照——内核会恢复全部已配置的 lane，所以条目还在。
     * 都没有（名字根本不存在）时回空数组：界面按「没有内容」呈现，不走错误通道。
     */
    case "subagentTranscript": {
      if (!state) throw new Error("会话尚未初始化");
      const snapshot =
        state.subagents.snapshotOf(command.id) ??
        (await state.subagents.reviveSnapshot(command.id, context));
      const { messages, toolResults } =
        snapshot === undefined
          ? { messages: [], toolResults: [] }
          : projectTranscript(snapshot.transcript, toolDurations);
      send({ type: "subagentTranscript", id: command.id, messages, toolResults });
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
      pushView();
      return;
    }

    case "setThinkingLevel": {
      if (!state) throw new Error("会话尚未初始化");
      await state.lane.setThinkingLevel(command.level, context);
      state.meta.thinkingLevel = command.level;
      pushView();
      return;
    }

    case "compact": {
      if (!state) throw new Error("会话尚未初始化");
      // 内核压缩的失败有**两条**路径，缺一不可查：
      // ① accept 阶段被拒 → Result.err（NothingToCompact / LaneBusy / Closed）；
      // ② 运行后失败 → Result.ok 但 record.status 为 aborted / failed（摘要请求失败走这里，
      //    恰是最常见的失败：密钥 / 网络 / 模型错误都发生在这一次真实模型请求上）。
      const result = await state.lane.compact(undefined, context);
      if (!result.ok) {
        send({ type: "error", message: describeCompactError(result.error), fatal: false });
        return;
      }
      if (result.value.compaction.status !== "completed") {
        send({ type: "error", message: describeCompactOutcome(result.value.compaction), fatal: false });
        return;
      }
      // 压缩重写了 transcript，增量事件不足以重建，必须重新取快照
      state.snapshot = await state.resnapshot();
      pushView();
      send({ type: "notice", message: compactDoneMessage(state.snapshot) });
      // 压缩是会话记忆的数据丢失时刻（摘要保 prose 不保事实）：
      // 提醒助手把本轮值得留的事实沉淀进记忆文件。一次性提醒，随下一次请求注入；
      // 已在队列就不重复推——连续压缩多次而中间没运行时，提醒只会有一条。
      const reminder = compactMemoryReminder(state.meta.cwd);
      if (!pendingEphemeralNotices.includes(reminder)) pendingEphemeralNotices.push(reminder);
      return;
    }

    case "memoryTidy": {
      if (!state) throw new Error("会话尚未初始化");
      // 主 lane 忙时拒绝：整理要重写记忆文件，而运行中的任务也可能正在沉淀记忆
      // （压缩后的沉淀提醒就是这个流程）——两条 lane 并发写同一个文件是竞态。
      // 渲染层有同款守卫（运行中不给发），这里兜直接调 IPC 的路径。
      if (state.snapshot.operation !== null || state.snapshot.queues.length > 0) {
        send({
          type: "error",
          message:
            "当前会话有进行中的任务，无法整理记忆：整理会重写记忆文件，可能与任务同时改它。请等任务结束。",
          fatal: false,
        });
        return;
      }
      // 独立子 lane 跑整理：不占主对话、**上下文占用不计入**（费用照常计入——
      // 见 lib/telemetry.ts 的两个口径）、
      // 审批闸门照常生效（写记忆文件仍要走审批——安全设计，见 docs/SECURITY.md）。
      // activeTools 按 lane 持久化，仅在确有差异时写（与 thinkingLevel 的等值短路同一理由）。
      const tidy = await state.harness.lane(TIDY_LANE, context);
      const wanted = [...TIDY_TOOLS];
      const current = await tidy.getActiveTools(context);
      if (current.join("\u0000") !== wanted.join("\u0000")) {
        await tidy.setActiveTools(wanted, context);
      }
      const result = await tidy.prompt(memoryTidyTask(), undefined, context);
      // 与 compact 同款的两条失败路径都要查（见 case "compact" 的注释），
      // 否则用户敲了 /memory-tidy 只见「没反应」。
      if (!result.ok) {
        send({ type: "error", message: describeTidyError(result.error), fatal: false });
        return;
      }
      if (result.value.status === "suspended") {
        // 内核把 run 挂起（deferred）时它在后台继续：如实说，并把结果出口也搬过去——
        // 「完成（或失败）后再报一声」是本分支的承诺，必须由 settleSuspendedTidy 兑现。
        send({ type: "notice", message: "记忆整理转入后台执行，完成（或失败）后会再报一声。" });
        settleSuspendedTidy(tidy, result.value.operationId);
        return;
      }
      await settleTidyRun(state, result.value);
      return;
    }

    // 技能的四条命令（显式调用 / 查现状 / 重新扫描 / 禁用启用）都落在 lib/skills-command.ts。
    // 合成一个出口：它们共用同一份「会话未就绪怎么办」的判断，判定全在那里，这里只管发。
    case "skill":
    case "skillsStatus":
    case "skillsRescan":
    case "skillsSetDisabled": {
      const result = await dispatchSkills(command, state, context);
      if (result.kind === "delivered") pushView();
      else send(result.message);
      return;
    }

    case "branches": {
      if (!state) throw new Error("会话尚未初始化");
      send({ type: "branches", nodes: await projectBranches(state) });
      return;
    }

    case "navigate": {
      if (!state) throw new Error("会话尚未初始化");
      // 纵深防御：分支树里已经排除了子 lane 的条目（`projectBranches`），但**能拒绝就要拒绝**——
      // 「树里看不到、却能导航过去」的幽灵节点会把主对话的历史指针挪到子代理的链上，
      // 而界面上没有任何东西能解释这次跳转。判据与分支树排除**共用同一个集合**。
      if ((await foreignLaneEntryIds(state)).has(command.targetId)) {
        send({
          type: "error",
          message: "这个节点属于子代理（或记忆整理）的运行记录，不属于主对话，不能切过去。",
          fatal: false,
        });
        return;
      }
      // summarize: false —— 直接跳转，不花额外 token 生成分支摘要
      await state.lane.navigateTree(command.targetId, { summarize: false }, context);
      // 跳转换了整条分支，transcript 需要整体重建
      state.snapshot = await state.resnapshot();
      pushView();
      send({ type: "branches", nodes: await projectBranches(state) });
      return;
    }

    // 查 MCP 现状 / 热重载配置（设置页可见性）。两件事都落在 lib/mcp-reload.ts
    case "mcpStatus":
    case "mcpReload": {
      const servers = await handleMcpCommand(command.type, state, context);
      send({ type: "mcpStatus", servers });
      return;
    }

    case "dispose": {
      if (state) {
        state.unsubscribe();
        // 子代理的 watch 也要退订：否则事件会继续往已作废的快照上写，白烧 CPU
        state.subagents.dispose();
        await state.mcp.close().catch(() => undefined);
        await state.harness.close(context).catch(() => undefined);
        await state.repo.close(context).catch(() => undefined);
        state = undefined;
      }
      // 作废所有待决宿主调用，否则工具会一直挂到超时
      hostBridge.dispose();
      // 提问同理：还挂着的话，工具要收到「已取消」才能收尾，不能干等到超时
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
