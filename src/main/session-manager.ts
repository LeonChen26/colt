/**
 * SessionManager：每会话一个 worker 进程（utilityProcess）
 * 负责启动、路由命令、转发视图、进程池上限与回收
 */
import { app, Notification, utilityProcess, type UtilityProcess, type BrowserWindow } from "electron";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import type { ConversationView, HostResult, ViewFileChange, WorkerCommand, WorkerMessage } from "@shared/worker-protocol";
import type { ApprovalMode, ApprovalRequest, BranchNode, ProviderConfig } from "@shared/protocol";
import { resolveThinkingLevel, type ThinkingLevel } from "@shared/thinking-level";
import { getSecret } from "./secrets";
import { getSession, setKernelSessionId, setSessionModel, setSessionThinkingLevel, touchSession, recordFileChange, recordFileBaseline, getFileBaseline, setChangeNet, recordUsage, recordToolCall, listSessionFileChanges, latestContextUsed } from "./db/repo";
import { normalizeRootKey } from "./db/index";
import { indexMemorySnapshot } from "./db/memory-index";
import { computeNetChange } from "./net-change";
import { ApprovalStore, DEFAULT_TIMEOUT_MS } from "./approval/store";
import { getAnalyzeCommandAllowlist } from "./approval/config";
import { analyzeToolCall } from "./approval/analyzer";
import { createDeferred } from "./lib/deferred";
import { hostBridge } from "./host";

/** 进程池上限，超出时回收最久未活动的空闲会话 */
const MAX_WORKERS = 6;
/** 空闲超过该时长且未运行的 worker 会被回收 */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
/**
 * worker 启动上限。长历史会话重放 JSONL 可能数十秒，阀值要给够；
 * 但一旦超过就说明 worker 卡住再也发不出 ready，必须拒绝等待方，
 * 否则 session.open 永久 pending，界面停在「正在启动会话进程…」。
 */
const READY_TIMEOUT_MS = Number(process.env.COLT_READY_TIMEOUT_MS ?? 120_000);
/** 空闲回收扫描间隔 */
const IDLE_SWEEP_MS = 60 * 1000;
/**
 * 发出 dispose 后等 worker 自行退出的宽限时长，超时强杀。
 * dispose 只是一条消息，worker 正忙时可能迟迟不处理。
 */
const DISPOSE_GRACE_MS = 3 * 1000;
/**
 * 无需密钥的服务（ProviderConfig.requiresKey === false）启动 worker 时占位用的假密钥。
 * 仅仅是喂给 pi-ai 的 openai-completions 层，它无法表达「这个服务不需要鉴权」，
 * apiKey 为空会直接抛「No API key for provider」。本地服务一般不校验该请求头。
 */
const KEYLESS_PLACEHOLDER = "colt-local-no-key";

interface WorkerEntry {
  sessionId: string;
  child: UtilityProcess;
  lastActiveAt: number;
  running: boolean;
  view?: ConversationView;
  /** 当前会话的 provider 配置与模型 id，审批分析器需要据此装配模型 */
  provider: ProviderConfig;
  modelId: string;
  /**
   * 主动销毁原因（undefined 表示未主动销毁，即崩溃）。
   * exit 回调靠它三分：
   * - undefined：进程自己死了 → 发 crashed，醒目告警
   * - "idle"：空闲超时回收 / 进程池淘汰 → 发 dormant，提示「空闲休眠」
   * - "closed"：用户切走 / 启动超时 / 应用退出 → 静默（预期行为，无需提示）
   */
  disposeReason?: "idle" | "closed";
  /**
   * 就绪信号（createDeferred 的 promise）。worker 在发回 ready 之前就退出时会被
   * reject，从而掉出所有 await 它的调用方；否则 session.open 会永远 pending，
   * 界面停在「正在启动会话进程…」。
   */
  ready: Promise<void>;
  /**
   * 就绪**之前**收到的命令暂存队列。undefined 表示已就绪，命令直接下发。
   *
   * 条目在 fork 之后立刻进 `#workers`，而 worker 的 `init`（重放整份 JSONL，历史大时要好几秒）
   * 才把 `state` 建好。这期间下发任何命令，worker 的 handler 都会在 `state` 就绪前收到，
   * 从各 case 的 `if (!state)` 抛出「会话尚未初始化」——用户看到的就是「切模型报错」。
   * 之所以攒而不丢：这些命令本来就该在 init 之后生效（切模型 / 发消息 / 中断），
   * 丢掉才是更糟的行为（静默无响应）。攒着还能顺带修掉「打开会话后立刻发消息」的同类竞态。
   */
  pendingCommands?: WorkerCommand[];
  /**
   * 分支树查询的待决 promise（worker 以消息形式异步回复）。
   * 用队列而非单个回调：切会话 / 刷新按钮 / 分支导航都会触发查询，
   * 并发时单槽会让先到的请求永远拿不到结果（只能等到超时）。
   */
  pendingBranches: Array<(nodes: BranchNode[]) => void>;
  /**
   * 中断代数：每次用户中断自增。审批分析在飞行中跨越了中断时据此丢弃结果——
   * 否则会在已中断的会话上留下无法解释的幽灵待审卡片，并让 worker 悬空等待。
   */
  abortEpoch: number;
  /**
   * 审批模式代数：用户改动审批模式时自增。审批分析在飞行中跨越了模式变更时据此
   * 丢弃旧结论、按新模式重新裁决——否则切到 full-access 后仍会弹出待审卡片
   * （与「本会话内一律放行」的语义矛盾）。
   */
  modeEpoch: number;
}

export class SessionManager {
  readonly #workers = new Map<string, WorkerEntry>();
  /** 正在启动中的 worker，按 sessionId 去重并发 ensureWorker */
  readonly #pending = new Map<string, Promise<void>>();
  /** 审批状态中枢，与 worker 生命周期解耦 */
  readonly approvals = new ApprovalStore();

  /**
   * 从设置读取「分析器命令白名单」并应用到审批中枢。
   * 启动（openDatabase 之后）与设置变更时各调一次；构造期数据库尚未打开，故不能放进构造函数。
   */
  reloadAnalyzeCommandAllowlist(): void {
    this.approvals.setAnalyzeCommandAllowlist(getAnalyzeCommandAllowlist());
  }

  /**
   * 设定会话审批模式（唯一入口，IPC 与内部都走这里）。
   *
   * 除改模式外还要自增 modeEpoch：在飞的审批分析据此判定「模式变了」，
   * 改按新模式重新裁决（见 #analyzeThenReply）。仅当生效模式确有变化才自增。
   */
  setApprovalMode(sessionId: string, mode: ApprovalMode): void {
    const entry = this.#workers.get(sessionId);
    if (entry && this.approvals.getMode(sessionId) !== mode) entry.modeEpoch += 1;
    this.approvals.setMode(mode, sessionId);
  }
  /** 主进程侧的审批超时定时器，key 为 toolCallId；与 worker 的超时保持同步 */
  readonly #approvalTimers = new Map<string, NodeJS.Timeout>();
  /**
   * 会话改动列表缓存（key 为 sessionId）。
   * 投影出口每次 flush 都要这份列表，而流式期间 flush 约 50ms 一次，逐次查库
   * 会造成读放大；主进程是 file_changes 的唯一写入方，故写入点失效即安全。
   */
  readonly #fileChangesCache = new Map<string, ViewFileChange[]>();
  #window: BrowserWindow | undefined;
  #reaper?: NodeJS.Timeout;
  /**
   * 当前有待审请求的会话。
   *
   * 「等待授权」是本产品唯一**需要用户立刻拍板**的状态，而窗口常常不在前台——
   * 没有这份集合，我们既不知道「该不该喊人」，也不知道「人回来看了、该停止喊」。
   */
  readonly #pendingSessions = new Set<string>();
  /**
   * 已就「等待授权」提醒过的 toolCallId，按会话分组：同一条只提醒一次，避免反复弹通知。
   * 分组不是为了分组本身——会话待审清空时要能精确回收这一份，否则集合跟着进程无界增长。
   */
  readonly #notifiedApprovals = new Map<string, Set<string>>();
  /** 任务栏是否正在闪烁。flashFrame 表达的是一个**状态**而非开关，重复调用无意义，故自己记一份 */
  #flashing = false;

  attachWindow(window: BrowserWindow): void {
    this.#window = window;
    // 内嵌浏览器的视图状态（首次加载 / 导航 / 标题变化 / 销毁）统一走本类的推送出口。
    // onState 以最后一次注册为准，故重复 attachWindow 不会叠加监听。
    hostBridge.onBrowserState((state) => this.#emit("browser.state", state));
    // 用户回到窗口就停止闪烁；又走开且仍有待审，则继续喊。
    // 这样「闪烁」恒等于「有待审 且 人没在看」——不需要任何一方手动去清。
    window.on("focus", () => this.#setFlashing(false));
    window.on("blur", () => this.#setFlashing(this.#pendingSessions.size > 0));
  }

  #emit(channel: string, payload: unknown): void {
    if (this.#window && !this.#window.isDestroyed()) {
      this.#window.webContents.send(channel, payload);
    }
  }

  /**
   * 推送某会话的待审列表（全量，渲染层直接替换）。
   *
   * 这也是「该不该喊人」的唯一同步点：待审列表的每一次变化都必经此地
   * （入队、处置、超时、中断、崩溃清理），提醒状态在此处派生，
   * 才不会出现「界面已清空、任务栏还在闪」这类两处状态打架的情况。
   */
  #emitPending(sessionId: string): void {
    const requests = this.approvals.listPending(sessionId);
    this.#emit("approval.pending", { sessionId, requests });
    this.#syncAttention(sessionId, requests);
  }

  /**
   * 根据「有哪些会话在等授权」决定要不要请求用户注意。
   *
   * 「等待授权」是本产品唯一需要用户**立刻拍板**的状态，而窗口常常不在前台；
   * 不喊人，一条卡住的审批就只能干等到 5 分钟超时被自动拒绝，用户还以为是模型慢。
   * 但也不抢焦点——用户可能正在别处打字，抢焦点等同于打断。
   * 于是只用任务栏闪烁 + 桌面通知这两种「可以不理会」的方式请求注意。
   */
  #syncAttention(sessionId: string, requests: ApprovalRequest[]): void {
    if (requests.length > 0) {
      this.#pendingSessions.add(sessionId);
    } else {
      this.#pendingSessions.delete(sessionId);
      // 该会话已无待审：提醒记录一并回收，否则它会跟着进程一直涨
      this.#notifiedApprovals.delete(sessionId);
    }

    const window = this.#window;
    const focused = window !== undefined && !window.isDestroyed() && window.isFocused();
    // 人就在窗口前面时侧栏直接可见，闪烁与通知都属多余
    this.#setFlashing(!focused && this.#pendingSessions.size > 0);
    if (focused) return;

    const notified = this.#notifiedApprovals.get(sessionId) ?? new Set<string>();
    // 本方法随每次 flush 被高频调用，不去重就是通知轰炸
    const fresh = requests.filter((item) => !notified.has(item.toolCallId));
    if (fresh.length === 0) return;
    for (const item of fresh) notified.add(item.toolCallId);
    this.#notifiedApprovals.set(sessionId, notified);
    this.#notifyApproval(fresh);
  }

  /**
   * 桌面通知：给「窗口不在前台」的用户一个看得见的提醒。
   * 点击只把窗口叫到前台、不代用户切换会话——那要另开一条「主进程指示渲染层切会话」的通道，
   * 而侧栏此刻已经标出了是哪个会话在等授权，用户点一下即可。
   */
  #notifyApproval(requests: ApprovalRequest[]): void {
    const first = requests[0];
    if (!first || !Notification.isSupported()) return;
    const more = requests.length > 1 ? `（另有 ${requests.length - 1} 条）` : "";
    const notification = new Notification({
      title: "有操作等待你的授权",
      body: `${first.summary}${more}`,
    });
    notification.on("click", () => {
      const window = this.#window;
      if (!window || window.isDestroyed()) return;
      // 最小化时先还原：直接 focus() 只是把焦点给了任务栏上那个仍然最小化的窗口
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    });
    notification.show();
  }

  /**
   * 任务栏闪烁——请求注意但不抢焦点。
   * flashFrame 表达的是一个**状态**而非一次性开关，重复调用没有意义，故自己记一份去重。
   */
  #setFlashing(active: boolean): void {
    if (this.#flashing === active) return;
    this.#flashing = active;
    const window = this.#window;
    if (!window || window.isDestroyed()) return;
    window.flashFrame(active);
  }

  /**
   * 处置一条审批：回复 worker 并刷新待审列表。
   * worker 已不在（被回收）时仍需清理队列，否则界面会残留条目。
   */
  resolveApproval(input: {
    sessionId: string;
    toolCallId: string;
    approved: boolean;
    reason?: string;
    remember?: "signature" | "tool";
    deny?: "signature" | "tool";
  }): void {
    if (process.env.COLT_APPROVAL_DEBUG === "1") {
      console.log(`[approval] 界面处置 ${input.toolCallId} approved=${input.approved}`);
    }
    this.#clearApprovalTimer(input.toolCallId);
    const decision = this.approvals.resolve(input);
    if (decision) {
      const entry = this.#workers.get(input.sessionId);
      entry?.child.postMessage({
        type: "approvalResult",
        toolCallId: input.toolCallId,
        approved: decision.approved,
        reason: decision.reason,
      } satisfies WorkerCommand);
    }
    this.#emitPending(input.sessionId);
  }

  /**
   * 自动审批：调大模型分析后回复 worker。
   *
   * 分析失败/超时一律回退到人工确认（commitAnalyzed 传 allow=false），
   * 而不是直接放行——分析器不能成为放行的单点故障。
   */
  async #analyzeThenReply(
    entry: WorkerEntry,
    options: { sessionId: string; cwd: string },
    message: Extract<WorkerMessage, { type: "approvalRequest" }>,
    context: { invocation: { toolName: string; args: Record<string, unknown> }; projectRoot: string; reason: string },
  ): Promise<void> {
    const { toolCallId, toolName, argsJson } = message;
    const abortEpoch = entry.abortEpoch;
    const modeEpoch = entry.modeEpoch;
    const apiKey = getSecret(entry.provider.id);
    const result = await analyzeToolCall({
      toolName: context.invocation.toolName,
      args: context.invocation.args,
      projectRoot: context.projectRoot,
      policyReason: context.reason,
      provider: {
        id: entry.provider.id,
        name: entry.provider.name,
        kind: entry.provider.kind,
        baseUrl: entry.provider.baseUrl,
        models: entry.provider.models,
      },
      modelId: entry.modelId,
      apiKey,
      // 分析器不走内核，必须显式带上等级：否则这条不带工具的请求会以「关闭思考」发出，
      // 被「始终思考」的模型 400 掉，自动放行永远是兜底拒绝
      thinkingLevel: resolveThinkingLevel(getSession(options.sessionId)?.thinkingLevel),
    });

    // 分析期间 worker 可能已被回收/替换，回给已死的进程毫无意义
    if (this.#workers.get(options.sessionId) !== entry) return;

    // 审计留痕：分析器的每次结论都无条件落日志（含自动放行，也含随后被中断/模式变更丢弃的）。
    // 分析结论可能被入参里的提示注入影响，事后可凭此发现「本不该放行却被放行」。
    console.log(
      `[approval:analyze] tool=${toolName} allow=${result.allow} analyzed=${result.analyzed} reason=${result.reason}`,
    );

    // 分析期间用户中断：直接作废这次授权（回一条拒绝让 worker 解除阻塞），不再入队——
    // 否则中断后会凭空出现一张无法解释的待审卡片，且解除阻塞要等到 5 分钟超时
    if (entry.abortEpoch !== abortEpoch) {
      if (process.env.COLT_APPROVAL_DEBUG === "1") {
        console.log(`[approval] 分析期间会话已中断，丢弃结果 ${toolCallId}`);
      }
      entry.child.postMessage({
        type: "approvalResult",
        toolCallId,
        approved: false,
        reason: "会话已中断，授权已取消。",
      } satisfies WorkerCommand);
      this.#emitPending(options.sessionId);
      return;
    }

    // 分析期间审批模式被改：旧模式的结论不再适用，按新模式重新裁决。
    // 少了这一步，切到 full-access 后仍会弹出一张待审卡片，与「本会话内一律放行」矛盾。
    if (entry.modeEpoch !== modeEpoch) {
      const mode = this.approvals.getMode(options.sessionId);
      if (process.env.COLT_APPROVAL_DEBUG === "1") {
        console.log(`[approval] 分析期间模式已改为 ${mode}，按新模式重新裁决 ${toolCallId}`);
      }
      if (mode === "full-access") {
        entry.child.postMessage({
          type: "approvalResult",
          toolCallId,
          approved: true,
          reason: "会话已切换为全权执行模式，直接放行。",
        } satisfies WorkerCommand);
        this.#emitPending(options.sessionId);
        return;
      }
      // approval（以及「auto → 其它 → auto」这种连环切换）：一律转人工——
      // 既不让旧模式的结论生效，也不递归再调一次模型
      const requeued = this.approvals.commitAnalyzed({
        sessionId: options.sessionId,
        toolCallId,
        toolName,
        argsJson,
        now: Date.now(),
        allow: false,
        reason: "审批模式在分析期间发生变更，已转为人工确认。",
        timeoutMs: message.timeoutMs,
      });
      if ("request" in requeued) {
        this.#armApprovalTimer(entry, options.sessionId, toolCallId, message.timeoutMs);
        this.#emitPending(options.sessionId);
      }
      return;
    }

    const outcome = this.approvals.commitAnalyzed({
      sessionId: options.sessionId,
      toolCallId,
      toolName,
      argsJson,
      now: Date.now(),
      allow: result.allow,
      reason: result.reason,
      timeoutMs: message.timeoutMs,
    });

    if ("decision" in outcome) {
      entry.child.postMessage({
        type: "approvalResult",
        toolCallId,
        approved: outcome.decision.approved,
        reason: outcome.decision.reason,
      } satisfies WorkerCommand);
      // 分析放行的操作也推一次待审（此时为空），让界面清掉可能残留的占位
      this.#emitPending(options.sessionId);
      return;
    }

    // 未放行：该条目已入待审，沿用与人工审批相同的超时兜底
    this.#armApprovalTimer(entry, options.sessionId, toolCallId, message.timeoutMs);
    this.#emitPending(options.sessionId);
  }

  /**
   * 为一条待审条目起超时定时器：到点自动拒绝、唤醒 worker、刷新界面。
   * 人工审批与分析后退回确认共用同一套超时语义。
   */
  #armApprovalTimer(
    entry: WorkerEntry,
    sessionId: string,
    toolCallId: string,
    timeoutMs: number,
  ): void {
    // 兜底：worker 未上报 / 传了非法值时用默认 5 分钟，避免 setTimeout(undefined) 立即拒绝
    const durationMs = timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      this.#approvalTimers.delete(toolCallId);
      const decision = this.approvals.resolve({
        sessionId,
        toolCallId,
        approved: false,
        reason: "审批超时，已自动拒绝。",
      });
      if (decision) {
        entry.child.postMessage({
          type: "approvalResult",
          toolCallId,
          approved: decision.approved,
          reason: decision.reason,
        } satisfies WorkerCommand);
      }
      this.#emitPending(sessionId);
    }, durationMs);
    timer.unref?.();
    this.#approvalTimers.set(toolCallId, timer);
  }

  /** 会话被中断时，把所有待决授权一并作废（对齐 ACP Cancelled 语义） */
  cancelPending(sessionId: string, reason = "会话已中断，授权已取消。"): void {
    for (const item of this.approvals.listPending(sessionId)) {
      this.resolveApproval({
        sessionId,
        toolCallId: item.toolCallId,
        approved: false,
        reason,
      });
    }
  }

  #clearApprovalTimer(toolCallId: string): void {
    const timer = this.#approvalTimers.get(toolCallId);
    if (timer) {
      clearTimeout(timer);
      this.#approvalTimers.delete(toolCallId);
    }
  }

  /**
   * 执行一次宿主能力调用（浏览器/桌面）并回发结果。
   * 期间 worker 可能已被回收/替换，回给已死的进程毫无意义，直接丢弃。
   */
  async #handleToolRpc(
    entry: WorkerEntry,
    message: Extract<WorkerMessage, { type: "toolRpc" }>,
  ): Promise<void> {
    let result: WorkerCommand;
    try {
      const value: HostResult = await hostBridge.handle({
        sessionId: entry.sessionId,
        capability: message.capability,
        action: message.action,
        params: message.params,
      });
      result = { type: "toolRpcResult", requestId: message.requestId, ok: true, result: value };
    } catch (error) {
      result = {
        type: "toolRpcResult",
        requestId: message.requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (this.#workers.get(entry.sessionId) !== entry) return;
    entry.child.postMessage(result);
  }

  /** 已报过「记忆索引失败」的会话：同一段失败期只报一次，恢复后不撤回 */
  readonly #memoryIndexNoticed = new Set<string>();

  /**
   * 记忆文件快照入库（见 memory-index.ts）：文件是真源，这里只维护派生索引。
   * 索引失败不影响注入与检索之外的任何功能，但要如实可见（docs/ERRORS.md）——
   * 静默坏掉的检索会让模型以为「没有历史记忆」，比没有这个功能更糟。
   */
  async #handleMemoryIndex(
    options: { sessionId: string; cwd: string },
    message: Extract<WorkerMessage, { type: "memoryIndex" }>,
  ): Promise<void> {
    try {
      indexMemorySnapshot({
        scope: message.scope,
        projectKey: message.scope === "project" ? normalizeRootKey(options.cwd) : "",
        sourcePath:
          message.scope === "project"
            ? join(options.cwd, ".colt", "memory.md")
            : join(homedir(), ".colt", "memory.md"),
        content: message.content,
        sessionId: options.sessionId,
      });
    } catch (error) {
      if (this.#memoryIndexNoticed.has(options.sessionId)) return;
      this.#memoryIndexNoticed.add(options.sessionId);
      this.#emit("session.notice", {
        sessionId: options.sessionId,
        message: `记忆索引失败（检索将停在当前状态）：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  #sessionsRoot(): string {
    const dir = join(app.getPath("userData"), "sessions");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * 用数据库里的完整改动列表覆盖 worker 自报的 fileChanges。
   * 改动的真源是 DB，这样 worker 被回收重启后仍能完整重建，不会丢历史。
   * 上下文占用同理：worker 重启后内存值为 0，用 DB 里最近一轮的值回填；
   * worker 已有实时值时以其为准（DB 写入略滞后于内存）。
   */
  #withDbChanges(view: ConversationView): ConversationView {
    // 只在 worker 还没有实时值时才查库。本方法是 view 投影的必经出口，流式期间
    // 每次 flush（约 50ms）都会走到，无条件查库等于每个运行中会话每秒打约 20 次
    // 全表扫描，而算出来的值在 worker 有实时值时根本不会被采用。
    const contextUsed =
      view.stats.contextUsed > 0 ? view.stats.contextUsed : latestContextUsed(view.sessionId);
    return {
      ...view,
      fileChanges: this.#fileChanges(view.sessionId),
      stats: { ...view.stats, contextUsed },
    };
  }

  /**
   * 会话改动列表（DB 为真源），按会话缓存。
   * 主进程是 file_changes 的唯一写入方，故只需在写入点失效即可保证不返回陈旧数据；
   * 缓存与 worker 同寿命，避免为所有打开过的会话常驻内存。
   */
  #fileChanges(sessionId: string): ViewFileChange[] {
    const cached = this.#fileChangesCache.get(sessionId);
    if (cached) return cached;
    const list = listSessionFileChanges(sessionId);
    this.#fileChangesCache.set(sessionId, list);
    return list;
  }

  /** 统一出口：基于当前 entry.view 经 DB 回填后推送 */
  #emitView(entry: WorkerEntry): void {
    if (!entry.view) return;
    const next = this.#withDbChanges(entry.view);
    entry.view = next;
    this.#emit("session.view", next);
  }

  /**
   * 启动（或复用）某会话的 worker。
   * 同一会话的并发调用会共享同一次启动，避免重复 fork 泄漏进程。
   */
  async ensureWorker(options: {
    sessionId: string;
    cwd: string;
    model: string;
    provider: ProviderConfig;
  }): Promise<void> {
    // 已在启动中：复用同一个 Promise（StrictMode 双执行 / 快速切会话均会命中）
    const pending = this.#pending.get(options.sessionId);
    if (pending) return pending;

    const task = this.#spawnWorker(options).finally(() => {
      this.#pending.delete(options.sessionId);
    });
    this.#pending.set(options.sessionId, task);
    return task;
  }

  async #spawnWorker(options: {
    sessionId: string;
    cwd: string;
    model: string;
    provider: ProviderConfig;
  }): Promise<void> {
    const existing = this.#workers.get(options.sessionId);
    if (existing) {
      existing.lastActiveAt = Date.now();
      // 审批分析器按 entry 上的 provider/model 装配，复用分支也要同步
      existing.provider = options.provider;
      existing.modelId = options.model;
      await existing.ready;
      // 复用分支不能静默丢弃传入的模型：与 worker 当前不一致时补发切换命令
      const wanted = `${options.provider.id}/${options.model}`;
      if (existing.view && existing.view.model !== wanted) {
        this.setModel(options.sessionId, options.provider, options.model);
      }
      return;
    }

    this.#evictIfNeeded();

    const apiKey = getSecret(options.provider.id);
    // 需要密钥却没配 → 明确报错（界面在此之前已按 needsKey 引导去设置页）。
    // 无需密钥的服务（本地 / 自建 endpoint）照常启动——按「必须有密钥」拦下它，
    // 会让 ollama 这类服务永远打不开。
    if (!apiKey && options.provider.requiresKey) {
      throw new Error(`尚未配置 ${options.provider.name} 的 API Key，请先在设置中填写。`);
    }
    // 无需密钥时也得给 SDK 一个非空值：openai-completions 在 apiKey 为空时直接抛
    // 「No API key for provider」——它分不清「本地服务不需要密钥」和「用户忘了填」。
    // 本地服务一般不校验该请求头；真需要密钥的服务应保持 requiresKey 并正常填写。
    const providerKey = apiKey ?? KEYLESS_PLACEHOLDER;

    // 诊断钩子（仅开发态）：指向故障注入脚本，用于验证就绪失败路径。
    // 打包后一律使用真实 worker，避免误配指向恶意脚本。
    const workerPath =
      (!app.isPackaged && process.env.COLT_WORKER_OVERRIDE) || join(__dirname, "worker.js");
    const child = utilityProcess.fork(workerPath, [], {
      serviceName: `colt-session-${options.sessionId.slice(0, 8)}`,
      stdio: "pipe",
      env: {
        ...process.env,
        // 明文密钥只存在于 worker 进程环境中
        // 内置 DeepSeek 用官方约定的变量名，自定义 provider 用统一变量名
        DEEPSEEK_API_KEY: options.provider.kind === "deepseek" ? providerKey : "",
        COLT_PROVIDER_KEY: providerKey,
      },
    });
    // 记忆检索的项目隔离依据：cwd 由主进程登记，不信任 worker 报值（见 memory-host.ts）
    hostBridge.setMemoryContext(options.sessionId, options.cwd);

    // 就绪信号携带失败出口：worker 在发回 ready 之前退出时，exit 回调会 reject 它；
    // 进程活着但迟迟不发 ready（init 卡死）时由超时兑底。两者都保证 session.open 不会永久挂起。
    const readyDeferred = createDeferred<void>();
    const readyTimer = setTimeout(() => {
      readyDeferred.reject(new Error(`会话进程启动超时（${READY_TIMEOUT_MS / 1000}s），请重试。`));
      // 卡死的进程留着只会占坑，连同回收。已由 session.open 报错，无需再提示休眠
      const stuck = this.#workers.get(options.sessionId);
      if (stuck) this.#disposeWorker(stuck, "closed");
    }, READY_TIMEOUT_MS);
    // 就绪（或已失败）后无需再计时，也不阻止进程退出
    readyTimer.unref?.();
    void readyDeferred.promise.finally(() => clearTimeout(readyTimer)).catch(() => undefined);

    const entry: WorkerEntry = {
      sessionId: options.sessionId,
      child,
      lastActiveAt: Date.now(),
      running: false,
      provider: options.provider,
      modelId: options.model,
      ready: readyDeferred.promise,
      // 非空即表示「尚未就绪」：ready 一到就清空，命令恢复直接下发
      pendingCommands: [],
      pendingBranches: [],
      abortEpoch: 0,
      modeEpoch: 0,
    };
    this.#workers.set(options.sessionId, entry);
    // 登记项目根目录，审批策略靠它判断写入是否越界
    this.approvals.register(options.sessionId, options.cwd);

    child.on("message", (message: WorkerMessage) => {
      switch (message.type) {
        case "ready":
          // 持久化内核会话 ID，下次打开时续接历史
          setKernelSessionId(options.sessionId, message.kernelSessionId);
          // 先补发暂存命令再放行等待方：顺序上「init 期间下发的」必须排在「就绪后下发的」之前。
          // 此处 worker 已把 state 建好（它在 init 末尾才发 ready），补发是安全的。
          const queued = entry.pendingCommands ?? [];
          entry.pendingCommands = undefined;
          for (const command of queued) entry.child.postMessage(command);
          readyDeferred.resolve();
          // 通知界面：worker 已就绪（侧栏据此把“休眠/中断”退回正常态）
          this.#emit("session.status", { sessionId: options.sessionId, state: "idle" });
          break;
        case "view": {
          entry.view = this.#withDbChanges(message.view);
          entry.running = message.view.running;
          entry.lastActiveAt = Date.now();
          // 用首条用户消息作为会话标题
          const firstUser = message.view.messages.find((item) => item.role === "user");
          const title = firstUser?.text.slice(0, 30);
          touchSession(options.sessionId, message.view.messages.length, title);
          this.#emit("session.view", entry.view);
          break;
        }
        case "error": {
          this.#emit("session.error", {
            sessionId: options.sessionId,
            message: message.message,
          });
          if (message.fatal) {
            // init 失败：这个 worker 永远不会就绪。必须解除「暂存」标记，否则后续命令会被
            // 静默攒着，界面**毫无反馈**——那比报错更难排查。复位后照旧下发给它，由 worker
            // 自己报错（与本次修改前行为一致）。
            entry.pendingCommands = undefined;
            readyDeferred.reject(new Error(message.message));
          }
          break;
        }
        case "notice":
          // worker 的非错误通知（如压缩完成）：与 error 同一条通路，但渲染层按提示而非错误呈现
          this.#emit("session.notice", {
            sessionId: options.sessionId,
            message: message.message,
          });
          break;
        case "fileChange": {
          // 基线只在「本会话首次改动该文件」时随改动带来；落库按最早那份为准（见 recordFileBaseline）
          if (message.baseline !== undefined) {
            recordFileBaseline(options.sessionId, message.change.path, message.baseline);
          }
          const rowId = recordFileChange(options.sessionId, message.change);
          // 净值在这里算、当场写死：**以库里的基线为准**，不用消息里带来的那份——
          // worker 重启后不记得发过基线，会把「已经改过」的内容再报一次，信它就等于
          // 把会话前段的变化吃掉。算不出（没有基线 / 读不到）时写 NULL，界面因此不下结论。
          const net = computeNetChange(
            options.cwd,
            message.change.path,
            getFileBaseline(options.sessionId, message.change.path),
          );
          setChangeNet(rowId, net.status === "ok" ? { added: net.added, removed: net.removed } : null);
          // 唯一的写入点：缓存必须在此失效，否则后续投影会一直停在旧列表
          this.#fileChangesCache.delete(options.sessionId);
          this.#emitView(entry);
          break;
        }

        case "usage":
          // 用量历史只增不改，直接落库；视图里的累计值仍以内核快照为准
          recordUsage({
            sessionId: options.sessionId,
            kernelUsageId: message.kernelUsageId,
            provider: message.provider,
            model: message.model,
            input: message.input,
            output: message.output,
            cacheRead: message.cacheRead,
            cacheWrite: message.cacheWrite,
            costUsd: message.costUsd,
            timestamp: message.timestamp,
          });
          break;

        case "toolCall":
          recordToolCall({
            toolCallId: message.toolCallId,
            sessionId: options.sessionId,
            runId: message.runId,
            toolName: message.toolName,
            inputJson: message.inputJson,
            isError: message.isError,
            durationMs: message.durationMs,
            timestamp: message.timestamp,
          });
          break;

        case "approvalRequest": {
          if (process.env.COLT_APPROVAL_DEBUG === "1") {
            console.log(`[approval] main 收到请求 ${message.toolName} 模式=${this.approvals.getMode(options.sessionId)}`);
          }
          // worker 正阻塞在 before_tool，无论走哪条分支都必须回一次答复
          const outcome = this.approvals.evaluate({
            sessionId: options.sessionId,
            toolCallId: message.toolCallId,
            toolName: message.toolName,
            argsJson: message.argsJson,
            now: Date.now(),
            timeoutMs: message.timeoutMs,
          });
          if ("decision" in outcome) {
            entry.child.postMessage({
              type: "approvalResult",
              toolCallId: message.toolCallId,
              approved: outcome.decision.approved,
              reason: outcome.decision.reason,
            } satisfies WorkerCommand);
          } else if ("analyze" in outcome) {
            // 自动审批：调用大模型判定，期间 worker 仍阻塞在 before_tool
            this.#analyzeThenReply(entry, options, message, outcome.analyze);
          } else {
            // 与 worker 同步的超时兜底：到点自动拒绝，界面同步转为「已超时」
            this.#armApprovalTimer(entry, options.sessionId, message.toolCallId, message.timeoutMs);
            this.#emitPending(options.sessionId);
          }
          break;
        }

        case "toolRpc": {
          // 宿主能力（浏览器/桌面/记忆检索）由主进程执行，结果异步回发
          void this.#handleToolRpc(entry, message);
          break;
        }

        case "memoryIndex": {
          // 记忆文件快照入库：文件是真源，这里只维护派生索引。
          // 失败如实可见但不打断会话；同会话同一段失败期只报一次
          void this.#handleMemoryIndex(options, message);
          break;
        }

        case "branches": {
          // FIFO：worker 按收到的顺序回复，最早的等待方先兑现
          const settle = entry.pendingBranches.shift();
          settle?.(message.nodes);
          break;
        }

        case "modelChanged":
          // worker 已确认切到目标 provider/model，落库以便下次打开时恢复
          setSessionModel(options.sessionId, `${message.providerId}/${message.modelId}`);
          if (entry.view) {
            entry.view.model = `${message.providerId}/${message.modelId}`;
            this.#emitView(entry);
          }
          break;

        case "log":
          break;
      }
    });

    child.on("exit", (code) => {
      // 三分：
      // - 未主动销毁（disposeReason 为 undefined）→ 崩溃，发 crashed + error
      // - "idle"（超时回收 / 池淘汰）→ 发 dormant，侧栏提示「空闲休眠」
      // - "closed"（切走 / 启动超时 / 应用退出）→ 静默，属预期行为
      const reason = entry.disposeReason;
      this.#workers.delete(options.sessionId);
      // 与 #disposeWorker 对齐：worker 没了，改动列表缓存也一并丢弃
      this.#fileChangesCache.delete(options.sessionId);
      // 进程异常退出（未走 dispose 命令）时也要收掉浏览器窗口，避免孤儿窗口；
      // 正常 dispose 已先关过，这里是幂等空操作
      hostBridge.disposeSession(options.sessionId);
      clearTimeout(readyTimer);
      // 尚未 ready 就退出：掐断等待方，否则 session.open 永久挂起，
      // 渲染层会一直停在「正在启动会话进程…」。已 ready 时这里是空操作。
      readyDeferred.reject(new Error("会话进程在就绪前退出，请重试。"));
      if (!reason) {
        // 崩溃：无人能再响应审批与分支查询，清理避免界面残留幽灵卡片
        this.#emit("session.status", { sessionId: options.sessionId, state: "crashed" });
        const dropped = this.approvals.clearPending(options.sessionId);
        for (const item of dropped) this.#clearApprovalTimer(item.toolCallId);
        if (dropped.length > 0) this.#emitPending(options.sessionId);
        entry.pendingBranches.length = 0;
        this.#emit("session.error", {
          sessionId: options.sessionId,
          message: `会话进程异常退出（code=${code ?? "unknown"}），历史已保留。再发一条消息会自动重连恢复。`,
        });
      } else if (reason === "idle") {
        // 仅超时回收/池淘汰才提示休眠；用户主动切走不打扰
        this.#emit("session.status", { sessionId: options.sessionId, state: "dormant" });
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.error(`[worker ${options.sessionId.slice(0, 8)}]`, text);
    });

    // 直接下发而不走 `#post`：`init` 是**引导**命令，它自己就是「让 worker 就绪」的那一步。
    // 若也进 `#post`，会被「就绪前的命令暂存」逻辑攒起来永不发出——worker 永远不就绪。
    child.postMessage({
      type: "init",
      sessionsRoot: this.#sessionsRoot(),
      cwd: options.cwd,
      externalSessionId: options.sessionId,
      kernelSessionId: getSession(options.sessionId)?.kernelSessionId ?? undefined,
      provider: {
        id: options.provider.id,
        name: options.provider.name,
        kind: options.provider.kind,
        baseUrl: options.provider.baseUrl,
        models: options.provider.models,
      },
      model: options.model,
      // 会话存值 → 默认值。**不能**让内核的默认（off）兜底：off 会被兼容层翻译成
      // 「显式关闭思考」，对「始终思考」的模型必然 400（详见 shared/thinking-level.ts）
      thinkingLevel: resolveThinkingLevel(getSession(options.sessionId)?.thinkingLevel),
    } satisfies WorkerCommand);

    await readyDeferred.promise;
  }

  #post(sessionId: string, command: WorkerCommand): void {
    const entry = this.#workers.get(sessionId);
    if (!entry) throw new Error(`会话未运行：${sessionId}`);
    // 「在池中」只代表进程已拉起，不代表能收命令：init 还在重放历史时下发，worker 会以
    // 「会话尚未初始化」拒绝。就绪前一律暂存，由 ready 处理分支按序补发。
    if (entry.pendingCommands) entry.pendingCommands.push(command);
    else entry.child.postMessage(command);
    entry.lastActiveAt = Date.now();
  }

  prompt(sessionId: string, text: string, images?: { data: string; mimeType: string }[]): void {
    const entry = this.#workers.get(sessionId);
    if (!entry) throw new Error(`会话未运行：${sessionId}`);
    // 运行中则作为插话，否则作为新一轮提问
    this.#post(sessionId, { type: entry.running ? "steer" : "prompt", text, images });
  }

  /**
   * 投递一条用户消息；worker 已被回收时先重建再投递。
   *
   * 长时间不用的会话会被空闲回收（见 startIdleReaper），此时 #workers 里已无该
   * sessionId。旧行为是直接抛「会话未运行」，界面表现为“发了消息毫无反应”。
   * 这里改为透明自愈：借用调用方给的 recover 工厂重建 worker（它会复用 #pending
   * 去重），ready 后再发消息。若重建后 worker 仍不在池中（启动失败），
   * 则抛出“会话未运行”，由界面展示错误——不再静默。
   */
  async promptOrReconnect(
    sessionId: string,
    text: string,
    images: { data: string; mimeType: string }[] | undefined,
    recover: () => Promise<void>,
  ): Promise<void> {
    if (!this.#workers.has(sessionId)) {
      // 重建期间 worker 也可能被并发调用者拉起，recover 内部已用 #pending 去重
      await recover();
    }
    // 重建成功后按当前运行态选择 prompt / steer；仍缺失说明 recover 没成功
    const entry = this.#workers.get(sessionId);
    if (!entry) throw new Error(`会话未运行：${sessionId}`);
    this.#post(sessionId, { type: entry.running ? "steer" : "prompt", text, images });
  }

  abort(sessionId: string): void {
    // 先记中断代数：在飞的审批分析据此判定作废（见 #analyzeThenReply）
    const entry = this.#workers.get(sessionId);
    if (entry) entry.abortEpoch += 1;
    this.#post(sessionId, { type: "abort" });
    // 中断后待决授权已无意义，立即作废，避免界面残留可点击的幽灵卡片
    this.cancelPending(sessionId);
  }

  /** 显式插话（不管是否运行中） */
  steer(sessionId: string, text: string): void {
    this.#post(sessionId, { type: "steer", text });
  }

  /**
   * 把「用户手动操作了浏览器（后退 / 前进 / 刷新）」告知 agent（B1）。
   *
   * **不走审批**：审批裁决的是**模型给出的工具入参**（见 approval/policy.ts），
   * 而这条链路上的每一跳都由用户的点击发起，没有模型参与，也就没有可裁决的对象——
   * 用户直接点自己屏幕上那个浏览器的后退键，本来就无需谁批准。
   *
   * 但页面确实被换掉了，agent 手里那份「页面长什么样」随之过期，它接着按旧页面点击 / 输入就会做错事。
   * 所以这里把它转给 worker，由 worker 在下一次模型请求前注入一条环境提示（不写进 transcript）。
   *
   * **只在 agent 正在跑时转**：这条提示的全部意义，是保护一个在飞的运行不被过期页面误导；
   * 空闲时没有任何操作会踩到这个坑，留一条提示反而会在很久以后的一轮里凭空出现、变成噪声。
   */
  notifyUserBrowserNavigation(sessionId: string, text: string): void {
    const entry = this.#workers.get(sessionId);
    if (!entry || !entry.running) return;
    entry.child.postMessage({ type: "browserNotice", text } satisfies WorkerCommand);
  }

  setModel(sessionId: string, provider: ProviderConfig, modelId: string): void {
    // 同步到 entry，审批分析器跟着切换后的模型走
    const entry = this.#workers.get(sessionId);
    if (entry) {
      entry.provider = provider;
      entry.modelId = modelId;
    }
    this.#post(sessionId, {
      type: "setModel",
      provider: {
        id: provider.id,
        name: provider.name,
        kind: provider.kind,
        baseUrl: provider.baseUrl,
        models: provider.models,
      },
      modelId,
    });
  }

  /**
   * 切换会话模型；worker 不在池中时先重建再下发。
   *
   * 必须先落库 `sessions.model_ref`：**不能**只依赖 worker 回 `modelChanged` 再存——
   * 缺密钥时界面根本不会调 `session.open`（见 Conversation 的打开前言），会话没有 worker，
   * 而用户恰恰是在这种时候最需要能预先把模型选好（选了 provider 才有机会去填它的密钥）。
   * 旧行为下这条路径直接抛「会话未运行」，且模型欠账不落库：用户选了报错、重启又回到默认值，
   * 看上去就是个死循环。
   *
   * 已落库 + 无 worker 时**不重建**：重建要花几百毫秒且要密钥，而切换模型本身
   * 并不需要模型服务真的跑起来；下一次打开会话时 `session.open` 会带着新 model_ref 启动。
   */
  async setModelOrReconnect(
    sessionId: string,
    provider: ProviderConfig,
    modelId: string,
    recover: (() => Promise<void>) | undefined,
  ): Promise<void> {
    setSessionModel(sessionId, `${provider.id}/${modelId}`);
    if (!this.#workers.has(sessionId)) {
      // worker 不在池中：没给 recover（渲染层没传 cwd）就只落库，下次打开自会带上新模型；
      // 给了 recover 才尝试当场拉起，以便用户能立即发送消息。
      if (!recover) return;
      await recover().catch((error: unknown) => {
        // 重建失败不该把「已成功落库的模型切换」退化成报错：模型已经记下了，
        // 下一轮打开会生效。只记日志，不让界面弹红。
        console.error("[session] 切模型时重建 worker 失败，已仅落库", error);
      });
    }
    if (this.#workers.has(sessionId)) this.setModel(sessionId, provider, modelId);
  }

  compact(sessionId: string): void {
    this.#post(sessionId, { type: "compact" });
  }

  /** 显式调用技能；不带 cwd 时无法自愈重建（带 cwd 的路径见 `skillOrReconnect`） */
  skill(sessionId: string, name: string, instructions: string | undefined): void {
    this.#post(sessionId, { type: "skill", name, instructions });
  }

  /**
   * 切换会话思考等级：落库 + 在池中时下发。
   *
   * 比 `setModelOrReconnect` 简单一档：等级不需要模型服务真跑起来，也不影响「能否发消息」，
   * 故 worker 不在池中时**不重建**——下次打开会话会带着新等级启动（同 setModel 的注释：重建
   * 要几百毫秒且要密钥，而这件事根本不需要它）。
   */
  setThinkingLevel(sessionId: string, level: ThinkingLevel): void {
    setSessionThinkingLevel(sessionId, level);
    if (this.#workers.has(sessionId)) this.#post(sessionId, { type: "setThinkingLevel", level });
  }

  /**
   * 手动压缩；worker 已被空闲回收时先重建再投递（同 `promptOrReconnect` 的自愈）。
   *
   * 不比 `promptOrReconnect` 能合并：压缩与 prompt 的语义不同，重建后**必须**发 `compact`
   * 而不是 prompt / steer，否则用户敲的 `/compact` 会变成一轮真实的模型请求。
   */
  async compactOrReconnect(sessionId: string, recover: () => Promise<void>): Promise<void> {
    if (!this.#workers.has(sessionId)) {
      // 重建期间 worker 也可能被并发调用者拉起，recover 内部已用 #pending 去重
      await recover();
    }
    const entry = this.#workers.get(sessionId);
    if (!entry) throw new Error(`会话未运行：${sessionId}`);
    this.#post(sessionId, { type: "compact" });
  }

  /**
   * 显式调用一个技能；worker 已被空闲回收时先重建再投递（同 `compactOrReconnect`）。
   *
   * **刻意不做 `promptOrReconnect` 那样的 steer 回落**：运行中把一句话当插话送进去是自洽的，
   * 但把一次技能调用偷偷降级成一句话会改变它的语义（用户以为调了技能，实际只是说了句话）。
   * 恒发 `skill`，运行中由内核返回 `LaneBusy` → worker 回可见报错。
   */
  async skillOrReconnect(
    sessionId: string,
    name: string,
    instructions: string | undefined,
    recover: () => Promise<void>,
  ): Promise<void> {
    if (!this.#workers.has(sessionId)) {
      await recover();
    }
    const entry = this.#workers.get(sessionId);
    if (!entry) throw new Error(`会话未运行：${sessionId}`);
    this.#post(sessionId, { type: "skill", name, instructions });
  }

  /** 显式整理记忆（/memory-tidy）：worker 在独立子 lane 后台跑一轮 */
  memoryTidy(sessionId: string): void {
    this.#post(sessionId, { type: "memoryTidy" });
  }

  /**
   * 显式整理记忆；worker 已被空闲回收时先重建再投递（同 `compactOrReconnect` 的自愈）。
   * 与 `skillOrReconnect` 同理不做 steer 回落：整理不是一句话，语义不能偷换。
   * 恒发 `memoryTidy`，主 lane 忙时由 worker 回可见报错。
   */
  async memoryTidyOrReconnect(sessionId: string, recover: () => Promise<void>): Promise<void> {
    if (!this.#workers.has(sessionId)) {
      // 重建期间 worker 也可能被并发调用者拉起，recover 内部已用 #pending 去重
      await recover();
    }
    const entry = this.#workers.get(sessionId);
    if (!entry) throw new Error(`会话未运行：${sessionId}`);
    this.#post(sessionId, { type: "memoryTidy" });
  }

  navigate(sessionId: string, targetId: string): void {
    this.#post(sessionId, { type: "navigate", targetId });
  }

  /** 查询分支树：发命令后等 worker 回复。会话未打开时返回空（并非异常状态） */
  async branches(sessionId: string): Promise<BranchNode[]> {
    const entry = this.#workers.get(sessionId);
    if (!entry) return [];
    const queue = entry.pendingBranches;
    return new Promise<BranchNode[]>((resolve, reject) => {
      const settle = (nodes: BranchNode[]): void => {
        clearTimeout(timer);
        // 从队列摘除自己，避免超时后仍被晚到的回复占位
        const index = queue.indexOf(settle);
        if (index !== -1) queue.splice(index, 1);
        resolve(nodes);
      };
      const timer = setTimeout(() => {
        const index = queue.indexOf(settle);
        if (index !== -1) queue.splice(index, 1);
        reject(new Error("查询分支超时"));
      }, 10_000);
      queue.push(settle);
      this.#post(sessionId, { type: "branches" });
    });
  }

  getView(sessionId: string): ConversationView | undefined {
    const entry = this.#workers.get(sessionId);
    // 经 DB 回填，保证 fileChanges 与持久化一致
    return entry?.view ? this.#withDbChanges(entry.view) : undefined;
  }

  /**
   * 会话是否处于运行中（有活跃 worker 且正在跑 Agent）。
   * 删除会话前用它把“正在写入历史”的会话挡在门外。
   */
  isRunning(sessionId: string): boolean {
    return this.#workers.get(sessionId)?.running ?? false;
  }

  /**
   * 关闭会话 worker（渲染层卸载时调用）。
   * 运行中的会话不关闭——避免措断正在进行的 Agent 运行，
   * 让它在空闲回收或下次 open 时自然收敛。
   */
  /**
   * 关闭会话 worker（渲染层卸载时调用）。
   * 运行中的会话不关闭——避免措断正在进行的 Agent 运行，
   * 让它在空闲回收或下次 open 时自然收敛。
   * 这属于用户主动切走，不是“会话被系统收起来”，故标 closed 静默。
   */
  close(sessionId: string): boolean {
    const entry = this.#workers.get(sessionId);
    if (!entry || entry.running) return false;
    this.#disposeWorker(entry, "closed");
    return true;
  }

  /**
   * 发送 dispose 并从池中移除（不处理 exit 回调的幂等删）。
   * reason 决定进程退出时是否向界面提示：idle 会提示「空闲休眠」，closed 静默。
   */
  #disposeWorker(entry: WorkerEntry, reason: "idle" | "closed"): void {
    // 先记销毁原因：exit 回调据此区分崩溃 / 空闲休眠 / 静默关闭
    entry.disposeReason = reason;
    this.#workers.delete(entry.sessionId);
    // 缓存与 worker 同寿命：进程没了就丢弃，避免为打开过的历史会话常驻内存
    this.#fileChangesCache.delete(entry.sessionId);
    // 该会话的浏览器窗口随 worker 一起关闭，避免遗留孤儿窗口
    hostBridge.disposeSession(entry.sessionId);
    // worker 没了就无人能响应审批，待审条目必须清掉，否则界面残留幽灵卡片
    const dropped = this.approvals.clearPending(entry.sessionId);
    for (const item of dropped) this.#clearApprovalTimer(item.toolCallId);
    if (dropped.length > 0) this.#emitPending(entry.sessionId);
    // 无人再能响应分支查询；清空队列，等待方各自的超时会收敛
    entry.pendingBranches.length = 0;
    try {
      entry.child.postMessage({ type: "dispose" } satisfies WorkerCommand);
    } catch {
      entry.child.kill();
    }
    // dispose 只是一条消息，worker 正忙时可能始终不处理它——那会留下一个仍然攥着
    // 同一份会话 JSONL 的孤儿进程（dev 热重启下尤其容易发生），而内核要求 seq 跨行
    // 严格递增，双写会让整份历史再也打不开。给一小段宽限后强杀兜底，
    // 让「撤下 worker」是电平结果，而不是看它心情的边沿。
    const forceKill = setTimeout(() => entry.child.kill(), DISPOSE_GRACE_MS);
    forceKill.unref?.();
    entry.child.once("exit", () => clearTimeout(forceKill));
  }

  /** 超出进程池上限时，回收最久未活动的空闲 worker */
  #evictIfNeeded(): void {
    if (this.#workers.size < MAX_WORKERS) return;
    const idle = [...this.#workers.values()]
      .filter((entry) => !entry.running)
      .sort((a, b) => a.lastActiveAt - b.lastActiveAt);
    const victim = idle[0];
    if (!victim) throw new Error(`并发会话已达上限（${MAX_WORKERS}），请先结束一个运行中的会话。`);
    // 与超时回收同类：都是被系统收起来，提示「空闲休眠」
    this.#disposeWorker(victim, "idle");
  }

  /** 周期回收长时间空闲的 worker；唤醒靠 JSONL 重放，成本只是重启延迟 */
  startIdleReaper(): void {
    if (this.#reaper) return;
    this.#reaper = setInterval(() => {
      const now = Date.now();
      for (const entry of [...this.#workers.values()]) {
        if (!entry.running && now - entry.lastActiveAt > IDLE_TIMEOUT_MS) {
          this.#disposeWorker(entry, "idle");
        }
      }
    }, IDLE_SWEEP_MS);
    // 不阻止进程退出
    this.#reaper.unref();
  }

  disposeAll(): void {
    if (this.#reaper) {
      clearInterval(this.#reaper);
      this.#reaper = undefined;
    }
    for (const entry of [...this.#workers.values()]) {
      // 应用退出属预期关闭，标 closed 避免被 exit 回调当成崩溃或休眠告警
      entry.disposeReason = "closed";
      try {
        entry.child.postMessage({ type: "dispose" } satisfies WorkerCommand);
      } catch {
        // 进程可能已经退出，无需再处理
      }
      // 退出路径不能等宽限：主进程一走，宽限定时器随之消失，而孤儿 worker 仍握着
      // 那个会话文件的写权限——下个实例一起来就成了「双写」。强杀的代价最多是丢掉
      // 一条写了一半的事务，内核下次打开会按 torn 行修掉它。
      entry.child.kill();
    }
    this.#workers.clear();
    this.#fileChangesCache.clear();
    hostBridge.disposeAll();
  }
}

export const sessionManager = new SessionManager();
