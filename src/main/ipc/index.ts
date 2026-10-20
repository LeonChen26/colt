// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * IPC 路由：所有渲染进程调用的落点
 */
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import type { IpcChannel, IpcInvokeMap, SessionInfo, WikiGenerateEvent } from "@shared/protocol";
import type { McpServerView } from "@shared/worker-protocol";
import { loadMcpConfig, mcpUserHome, targetOf, transportOf, userMcpConfigPath } from "@shared/mcp-config";
import {
  catalogPresetFor,
  findPreset,
  MCP_CATALOG,
  type McpPresetState,
} from "@shared/mcp-catalog";
import { createSpawnRunner, parseVersion, probeCodewiki } from "../mcp/probe";
import {
  installPreset,
  presetRuntimeDir,
  runtimeExists,
  uninstallPreset,
  venvBinary,
  venvPython,
} from "../mcp/install";
import { readUserConfig } from "../mcp/user-config";
import type { ThinkingLevel } from "@shared/thinking-level";
import { resolveSessionModel } from "@shared/model-ref";
import { isSkillFilePath } from "@shared/skill-path";
import { runEnvCheck } from "../env-check";
import { NOT_A_REPO_STATUS, readCommittedFiles, readGitStatus } from "../git";
import { defaultScratchBase, scratchRootPath, taskBaseRoot, taskSessionRoot } from "../lib/scratch-dir";
import { applyFirstRunChoice, inspectUserData } from "../first-run";
import type { FirstRunReport } from "@shared/protocol";
import {
  createSession,
  deleteProject,
  deleteSession,
  ensureTaskProject,
  getFileBaseline,
  getProject,
  getSession,
  listProjectChanges,
  listProjects,
  listSessionEvents,
  listSessionToolCalls,
  listSessionUsage,
  listSessions,
  setSessionModel,
  setSessionThinkingLevel,
  setSessionStatus,
  upsertProject,
} from "../db/repo";
import { sessionManager } from "../session-manager";
import { dropSessionPin, listPinnedSessions, setSessionPinned } from "../session-pins";
import { readToolImage, removeToolOutput } from "../tool-output";
import {
  getAnalyzeCommandAllowlist,
  setAnalyzeCommandAllowlist,
} from "../approval/config";
import { getDiagnoseEnabled, setDiagnoseEnabled } from "../diagnose-config";
import { getComputerEnabled, setComputerEnabled } from "../computer-config";
import { getCompactionConfig, setCompactionConfig } from "../compaction-config";
import { isDefaultCompactionConfig } from "@shared/compaction-config";
import { hostBridge } from "../host";
import { readFileWithin } from "../file-read";
import { listDirWithin } from "../file-list";
import { readWikiPage, readWikiStatus } from "../wiki/read";
import {
  cancelWikiGeneration,
  formatWikiProbeFailure,
  readWikiGeneration,
  startWikiGeneration,
} from "../wiki/runner";
import { computeNetChange } from "../net-change";
import { closeDatabase, openDatabase } from "../db";
import { closeMemoryDatabase, openMemoryDatabase } from "../db/memory-index";
import { deleteSecret, hasSecret, setSecret } from "../secrets";
import {
  BUILTIN_DEEPSEEK,
  getProvider,
  listProviders,
  removeProvider,
  saveProvider,
} from "../providers";
import { testProvider } from "../provider-test";

/** app.whenReady 阶段采集的首启报告，供渲染层首屏查询（需早于 openDatabase） */
let firstRunReport: FirstRunReport | null = null;

/** 主进程启动时写入首启报告 */
export function setFirstRunReport(report: FirstRunReport): void {
  firstRunReport = report;
}

type Handler<C extends IpcChannel> = (
  request: IpcInvokeMap[C]["request"],
) => Promise<IpcInvokeMap[C]["response"]> | IpcInvokeMap[C]["response"];

/**
 * 解析会话的项目根目录（worker 的 cwd、审批系统登记的项目根）。
 * 只由主进程从库反查（sessionId → project → rootPath），**绝不接受渲染层传入**——
 * 渲染层会渲染 agent 生成的 Markdown，是不可信来源；这个根同时决定审批边界
 * （「项目内 = moderate、项目外 = 高危」），若由渲染层指定，注入内容就能把高危写
 * 操作降级成 moderate（与 file.read 同一套信任假设，见 F1 修复）。
 */
function resolveSessionRoot(sessionId: string): string {
  const session = getSession(sessionId);
  if (session === undefined) throw new Error("会话不存在");
  const project = getProject(session.projectId);
  if (project === undefined) throw new Error("项目不存在");
  // 会话有自己的目录（任务会话，落库时算好存下的时间子目录）就优先用它；
  // null（普通空间会话、旧行）回落到项目根——两者都出自主进程，信任假设不变。
  return session.cwd ?? project.rootPath;
}

/**
 * `resolveSessionRoot` 的**草稿感知**版本，仅供不需要「会话已落库」这一前提的只读查询使用
 * （当前是 `git.status` 的会话头 chip）。
 *
 * 区别只在「还没落库的草稿」这一种情形：会话要等首条消息才落库，而渲染层在草稿态也显示
 * 会话头，所以那时查库必然落空。草稿的 `projectId` 在主进程的 `drafts` 里，据此取项目根
 * ——**与渲染层对草稿显示的 cwd 是同一个值**（`activeSession.cwd ?? project.rootPath`）。
 *
 * 都没命中（会话被删 / id 伪造）→ 返回 `null`，由调用方给出「不是仓库」。**不要**回落成
 * 空串再喂给 `readGitStatus`：`resolve("")` 是**主进程自己的 cwd**，开发态下会向上找到
 * 本仓的 `.git`，于是显示一个与用户会话毫不相干的分支。
 *
 * ⚠️ 判据是「会话**是否真的不存在**」，**不是**「`resolveSessionRoot` 有没有抛」。
 * 用 try/catch 兜住一切的话，数据库没初始化、库文件损坏这类**真故障**也会被当成
 * 「这个会话不是仓库」静静咽掉——那正是本仓最忌的「用一个看起来正常的答案盖住错误」。
 *
 * ⚠️ 不要拿它当审批 / 文件访问的根：那里的语义是「必须有这个会话」，缺了要**报错**而不是
 * 悄悄给一个兜底路径（这就是它不去改 `resolveSessionRoot` 本身的原因）。
 */
function resolveSessionRootOrDraft(sessionId: string): string | null {
  // 已落库：走与其它通道完全同一条路（项目缺失时它会自己抛，不在这里替它兜）
  if (getSession(sessionId) !== undefined) return resolveSessionRoot(sessionId);
  const draft = drafts.get(sessionId);
  return draft === undefined ? null : (getProject(draft.projectId)?.rootPath ?? null);
}

/**
 * 没有活 worker 时的退路：只把配置文件里的**声明**列出来（status 一律 `idle`）。
 *
 * 配置由主进程按 projectId 反查 rootPath 读取，**不经渲染层**——「读哪个项目」若由
 * 渲染层指定，就等于让它决定我们读谁的文件（与 `resolveSessionRoot` 同一套信任假设）。
 * 项目不存在时回空：设置页按「没配」呈现，不是错误。
 *
 * `diagnostics` 一并带出（**不是丢掉**）：`loadMcpConfig` 把「不是合法 JSON / 某个
 * server 声明不合法」都收在这里，而这类毛病在 `servers` 里**没有对应条目**（坏声明不
 * 会变成一台 server）。早先只返回 `servers`，于是语法错的 `mcp.json` 在设置页上被渲染成
 * 「本项目未声明 MCP server」——把「你写错了」说成了「你没配」，恰好是反的。
 */
async function declaredMcpServers(
  projectId: string,
): Promise<{ servers: McpServerView[]; diagnostics: string[] }> {
  const project = getProject(projectId);
  if (project === undefined) return { servers: [], diagnostics: [] };
  const { servers, diagnostics, scopes } = await loadMcpConfig(project.rootPath, mcpUserHome());
  return {
    servers: Object.entries(servers).map(([name, config]) => ({
      name,
      transport: transportOf(config) ?? "stdio",
      target: targetOf(config),
      status: "idle" as const,
      tools: [],
      // 来源与「是不是我们装的」都能在这里说清：这是原始声明，别处（worker）拿不到
      scope: scopes[name],
      origin: catalogPresetFor(name, config) === undefined ? "config" : "catalog",
    })),
    diagnostics,
  };
}

/**
 * 把声明里的**来源**信息合进 worker 报的运行态。
 *
 * 运行态只讲「连上了什么、有哪些工具」，它不知道这条声明是从哪个文件来的——合并读取
 * 之后就分不清了。设置页要显示「项目级 · 覆盖了用户级」和「内置目录」两个标签，
 * 所以按名字把声明侧的元数据补回来。worker 报了配置里没有的 server（理论上不该有）
 * 就不补，宁可少一个标签，也不猜。
 */
function withOrigins(
  live: McpServerView[],
  declared: McpServerView[],
): McpServerView[] {
  const meta = new Map(declared.map((item) => [item.name, item]));
  return live.map((server) => {
    const from = meta.get(server.name);
    return from === undefined ? server : { ...server, scope: from.scope, origin: from.origin };
  });
}

/**
 * 解析会话应使用的 provider/model（带失效回退）并启动（或复用）worker。
 * session.open 与 session.prompt 的自动重连共用，保证两处模型选择一致。
 * 模型选择规则收敛在 shared/model-ref，渲染层用同一函数判断「能否自动打开」。
 * 工作目录由 resolveSessionRoot 反查，调用方不传。
 */
async function openSessionWorker(input: {
  sessionId: string;
  model?: string;
}): Promise<void> {
  const providers = listProviders();
  const { providerId, modelId } = resolveSessionModel(
    input.model ?? getSession(input.sessionId)?.modelRef,
    providers,
  );
  const provider = providers.find((item) => item.id === providerId) ?? BUILTIN_DEEPSEEK;

  await sessionManager.ensureWorker({
    sessionId: input.sessionId,
    cwd: resolveSessionRoot(input.sessionId),
    model: modelId,
    provider,
  });
}

/**
 * 删除会话的持久化历史（durable 的 SQLite 单文件库）。
 * 只删库行会让 `durable-<id>.db` 永久留在 sessions 目录里
 * （删掉会话后它再也没有入口，成了不可见的磁盘泄漏）。
 */
function removeSessionHistory(sessionId: string): void {
  const root = join(app.getPath("userData"), "sessions");
  for (const suffix of [".db", ".db-wal", ".db-shm"]) {
    try {
      rmSync(join(root, `durable-${sessionId}${suffix}`), { force: true });
    } catch {
      // 删不掉不阻断删除流程（下一轮启动时它也只是个无主文件）
    }
  }
}

/** 以类型安全的方式注册单个通道 */
function handle<C extends IpcChannel>(channel: C, handler: Handler<C>): void {
  ipcMain.handle(channel, async (_event, request) => handler(request));
}

/**
 * 需要知道「谁在调用」的通道。
 * 原生对话框必须挂在**发起窗口**上：不挂就会变成无父窗口的自由对话框，
 * 模态关系与关掉后的焦点归还都无从谈起（见 dialog.confirm 的用途）。
 */
function handleWithSender<C extends IpcChannel>(
  channel: C,
  handler: (
    sender: Electron.WebContents,
    request: IpcInvokeMap[C]["request"],
  ) => Promise<IpcInvokeMap[C]["response"]> | IpcInvokeMap[C]["response"],
): void {
  ipcMain.handle(channel, async (event, request) => handler(event.sender, request));
}

/** 会话的历史目录（真实 JSONL 由内核在其中按「转义后的 cwd + kernelId」生成） */
function jsonlPathFor(projectId: string): string {
  return join(app.getPath("userData"), "sessions", projectId);
}

/**
 * 草稿会话：`session.create` 只分配 id 并登记在这里，**不写 sessions 表**。
 *
 * 首次发消息（见 materializeDraft）时才落库——在那之前不 fork worker、不建 JSONL。
 * 否则「点了新建就退出」会在侧栏留下一条 message_count=0、点开还没反应的会话，
 * 而用户从没往里发过一个字。
 *
 * 只存在于内存：重启即消失，这正是「还没用过的会话」应有的语义。
 * 此外渲染层「还没用就离开」时会走 `session.discardDraft` 主动丢掉（见该 handler）。
 */
const drafts = new Map<
  string,
  { projectId: string; modelRef: string | null; thinkingLevel: ThinkingLevel | null }
>();

/**
 * 把草稿落库；不是草稿则什么都不做。落库后立刻从草稿表移除，避免二次落库。
 *
 * 任务会话在此刻**建自己的工作目录**（`<任务基目录>/<时间戳>`，见 `taskSessionRoot`）：
 * 先 mkdir 再落库——目录必须先存在，worker 一启动 cwd 就指着它。普通空间会话 cwd 为
 * null（跟随项目根）。目录在落库时刻算而不是建草稿时刻：草稿可能被丢掉，为一条没发过
 * 消息的草稿建目录，`~/.colt/tasks` 下会攒出一堆空壳。
 */
function materializeDraft(sessionId: string): void {
  const draft = drafts.get(sessionId);
  if (!draft) return;
  drafts.delete(sessionId);
  let cwd: string | null = null;
  if (getProject(draft.projectId)?.kind === "task") {
    cwd = taskSessionRoot(
      taskBaseRoot(app.getPath("home"), process.env.COLT_WORKSPACE_ROOT),
      new Date(),
    );
    mkdirSync(cwd, { recursive: true });
  }
  createSession(draft.projectId, jsonlPathFor(draft.projectId), sessionId, cwd);
  // 落库前在草稿上选过的模型要跟着走：不然用户「先选模型再发消息」的那一步会被丢掉
  if (draft.modelRef) setSessionModel(sessionId, draft.modelRef);
  if (draft.thinkingLevel) setSessionThinkingLevel(sessionId, draft.thinkingLevel);
}

/**
 * 对**已归档**的会话做任何「会让它跑起来」的动作前，先把它取消归档。
 *
 * 归档的语义是「从常规列表隐藏」，而运行中的会话**绝不能**带着「已归档」身份在后台跑——
 * 那正是一条看不见的运行中会话（归档子区默认还是收起的）。渲染层发现它跑起来时也会
 * 取消归档（见 `App.tsx`），这里在**数据层**兜一道底：即便渲染层没来得及同步，
 * 库里也已经是 `active`，下次读列表自然对得上。非归档会话是空操作。
 */
function reviveIfArchived(sessionId: string): void {
  if (getSession(sessionId)?.status === "archived") setSessionStatus(sessionId, "active");
}

/** CodeWiki 在目录里的 id（运行时目录、安装态都按它索引） */
const CODEWIKI_PRESET_ID = "codewiki";

/**
 * 生成任务要用的 CodeWiki 入口，以及「缺什么」。
 *
 * 只把 `python` / `git` / `codewiki` 当门禁：`mcp` 是 `codewiki mcp`（server）的要求，
 * `node` 是装期依赖（PythonMonkey 安装时调 npm），生成时都用不上。把它们也当门禁，
 * 会让一个**能生成**的环境显示成「缺件」——那是反话（`docs/ERRORS.md`）。
 */
async function resolveWikiCommand(): Promise<{ command: string } | { error: string }> {
  const runtimeDir = presetRuntimeDir(app.getPath("userData"), CODEWIKI_PRESET_ID);
  const hasRuntime = await runtimeExists(runtimeDir);
  const probe = await probeCodewiki(
    undefined,
    // 有自有运行时就**只**问它：PATH 上那个全局 Python 没装 codewiki 很正常，
    // 拿它判「装好了没」会让正在用的运行时显示成缺件（与 mcp.catalog 同一条理由）。
    hasRuntime ? { command: venvPython(runtimeDir), args: [] } : undefined,
  );
  const required = new Set(["python", "git", "codewiki"]);
  const blocking = probe.items.filter((item) => required.has(item.id) && !item.ok);
  if (blocking.length === 0) {
    return { command: hasRuntime ? venvBinary(runtimeDir, CODEWIKI_PRESET_ID) : "codewiki" };
  }
  // 手工安装可能把 console script 放在别的解释器下（pipx 等），此时「当前 Python 能否
  // import」会误判。直接问一次 CLI：能报出钉住的 2.0.0 就照常可用。
  if (!hasRuntime && blocking.every((item) => item.id === "codewiki")) {
    const result = await createSpawnRunner()(CODEWIKI_PRESET_ID, ["--version"]);
    const parsed = parseVersion(`${result.stdout}\n${result.stderr}`);
    if (result.ok && parsed !== null && parsed[0] === 2 && parsed[1] === 0 && parsed[2] === 0) {
      return { command: CODEWIKI_PRESET_ID };
    }
  }
  return { error: formatWikiProbeFailure(blocking) };
}

/** 生成进度统一广播给所有窗口；渲染层按 `sessionId` 过滤 */
function broadcastWikiGenerate(event: WikiGenerateEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send("wiki.generateState", event);
  }
}

export function registerIpcHandlers(): void {
  handle("env.check", () => runEnvCheck());

  // 首启报告在 app.whenReady 时就已采集（需早于 openDatabase）
  handle("firstRun.check", () => firstRunReport ?? inspectUserData(app.getPath("userData")));

  /**
   * 处理用户对历史数据的选择。
   * fresh 需要先关闭数据库连接再删文件，删完重新建库；import 直接沿用现有库。
   */
  handle("firstRun.resolve", (request) => {
    const userDataPath = app.getPath("userData");
    // import：直接沿用现有库，无需动连接
    if (request.choice !== "fresh") return applyFirstRunChoice(userDataPath, request.choice);

    // 先关连接再删文件，否则 Windows 下文件被占用删不掉
    closeDatabase();
    closeMemoryDatabase();
    try {
      return applyFirstRunChoice(userDataPath, request.choice);
    } finally {
      // 无论清空是否成功，都必须把库恢复到可用状态：清空半途失败时，
      // 「沿用（可能已不完整的）旧数据」也远好过「整场会话没有库」——后者会让此后
      // 每个依赖库的 IPC 都持续报「数据库尚未初始化」。
      // 此处若再失败也不掩盖上面真正的失败原因，getDatabase 会在下次访问时自愈重试。
      try {
        openDatabase(userDataPath);
        openMemoryDatabase(userDataPath);
      } catch (error) {
        console.error("[firstRun] 清空后重建数据库失败，将在下次访问时重试", error);
      }
    }
  });

  /**
   * 原生确认框。
   *
   * 存在的唯一理由：渲染层的 `window.confirm` 是 **JS 对话框**，被关掉之后 Chromium
   * 不让页面继续拿焦点——用户点输入框不出光标、敲不进字，必须让窗口失焦再回来才恢复。
   * 换成主进程的 `dialog.showMessageBox` 后，渲染层全程不被阻塞，焦点也不被 JS 对话框
   * 机制染指；返回前再显式把焦点还给发起窗口，收尾不留悬念。
   *
   * `noLink`：Windows 默认会把按钮渲染成「命令链接」大块样式，对这种二选一是纯噪音。
   * 破坏性动作用 `defaultId = cancelId = 1`：回车/ESC 都落到「取消」，不该靠一次回车把数据删掉。
   */
  handleWithSender("dialog.confirm", async (sender, request) => {
    const owner = BrowserWindow.fromWebContents(sender);
    const options: Electron.MessageBoxOptions = {
      type: "warning",
      noLink: true,
      buttons: [request.confirmLabel ?? "确定", "取消"],
      defaultId: 1,
      cancelId: 1,
      title: "Colt",
      message: request.message,
      detail: request.detail,
    };
    const { response } = owner
      ? await dialog.showMessageBox(owner, options)
      : await dialog.showMessageBox(options);
    if (owner && !owner.isDestroyed()) {
      owner.focus();
      owner.webContents.focus();
    }
    return { confirmed: response === 0 };
  });

  handle("project.pick", async () => {
    const result = await dialog.showOpenDialog({
      title: "选择项目目录",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return upsertProject(result.filePaths[0]!);
  });

  handle("project.list", () => listProjects());

  /**
   * 新建工作目录：在 `~/.colt/<年月日-时分秒>/workspace` 造一个目录并登记为项目。
   *
   * 落在**家目录**下（而不是应用数据目录）：它是用户的**工作产物**存放地，必须能被找到；
   * `.colt` 沿用仓库既有的用户级命名空间（用户级记忆 `~/.colt/memory.md` 就在那儿，
   * 见 worker/lib/memory.ts），家目录里只开这一个口子。
   * 时间戳到**秒**：两次不同时刻的意图必须拿到两个不同目录（只到分钟时，一分钟内点两次会
   * 落到**同一个**已经装了东西的目录）。同一**秒**内重复调用才落到同一路径，
   * `upsertProject` 按 root_key 去重——那几乎只是双击，不该攒目录、攒项目行。
   * `COLT_WORKSPACE_ROOT` 指到别处时直接用它本身（见 `scratchRootPath`）：冒烟靠它把产物
   * 钉在 `out/` 下，免得每跑一次就往真实家目录写东西（AGENTS.md §五⑩）。
   */
  handle("project.createScratch", () => {
    const root = scratchRootPath(
      defaultScratchBase(app.getPath("home")),
      new Date(),
      process.env.COLT_WORKSPACE_ROOT,
    );
    mkdirSync(root, { recursive: true });
    return upsertProject(root);
  });

  /**
   * 取（必要时创建）任务工作区：不指定空间（目录）新建的会话全归到它名下（「任务」栏）。
   *
   * 与 createScratch 的分工：那边是「就给我一块干净地方」，一次一个时间戳目录；
   * 这边是任务栏的**固定**落点（`~/.colt/tasks/workspace`，冒烟下为
   * `<COLT_WORKSPACE_ROOT>/tasks`），幂等——已登记就直接返回，目录缺失才创建。
   * 渲染层在启动时调一次，之后「新建会话」就按它的 id 建任务会话。
   */
  handle("project.ensureTask", () => {
    const root = taskBaseRoot(app.getPath("home"), process.env.COLT_WORKSPACE_ROOT);
    mkdirSync(root, { recursive: true });
    return ensureTaskProject(root);
  });

  /**
   * 注销工作区：断开登记并清掉它名下的**全部会话**（记录 + 派生数据 + JSONL 历史）。
   *
   * **不碰磁盘上的项目目录**——那是用户的源码；注销登记 ≠ 删代码，目录还在的话之后
   * 重新「打开」就回到原样（会话记录不可恢复）。
   *
   * 运行中（含正等人授权 / 作答）的会话让整次移除被拒绝：与 `session.delete` 同一条
   * 纪律，半途删掉正在写 JSONL 的会话只会让进程与历史错配。检查放在**任何删除之前**，
   * 这样拒绝时库与磁盘都还没动过。
   */
  handle("project.delete", (request) => {
    if (!getProject(request.projectId)) throw new Error("项目不存在或已被移除");
    const sessions = listSessions(request.projectId);
    const busy = sessions.find((session) => sessionManager.isRunning(session.id));
    if (busy) throw new Error(`会话「${busy.title}」正在运行，请先中止后再移除项目`);

    // 先关 worker（若已加载）释放文件句柄，再删库与文件——与 session.delete 同一顺序
    for (const session of sessions) sessionManager.close(session.id);
    const removed = deleteProject(request.projectId) ?? [];
    for (const session of removed) {
      // 会话已永久删除：审批状态、图钉、工具图片都随它一起收干净
      sessionManager.approvals.unregister(session.id);
      dropSessionPin(session.id);
      removeToolOutput(session.id);
      removeSessionHistory(session.id);
    }
    // 本项目的草稿：没落库也没有文件，丢掉内存记录即可（否则它一直挂在一张不存在的项目下）
    const staleDrafts = [...drafts].filter(([, draft]) => draft.projectId === request.projectId);
    for (const [id] of staleDrafts) drafts.delete(id);
    return { ok: true } as const;
  });

  handle("session.create", (request) => {
    const now = Date.now();
    const id = randomUUID();
    drafts.set(id, {
      projectId: request.projectId,
      modelRef: null,
      thinkingLevel: null,
    });
    // 与真实会话同形，界面无需特殊分支；jsonlPath 为空串——文件要等首次发消息才存在；
    // cwd 为 null——任务会话自己的目录要等落库时刻才建（见 materializeDraft）
    const draft: SessionInfo = {
      id,
      projectId: request.projectId,
      title: "新会话",
      jsonlPath: "",
      kernelSessionId: null,
      modelRef: null,
      thinkingLevel: null,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      status: "active",
      cwd: null,
    };
    return draft;
  });

  handle("session.list", (request) => listSessions(request?.projectId));

  handle("session.open", async (request) => {
    // 草稿没有历史可载入，也不该为一个「还没发过消息」的会话 fork worker / 建 JSONL。
    // 首次发消息时由 session.prompt 落库并打开（见 materializeDraft）。
    if (drafts.has(request.sessionId)) return { ok: true } as const;
    await openSessionWorker({
      sessionId: request.sessionId,
      model: request.model,
    });
    return { ok: true } as const;
  });

  handle("session.prompt", async (request) => {
    // 首次发消息：草稿在此刻落库（此后才是「真实会话」，会出现在 session.list 里）
    materializeDraft(request.sessionId);
    // 给已归档会话发消息 = 用户要继续用它：先取消归档，别让它带隐藏身份跑起来
    reviveIfArchived(request.sessionId);
    // 会话可能已被空闲回收（长时间不用）：由主进程按 sessionId → 项目反查 rootPath
    // 自动重建后再投递，避免旧行为下直接抛「会话未运行」导致界面静默无响应。
    await sessionManager.promptOrReconnect(request.sessionId, request.text, request.images, () =>
      openSessionWorker({ sessionId: request.sessionId }),
    );
    return { ok: true } as const;
  });

  handle("session.abort", (request) => {
    sessionManager.abort(request.sessionId);
    return { ok: true } as const;
  });

  handle("session.close", (request) => ({
    ok: true,
    closed: sessionManager.close(request.sessionId),
  }));

  handle("session.delete", (request) => {
    // 草稿：既没有落库数据也没有文件，丢掉内存记录即可
    if (drafts.delete(request.sessionId)) return { ok: true } as const;
    const session = getSession(request.sessionId);
    if (!session) throw new Error("会话不存在或已被删除");
    // 运行中的会话拒绝删除：避免删除正在写入的 SQLite 库与后台进程错配
    if (sessionManager.isRunning(request.sessionId)) {
      throw new Error("会话正在运行，请先中止后再删除");
    }
    // 先关 worker（若已加载），释放文件句柄，再删数据与文件
    sessionManager.close(request.sessionId);
    deleteSession(request.sessionId);
    removeSessionHistory(session.id);
    // 会话已永久删除：清掉审批状态，否则会话级模式/记忆规则会滞留在内存
    sessionManager.approvals.unregister(request.sessionId);
    dropSessionPin(request.sessionId);
    // 工具图片与历史同寿命：会话删了，落盘的截图也一并清掉
    removeToolOutput(request.sessionId);
    return { ok: true } as const;
  });

  /**
   * 丢弃草稿会话：**只有它仍是草稿时**才生效。
   *
   * 渲染层不能改用 `session.delete`：那个会真的删库，而它判断「这条有没有用起来」有一瞬间
   * 的不确定（首次发消息落库、与进程状态推送之间）——错判一次就是删掉用户刚发出去的会话。
   * 这里只碰 `drafts` 表，落过库的会话一律不动，判断权归**主进程**，不存在错判窗口。
   *
   * 返回值如实回答「丢没丢掉」，不静默成功：渲染层若发现它已经转正，就知道该去刷新列表了。
   */
  handle("session.discardDraft", (request) => ({
    ok: true as const,
    discarded: drafts.delete(request.sessionId),
  }));

  handle("session.view", (request) => sessionManager.getView(request.sessionId) ?? null);

  handle("session.setPinned", (request) => {
    setSessionPinned(request.sessionId, request.pinned);
    return { ok: true } as const;
  });

  handle("session.listPinned", () => listPinnedSessions());

  /**
   * 归档 / 取消归档：只翻 `sessions.status` 一列，会话本体（派生数据 / JSONL）一个字不动。
   *
   * 两条拒绝的理由与 `session.delete` 同源，都是「别让界面与真实状态错开」：
   * ① 草稿没有库行可改，静默成功会让界面以为归档生效了；
   * ② 运行中（含正等人回话）的会话归档后会从常规列表消失、却在后台继续跑——
   *    这正是「看不见的运行中会话」。检查放在任何写入之前，拒绝时库还没动过。
   * 归档时顺手解掉图钉：它已经藏进「已归档」里，再替它保着 worker 没有意义
   * （取消归档不会把图钉还回来——那是「本次运行有效」的标记，丢了它不损失数据）。
   */
  handle("session.setArchived", (request) => {
    if (drafts.has(request.sessionId)) throw new Error("草稿会话不能归档");
    const session = getSession(request.sessionId);
    if (!session) throw new Error("会话不存在或已被删除");
    if (request.archived && sessionManager.isRunning(request.sessionId)) {
      throw new Error("会话正在运行，请先中止后再归档");
    }
    if (request.archived) dropSessionPin(request.sessionId);
    setSessionStatus(request.sessionId, request.archived ? "archived" : "active");
    return { ok: true } as const;
  });

  // 按需读回工具图片：图片不进视图（见 @shared/tool-output），展开卡片时才来这里取
  handle("session.toolOutput", (request) =>
    readToolImage(request.sessionId, request.toolCallId),
  );

  handle("secrets.set", (request) => {
    setSecret(request.key, request.value.trim());
    return { ok: true } as const;
  });

  handle("changes.list", (request) => listProjectChanges(request.projectId));

  handle("usage.list", (request) => listSessionUsage(request.sessionId));

  // 安全事件流（技能装载告警、同名覆盖、读取失败等）：只读、按 sessionId 查
  handle("session.events.list", (request) => listSessionEvents(request.sessionId));

  handle("toolCalls.list", (request) => listSessionToolCalls(request.sessionId));

  handle("approval.list", (request) => sessionManager.approvals.listPending(request.sessionId));

  handle("approval.resolve", (request) => {
    sessionManager.resolveApproval({
      sessionId: request.sessionId,
      toolCallId: request.toolCallId,
      approved: request.approved,
      reason: request.reason,
      remember: request.remember,
      deny: request.deny,
    });
    return { ok: true } as const;
  });

  handle("userquestion.list", (request) => sessionManager.questions.list(request.sessionId));

  handle("userquestion.answer", (request) => {
    sessionManager.questions.answer(request.sessionId, request.toolCallId, request.answers);
    return { ok: true } as const;
  });

  handle("userquestion.skip", (request) => {
    sessionManager.questions.skip(request.sessionId, request.toolCallId);
    return { ok: true } as const;
  });

  handle("approval.mode.get", (request) => ({
    mode: sessionManager.approvals.getMode(request.sessionId),
  }));

  handle("approval.mode.set", (request) => {
    // 走 SessionManager 而非直接改 store：除改模式外还要自增 modeEpoch，
    // 让在飞的审批分析按新模式重新裁决
    sessionManager.setApprovalMode(request.sessionId, request.mode);
    return { mode: sessionManager.approvals.getMode(request.sessionId) };
  });

  handle("approval.rules.list", (request) =>
    sessionManager.approvals.listRules(request.sessionId),
  );

  handle("approval.rules.remove", (request) => {
    sessionManager.approvals.removeRule(request.sessionId, request.ruleId);
    return { ok: true } as const;
  });

  handle("approval.rules.clear", (request) => {
    sessionManager.approvals.clearRules(request.sessionId, request.kind);
    return { ok: true } as const;
  });

  handle("approval.analyzeConfig.get", () => ({
    commands: getAnalyzeCommandAllowlist(),
  }));

  handle("approval.analyzeConfig.set", (request) => {
    const commands = setAnalyzeCommandAllowlist(request.commands);
    // 立即生效：把新白名单推给审批中枢，无需重启
    sessionManager.reloadAnalyzeCommandAllowlist();
    return { commands };
  });

  handle("diagnose.config.get", () => ({
    enabled: getDiagnoseEnabled(),
  }));

  handle("diagnose.config.set", (request) => {
    setDiagnoseEnabled(request.enabled);
    // 立即生效：推给池中全部 worker（开关是全局的，不是会话级的）
    sessionManager.broadcastDiagnoseEnabled(request.enabled);
    return { enabled: request.enabled };
  });

  handle("computer.config.get", () => ({
    enabled: getComputerEnabled(),
  }));

  handle("computer.config.set", (request) => {
    setComputerEnabled(request.enabled);
    // 不下发：工具清单是会话创建时确定的，改开关只影响下个会话（见协议注释）
    return { enabled: request.enabled };
  });

  handle("compaction.config.get", () => {
    const config = getCompactionConfig();
    return { config, isDefault: isDefaultCompactionConfig(config) };
  });

  handle("compaction.config.set", (request) => {
    // 返回**归一化后**的配置：用户输入可能是空串 / 越界值，界面要显示真实生效值
    const config = setCompactionConfig(request.config);
    // 推给池中全部 worker（压缩策略是全局的）。worker 侧会调内核的 `setCompactionSettings`，
    // 生效时机**不是「下次压缩才读到」**（那要晚得多），而是**从下一次操作起**——
    // 内核在 accept 时把设置快照进该操作，故**正在跑的那一轮不受影响**。
    // 准确说法与证据链见 `worker/durable/entry.ts` 的 `setCompaction` 分支注释（那里核过源码）。
    sessionManager.broadcastCompactionConfig(config);
    return { config, isDefault: isDefaultCompactionConfig(config) };
  });

  handle("providers.list", () => listProviders());

  handle("providers.save", (request) => {
    saveProvider({
      id: request.id,
      name: request.name,
      baseUrl: request.baseUrl,
      models: request.models,
      requiresKey: request.requiresKey,
    });
    // 密钥单独走加密存储，不进数据库
    if (request.apiKey) setSecret(request.id, request.apiKey.trim());
    return { ok: true } as const;
  });

  handle("providers.remove", (request) => {
    removeProvider(request.id);
    deleteSecret(request.id);
    return { ok: true } as const;
  });

  handle("providers.test", (request) =>
    testProvider({ id: request.id, apiKey: request.apiKey }),
  );

  handle("mcp.status", async (request) => {
    // 配置诊断**一律由主进程自己解析**（两条路都要）：活 worker 那份运行态只讲
    // 「连上了什么」，坏声明在它手里没有对应条目，而会话开着时那些诊断只走了一条
    // notice、设置页看不见。详见 `protocol.ts` 里 `mcp.status` 的注释。
    const declared = await declaredMcpServers(request.projectId);
    const sessionId = sessionManager.workerSessionForProject(request.projectId);
    if (sessionId === undefined) {
      return { ...declared, live: false } as const;
    }
    return {
      servers: withOrigins(await sessionManager.mcpStatus(sessionId), declared.servers),
      live: true,
      diagnostics: declared.diagnostics,
    } as const;
  });

  handle("mcp.reload", async (request) => {
    const declared = await declaredMcpServers(request.projectId);
    const sessionId = sessionManager.workerSessionForProject(request.projectId);
    if (sessionId === undefined) {
      return { ...declared, live: false } as const;
    }
    return {
      servers: withOrigins(await sessionManager.mcpReload(sessionId), declared.servers),
      live: true,
      diagnostics: declared.diagnostics,
    } as const;
  });

  /**
   * 内置可选 MCP 目录：每一项现在的安装态 + 前置检查读数。
   *
   * 探测**优先对着我们自己装的运行时**（venv 里那个 Python）跑，而不是 PATH 上的：
   * 用户机器上多半还有一个全局 Python，它没装 codewiki 很正常——拿它去判「装好了没」，
   * 会让一个刚装好、正在用的运行时显示成「缺 codewiki」（说反话，`docs/ERRORS.md` 那一类）。
   * 没有运行时才回落到 PATH 探测，那是「装机前置条件够不够」的答案。
   */
  handle("mcp.catalog", async () => {
    const home = mcpUserHome();
    const configPath = userMcpConfigPath(home);
    let declared: Record<string, unknown> = {};
    let configError: string | null = null;
    try {
      declared = (await readUserConfig(home)).servers;
    } catch (error) {
      // 配置读不了不能连累整个目录：如实说「这份文件有毛病」，其余照常显示
      configError = error instanceof Error ? error.message : String(error);
    }
    const presets: McpPresetState[] = [];
    for (const preset of MCP_CATALOG) {
      const runtimeDir = presetRuntimeDir(app.getPath("userData"), preset.id);
      const hasRuntime = await runtimeExists(runtimeDir);
      const probe = await probeCodewiki(
        undefined,
        hasRuntime ? { command: venvPython(runtimeDir), args: [] } : undefined,
      );
      presets.push({
        id: preset.id,
        name: preset.name,
        tagline: preset.tagline,
        serverName: preset.serverName,
        installed: preset.serverName in declared,
        runtime: hasRuntime,
        probe: { ready: probe.ready, items: probe.items },
        configPath,
        manualCommands: preset.manualCommands,
        pins: preset.pins,
        runtimeNote: preset.runtimeNote,
      });
    }
    return { presets, configError } as const;
  });

  handleWithSender("mcp.install", async (sender, request) => {
    const preset = findPreset(request.id);
    if (preset === undefined) {
      return { ok: false, steps: [], error: `目录里没有这一项：${request.id}` } as const;
    }
    return await installPreset({
      preset,
      home: mcpUserHome(),
      runtimeDir: presetRuntimeDir(app.getPath("userData"), preset.id),
      onProgress: (step) => {
        if (!sender.isDestroyed()) {
          sender.send("mcp.installProgress", { presetId: preset.id, action: "install", step });
        }
      },
    });
  });

  handleWithSender("mcp.uninstall", async (sender, request) => {
    const preset = findPreset(request.id);
    if (preset === undefined) {
      return { ok: false, steps: [], error: `目录里没有这一项：${request.id}` } as const;
    }
    return await uninstallPreset({
      preset,
      home: mcpUserHome(),
      runtimeDir: presetRuntimeDir(app.getPath("userData"), preset.id),
      removeRuntime: request.removeRuntime === true,
      onProgress: (step) => {
        if (!sender.isDestroyed()) {
          sender.send("mcp.installProgress", { presetId: preset.id, action: "uninstall", step });
        }
      },
    });
  });

  handle("skills.status", async (request) => {
    // 技能清单是内核 loader 的产物，主进程**不自己扫盘复刻**——只把问题转给该项目的活会话。
    // 没有活会话时 `live: false` 且清单为空：那是「会话没开着」，界面据此说要先开会话，
    // 而不是渲染成「一个技能都没装」（反话，见 `protocol.ts` 里 `skills.status` 的注释）。
    const sessionId = sessionManager.workerSessionForProject(request.projectId);
    if (sessionId === undefined) {
      return { skills: [], warnings: [], live: false } as const;
    }
    return await sessionManager.skillsStatus(sessionId);
  });

  handle("skills.rescan", async (request) => {
    // 与 skills.status 同款：没有活会话就无处生效（重扫的是**运行中**那份清单，下次开会话
    // 本来就会重新装载），此时照实回 `live: false`，不假装成功。
    const sessionId = sessionManager.workerSessionForProject(request.projectId);
    if (sessionId === undefined) {
      return { skills: [], warnings: [], live: false } as const;
    }
    return await sessionManager.skillsRescan(sessionId);
  });

  handle("skills.setDisabled", async (request) => {
    // 落盘在 worker（见 `skillsSetDisabled` 命令）：它才是这份配置的读者，主进程不碰那个文件。
    // 没活会话就无处生效——照实回 `live: false`，别让开关显示一个并未发生的状态。
    const sessionId = sessionManager.workerSessionForProject(request.projectId);
    if (sessionId === undefined) {
      return { skills: [], warnings: [], live: false } as const;
    }
    return await sessionManager.skillsSetDisabled(sessionId, request.name, request.disabled);
  });

  handle("skills.reveal", async (request) => {
    // 只做一次「揭开所在目录」：不读内容、不写盘，故危害上界很小。路径来自渲染层，
    // 但仍按**形状**钉死（`.agents/skills/<名字>/SKILL.md` 上的真实文件）——最坏也只是
    // 「在文件管理器里定位到一个不存在的位置」，不会把别的什么位置掀开。
    if (!isSkillFilePath(request.filePath)) {
      return { ok: false, reason: "只支持定位 .agents/skills/<名字>/SKILL.md。" };
    }
    if (!existsSync(request.filePath)) {
      return { ok: false, reason: "文件已不在（可能被删掉或移走了）。" };
    }
    shell.showItemInFolder(request.filePath);
    return { ok: true };
  });

  handle("session.setModel", async (request) => {
    const provider = getProvider(request.providerId);
    if (!provider) throw new Error(`Provider 不存在：${request.providerId}`);
    // 草稿会话：选择只记在草稿上。它还没落库，UPDATE 会打在 0 行上（静默丢失）；
    // 也不该为一个「还没发过消息的会话」拉起 worker——那正是草稿要避免的事。
    // 记在草稿里的选择会在首次发消息落库时一并写出（见 materializeDraft）。
    const draft = drafts.get(request.sessionId);
    if (draft) {
      draft.modelRef = `${provider.id}/${request.modelId}`;
      return provider.requiresKey && !hasSecret(provider.id)
        ? ({ ok: true, needsKey: true } as const)
        : ({ ok: true } as const);
    }
    // 选中的就是没配密钥的服务（下拉里可能列出它，用户也可能是先选模型再填密钥）——
    // 这不是错误，只是还不能跑；先把选择落库，让用户回到设置页去填密钥。
    // 否则界面弹红、选项卡也不变，看上去就是「选不了模型」。
    // 只对**确实需要密钥**的服务这么办：本地 / 自建 endpoint 本来就没有密钥，
    // 按「缺密钥」处理会让它永远打不开。
    if (provider.requiresKey && !hasSecret(provider.id)) {
      setSessionModel(request.sessionId, `${provider.id}/${request.modelId}`);
      return { ok: true, needsKey: true } as const;
    }
    await sessionManager.setModelOrReconnect(
      request.sessionId,
      provider,
      request.modelId,
      // worker 被空闲回收时由主进程反查项目根重建（cwd 不再来自渲染层）
      () => openSessionWorker({ sessionId: request.sessionId }),
    );
    return { ok: true } as const;
  });

  handle("session.setThinkingLevel", (request) => {
    // 草稿会话：同 session.setModel——它还没落库，UPDATE 会打在 0 行上静默丢失；
    // 也不该为一个还没发过消息的会话拉起 worker。记在草稿里，首次发消息落库时一并写出。
    const draft = drafts.get(request.sessionId);
    if (draft) {
      draft.thinkingLevel = request.level;
      return { ok: true } as const;
    }
    // worker 不在池中时只落库（不重建）：下次打开会话会带着新等级启动
    sessionManager.setThinkingLevel(request.sessionId, request.level);
    return { ok: true } as const;
  });

  handle("session.compact", async (request) => {
    // 与 session.prompt 同理：可能把 worker 拉起来，那就必须先有会话行——
    // 否则 worker 里那个内核会话 ID 无处落库（UPDATE 打在 0 行上），下次打开会另起一份历史。
    materializeDraft(request.sessionId);
    reviveIfArchived(request.sessionId);
    // 会话可能已被空闲回收；主进程反查项目根自动重建后再投递，
    // 否则旧行为下会直接抛「会话未运行」——用户看到的只是“点了没反应”。
    await sessionManager.compactOrReconnect(request.sessionId, () =>
      openSessionWorker({ sessionId: request.sessionId }),
    );
    return { ok: true } as const;
  });

  handle("session.skill", async (request) => {
    // 与 session.compact 同理：可能把 worker 拉起来，那就必须先有会话行，
    // 否则 worker 里那个内核会话 ID 无处落库（UPDATE 打在 0 行上），下次打开会另起一份历史。
    materializeDraft(request.sessionId);
    reviveIfArchived(request.sessionId);
    await sessionManager.skillOrReconnect(
      request.sessionId,
      request.name,
      request.instructions,
      () => openSessionWorker({ sessionId: request.sessionId }),
    );
    return { ok: true } as const;
  });

  handle("session.memoryTidy", async (request) => {
    // 与 session.compact 同理：可能把 worker 拉起来，必须先有会话行，
    // 否则 worker 里那个内核会话 ID 无处落库（UPDATE 打在 0 行上）。
    materializeDraft(request.sessionId);
    reviveIfArchived(request.sessionId);
    await sessionManager.memoryTidyOrReconnect(request.sessionId, () =>
      openSessionWorker({ sessionId: request.sessionId }),
    );
    return { ok: true } as const;
  });

  handle("session.navigate", (request) => {
    sessionManager.navigate(request.sessionId, request.targetId);
    return { ok: true } as const;
  });

  handle("session.subagentAbort", (request) => {
    sessionManager.subagentAbort(request.sessionId, request.id);
    return { ok: true } as const;
  });

  handle("session.subagentTranscript", (request) =>
    sessionManager.subagentTranscript(request.sessionId, request.id),
  );

  /**
   * 会话头的 git 分支 chip。根仍然**只由主进程算**（同 `git.committed` / `file.read`）。
   *
   * ⚠️ 这里比 `resolveSessionRoot` 多认一种情形：**草稿会话**。会话要等首条消息才落库
   * （见 `materializeDraft` 的说明），而「新建后还没发消息」恰恰是最想看「我在哪个仓库」的时刻。
   * 草稿没有 session 行，但 `drafts` 里有它的 `projectId`——而渲染层显示的 cwd 对草稿也
   * 恒等于项目根（`App.tsx` 的 `activeSession.cwd ?? conversationProject.rootPath`），
   * 所以两条路算出的是**同一个值**，不存在「主进程与渲染层各说各话」。
   *
   * 两者都不是（会话被删了 / id 是伪造的）→ 返回「不是仓库」，chip 隐藏，与「读不到」同形。
   */
  handle("git.status", (request) => {
    const root = resolveSessionRootOrDraft(request.sessionId);
    return root === null ? NOT_A_REPO_STATUS : readGitStatus(root);
  });

  // 「已提交」批量判定（清单层按需调用）：根只由主进程按 sessionId → 项目推出（同 file.read）
  handle("git.committed", (request) =>
    readCommittedFiles(resolveSessionRoot(request.sessionId), request.paths),
  );

  // 内嵌浏览器：渲染层上报页面区域矩形供主进程摆放 WebContentsView（原生视图不参与 DOM 叠层）
  handle("browser.bounds", (request) => {
    hostBridge.setBrowserBounds(request.sessionId, request.rect);
    return { ok: true } as const;
  });
  handle("browser.state.get", (request) => hostBridge.browserState(request.sessionId));
  // 浏览器观测快照：与 browser_read 读同一份缓冲，只读、不触发任何动作
  handle("browser.observe", (request) => hostBridge.browserObservation(request.sessionId));
  // 用户手动导航（B1）：不走审批——发起方是用户、不是模型，没有可裁决的入参；
  // 但要把「页面已经不是你离开时那页」告知正在跑的 agent（见 sessionManager 上的说明）。
  handle("browser.navigate", (request) => {
    const { state, notice } = hostBridge.browserNavigate(request.sessionId, request.action);
    if (notice.length > 0) sessionManager.notifyBrowserNotice(request.sessionId, notice);
    return state;
  });
  // 用户接管 / 交还浏览器（两端显式）。与 browser.navigate 同一形态：发起方是用户、不走审批，
  // 但它**会改变 agent 的动作权限**（接管期间改动类动作被拒），所以必须把这件事告知
  // 正在跑的 agent——否则它只会反复撞墙，而不知道为什么。
  handle("browser.control", (request) => {
    const { state, notice } = hostBridge.browserSetControl(request.sessionId, request.byUser);
    if (notice.length > 0) sessionManager.notifyBrowserNotice(request.sessionId, notice);
    return state;
  });
  // 撤销 agent 留下的视口联调覆盖（B1 排查中发现的问题）：覆盖是持久状态，
  // 只有显式撤销才结束，用户必须有个出口，否则面板会一直按那个尺寸摆放、看着像渲染坏了。
  handle("browser.viewport.reset", (request) => hostBridge.browserResetViewport(request.sessionId));
  // 「适应宽度」：页面按固定宽度排版、停靠区又装不下时的唯一出路（缩放不动原生视图矩形，
  // 所以那条「视图 == 页面区域」的硬约束不受影响）。比例由主进程算，用户只表达意图。
  handle("browser.zoom", (request) => hostBridge.browserSetZoom(request.sessionId, request.fit));

  // 根**只由主进程推导**：渲染层给 sessionId 与相对路径，绝不给根
  handle("file.read", (request) => {
    return readFileWithin(resolveSessionRoot(request.sessionId), request.path);
  });

  /**
   * 净变化（基线 → 当前）：逐次 patch 答不了「这个文件最终被改成了什么」，这条通道答它。
   * 基线与根同样**只由主进程**取（前者来自库、后者由 sessionId → 项目推出）。
   */
  handle("file.netDiff", (request) => {
    return computeNetChange(
      resolveSessionRoot(request.sessionId),
      request.path,
      getFileBaseline(request.sessionId, request.path),
    );
  });

  /** 「文件」页签的懒加载树：列项目内某目录的一层。边界与 file.read 同一套（根只由主进程推导） */
  handle("file.list", (request) => {
    return listDirWithin(resolveSessionRoot(request.sessionId), request.path);
  });

  // ---- 「Wiki」页签：读 CodeWiki 的产物（docs/wiki），以及用户显式发起的生成/更新 ----
  //
  // 根**只由主进程推**（sessionId → 会话 / 项目），渲染层给不了目录。
  // 生成同样是「用户显式动作」（面板按钮），不做成 agent 工具：它会花模型额度并改工作区，
  // 不能变成模型一次调用就能触发的路径（见 docs/design-codewiki-integration-2026-10.md §5 D9）。

  handle("wiki.status", (request) => {
    return readWikiStatus(resolveSessionRoot(request.sessionId));
  });

  handle("wiki.page", (request) => {
    return readWikiPage(resolveSessionRoot(request.sessionId), request.path);
  });

  handle("wiki.generate.start", async (request) => {
    const root = resolveSessionRoot(request.sessionId);
    // 单飞先问一次，省掉「已经在跑还去探一遍前置条件」的几秒钟
    if (readWikiGeneration(root)?.phase === "running") {
      return { started: false, alreadyRunning: true, error: null } as const;
    }
    const target = await resolveWikiCommand();
    if ("error" in target) {
      return { started: false, alreadyRunning: false, error: target.error } as const;
    }
    try {
      const result = await startWikiGeneration({
        sessionId: request.sessionId,
        root,
        mode: request.mode,
        command: target.command,
        // 前置检查已在上面做完；runner 里留这一道是为了单测与未来的调用方
        checkReady: async () => null,
        onEvent: broadcastWikiGenerate,
      });
      return { ...result, error: null } as const;
    } catch (error) {
      return {
        started: false,
        alreadyRunning: false,
        error: error instanceof Error ? error.message : String(error),
      } as const;
    }
  });

  handle("wiki.generate.cancel", (request) => {
    return { cancelled: cancelWikiGeneration(request.sessionId) } as const;
  });

  handle("wiki.generate.status", (request) => {
    return readWikiGeneration(resolveSessionRoot(request.sessionId));
  });

  // ---- 「终端」页签：shell 跑在会话所属项目根下（同 file.read 的根推导，渲染层不能指定）----

  handle("terminal.open", (request) => {
    return hostBridge.terminalOpen(
      request.sessionId,
      resolveSessionRoot(request.sessionId),
      request.cols,
      request.rows,
    );
  });

  handle("terminal.input", (request) => {
    hostBridge.terminalInput(request.sessionId, request.data);
    return { ok: true as const };
  });

  handle("terminal.resize", (request) => {
    hostBridge.terminalResize(request.sessionId, request.cols, request.rows);
    return { ok: true as const };
  });

  handle("terminal.close", (request) => {
    hostBridge.terminalClose(request.sessionId);
    return { ok: true as const };
  });
}

/** 首启时若环境变量里有 key 且尚未配置，则自动导入一次，方便开发 */
export function importKeyFromEnvIfMissing(): void {
  if (hasSecret("deepseek")) return;
  const fromEnv = process.env.DEEPSEEK_API_KEY?.trim();
  if (fromEnv) setSecret("deepseek", fromEnv);
}
