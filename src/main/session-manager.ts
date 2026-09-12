/**
 * SessionManager：每会话一个 worker 进程（utilityProcess）
 * 负责启动、路由命令、转发视图、进程池上限与回收
 */
import { app, utilityProcess, type UtilityProcess, type BrowserWindow } from "electron";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { ConversationView, WorkerCommand, WorkerMessage } from "@shared/worker-protocol";
import type { BranchNode, ProviderConfig } from "@shared/protocol";
import { getSecret } from "./secrets";
import { getSession, setKernelSessionId, setSessionModel, touchSession, recordFileChange, recordUsage, recordToolCall, listSessionFileChanges, latestContextUsed } from "./db/repo";
import { ApprovalStore } from "./approval/store";
import { createDeferred } from "./lib/deferred";

/** 进程池上限，超出时回收最久未活动的空闲会话 */
const MAX_WORKERS = 6;
/** 空闲超过该时长且未运行的 worker 会被回收 */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
/**
 * worker 启动上限。长历史会话重放 JSONL 可能数十秒，阀值要给够；
 * 但一旦超过就说明 worker 卡住再也发不出 ready，必须拒绝等待方，
 * 否则 session.open 永久 pending，界面停在「正在启动会话进程…」。
 */
const READY_TIMEOUT_MS = Number(process.env.BANYAN_READY_TIMEOUT_MS ?? 120_000);
/** 空闲回收扫描间隔 */
const IDLE_SWEEP_MS = 60 * 1000;

interface WorkerEntry {
  sessionId: string;
  child: UtilityProcess;
  lastActiveAt: number;
  running: boolean;
  view?: ConversationView;
  /**
   * 就绪信号（createDeferred 的 promise）。worker 在发回 ready 之前就退出时会被
   * reject，从而掉出所有 await 它的调用方；否则 session.open 会永远 pending，
   * 界面停在「正在启动会话进程…」。
   */
  ready: Promise<void>;
  /**
   * 分支树查询的待决 promise（worker 以消息形式异步回复）。
   * 用队列而非单个回调：切会话 / 刷新按钮 / 分支导航都会触发查询，
   * 并发时单槽会让先到的请求永远拿不到结果（只能等到超时）。
   */
  pendingBranches: Array<(nodes: BranchNode[]) => void>;
}

export class SessionManager {
  readonly #workers = new Map<string, WorkerEntry>();
  /** 正在启动中的 worker，按 sessionId 去重并发 ensureWorker */
  readonly #pending = new Map<string, Promise<void>>();
  /** 审批状态中枢，与 worker 生命周期解耦 */
  readonly approvals = new ApprovalStore();
  /** 主进程侧的审批超时定时器，key 为 toolCallId；与 worker 的超时保持同步 */
  readonly #approvalTimers = new Map<string, NodeJS.Timeout>();
  #window: BrowserWindow | undefined;
  #reaper?: NodeJS.Timeout;

  attachWindow(window: BrowserWindow): void {
    this.#window = window;
  }

  #emit(channel: string, payload: unknown): void {
    if (this.#window && !this.#window.isDestroyed()) {
      this.#window.webContents.send(channel, payload);
    }
  }

  /** 推送某会话的待审列表（全量，渲染层直接替换） */
  #emitPending(sessionId: string): void {
    this.#emit("approval.pending", {
      sessionId,
      requests: this.approvals.listPending(sessionId),
    });
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
    if (process.env.BANYAN_APPROVAL_DEBUG === "1") {
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

  #sessionsRoot(): string {
    const dir = join(app.getPath("userData"), "sessions");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * 用数据库里的完整改动列表覆盖 worker 自报的 fileChanges。
   * 改动的真源是 DB，这样 worker 被回收重启后仍能完整重建，不会丢历史。
   * 上下文占用同理：worker 重启后内存值为 0，用 DB 里最近一轮的值回填；
   * worker 正在运行且已有实时值时以其为准（DB 写入略滞后于内存）。
   */
  #withDbChanges(view: ConversationView): ConversationView {
    const dbContextUsed = latestContextUsed(view.sessionId);
    const contextUsed = view.stats.contextUsed > 0 ? view.stats.contextUsed : dbContextUsed;
    return {
      ...view,
      fileChanges: listSessionFileChanges(view.sessionId),
      stats: { ...view.stats, contextUsed },
    };
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
    if (!apiKey) throw new Error(`尚未配置 ${options.provider.name} 的 API Key，请先在设置中填写。`);

    // 诊断钩子（仅开发态）：指向故障注入脚本，用于验证就绪失败路径。
    // 打包后一律使用真实 worker，避免误配指向恶意脚本。
    const workerPath =
      (!app.isPackaged && process.env.BANYAN_WORKER_OVERRIDE) || join(__dirname, "worker.js");
    const child = utilityProcess.fork(workerPath, [], {
      serviceName: `banyan-session-${options.sessionId.slice(0, 8)}`,
      stdio: "pipe",
      env: {
        ...process.env,
        // 明文密钥只存在于 worker 进程环境中
        // 内置 DeepSeek 用官方约定的变量名，自定义 provider 用统一变量名
        DEEPSEEK_API_KEY: options.provider.kind === "deepseek" ? apiKey : "",
        BANYAN_PROVIDER_KEY: apiKey,
      },
    });

    // 就绪信号携带失败出口：worker 在发回 ready 之前退出时，exit 回调会 reject 它；
    // 进程活着但迟迟不发 ready（init 卡死）时由超时兑底。两者都保证 session.open 不会永久挂起。
    const readyDeferred = createDeferred<void>();
    const readyTimer = setTimeout(() => {
      readyDeferred.reject(new Error(`会话进程启动超时（${READY_TIMEOUT_MS / 1000}s），请重试。`));
      // 卡死的进程留着只会占坑，连同回收
      const stuck = this.#workers.get(options.sessionId);
      if (stuck) this.#disposeWorker(stuck);
    }, READY_TIMEOUT_MS);
    // 就绪（或已失败）后无需再计时，也不阻止进程退出
    readyTimer.unref?.();
    void readyDeferred.promise.finally(() => clearTimeout(readyTimer)).catch(() => undefined);

    const entry: WorkerEntry = {
      sessionId: options.sessionId,
      child,
      lastActiveAt: Date.now(),
      running: false,
      ready: readyDeferred.promise,
      pendingBranches: [],
    };
    this.#workers.set(options.sessionId, entry);
    // 登记项目根目录，审批策略靠它判断写入是否越界
    this.approvals.register(options.sessionId, options.cwd);

    child.on("message", (message: WorkerMessage) => {
      switch (message.type) {
        case "ready":
          // 持久化内核会话 ID，下次打开时续接历史
          setKernelSessionId(options.sessionId, message.kernelSessionId);
          readyDeferred.resolve();
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
          if (message.fatal) readyDeferred.reject(new Error(message.message));
          break;
        }
        case "fileChange":
          // 落库后回填：worker 只负责上报，改动的投影始终以 DB 为准
          recordFileChange(options.sessionId, message.change);
          this.#emitView(entry);
          break;

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
          if (process.env.BANYAN_APPROVAL_DEBUG === "1") {
            console.log(`[approval] main 收到请求 ${message.toolName} 模式=${this.approvals.getMode()}`);
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
          } else {
            // 与 worker 同步的超时兜底：到点自动拒绝，界面同步转为「已超时」
            const { toolCallId } = message;
            const timer = setTimeout(() => {
              this.#approvalTimers.delete(toolCallId);
              const decision = this.approvals.resolve({
                sessionId: options.sessionId,
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
              this.#emitPending(options.sessionId);
            }, message.timeoutMs);
            timer.unref?.();
            this.#approvalTimers.set(toolCallId, timer);
            this.#emitPending(options.sessionId);
          }
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

    child.on("exit", () => {
      this.#workers.delete(options.sessionId);
      clearTimeout(readyTimer);
      // 尚未 ready 就退出：掐断等待方，否则 session.open 永久挂起，
      // 渲染层会一直停在「正在启动会话进程…」。已 ready 时这里是空操作。
      readyDeferred.reject(new Error("会话进程在就绪前退出，请重试。"));
      this.#emit("session.status", { sessionId: options.sessionId, state: "idle" });
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.error(`[worker ${options.sessionId.slice(0, 8)}]`, text);
    });

    this.#post(options.sessionId, {
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
    });

    await readyDeferred.promise;
  }

  #post(sessionId: string, command: WorkerCommand): void {
    const entry = this.#workers.get(sessionId);
    if (!entry) throw new Error(`会话未运行：${sessionId}`);
    entry.child.postMessage(command);
    entry.lastActiveAt = Date.now();
  }

  prompt(sessionId: string, text: string): void {
    const entry = this.#workers.get(sessionId);
    if (!entry) throw new Error(`会话未运行：${sessionId}`);
    // 运行中则作为插话，否则作为新一轮提问
    this.#post(sessionId, { type: entry.running ? "steer" : "prompt", text });
  }

  abort(sessionId: string): void {
    this.#post(sessionId, { type: "abort" });
    // 中断后待决授权已无意义，立即作废，避免界面残留可点击的幽灵卡片
    this.cancelPending(sessionId);
  }

  /** 显式插话（不管是否运行中） */
  steer(sessionId: string, text: string): void {
    this.#post(sessionId, { type: "steer", text });
  }

  setModel(sessionId: string, provider: ProviderConfig, modelId: string): void {
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

  compact(sessionId: string): void {
    this.#post(sessionId, { type: "compact" });
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
   * 关闭会话 worker（渲染层卸载时调用）。
   * 运行中的会话不关闭——避免措断正在进行的 Agent 运行，
   * 让它在空闲回收或下次 open 时自然收敛。
   */
  close(sessionId: string): boolean {
    const entry = this.#workers.get(sessionId);
    if (!entry || entry.running) return false;
    this.#disposeWorker(entry);
    return true;
  }

  /** 发送 dispose 并从池中移除（不处理 exit 回调的幂等删） */
  #disposeWorker(entry: WorkerEntry): void {
    this.#workers.delete(entry.sessionId);
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
  }

  /** 超出进程池上限时，回收最久未活动的空闲 worker */
  #evictIfNeeded(): void {
    if (this.#workers.size < MAX_WORKERS) return;
    const idle = [...this.#workers.values()]
      .filter((entry) => !entry.running)
      .sort((a, b) => a.lastActiveAt - b.lastActiveAt);
    const victim = idle[0];
    if (!victim) throw new Error(`并发会话已达上限（${MAX_WORKERS}），请先结束一个运行中的会话。`);
    this.#disposeWorker(victim);
  }

  /** 周期回收长时间空闲的 worker；唤醒靠 JSONL 重放，成本只是重启延迟 */
  startIdleReaper(): void {
    if (this.#reaper) return;
    this.#reaper = setInterval(() => {
      const now = Date.now();
      for (const entry of [...this.#workers.values()]) {
        if (!entry.running && now - entry.lastActiveAt > IDLE_TIMEOUT_MS) {
          this.#disposeWorker(entry);
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
      try {
        entry.child.postMessage({ type: "dispose" } satisfies WorkerCommand);
      } catch {
        entry.child.kill();
      }
    }
    this.#workers.clear();
  }
}

export const sessionManager = new SessionManager();
