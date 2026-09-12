/**
 * SessionManager：每会话一个 worker 进程（utilityProcess）
 * 负责启动、路由命令、转发视图、进程池上限与回收
 * 作者：陕耀云栈WorkMate
 */
import { app, utilityProcess, type UtilityProcess, type BrowserWindow } from "electron";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { ConversationView, WorkerCommand, WorkerMessage } from "@shared/worker-protocol";
import type { BranchNode, ProviderConfig } from "@shared/protocol";
import { getSecret } from "./secrets";
import { getSession, setKernelSessionId, setSessionModel, touchSession, recordFileChange, recordUsage, recordToolCall, listSessionFileChanges } from "./db/repo";

/** 进程池上限，超出时回收最久未活动的空闲会话 */
const MAX_WORKERS = 6;
/** 空闲超过该时长且未运行的 worker 会被回收 */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
/** 空闲回收扫描间隔 */
const IDLE_SWEEP_MS = 60 * 1000;

interface WorkerEntry {
  sessionId: string;
  child: UtilityProcess;
  lastActiveAt: number;
  running: boolean;
  view?: ConversationView;
  ready: Promise<void>;
  /** 分支树查询的待决 promise（worker 以消息形式异步回复） */
  pendingBranches?: (nodes: BranchNode[]) => void;
}

export class SessionManager {
  readonly #workers = new Map<string, WorkerEntry>();
  /** 正在启动中的 worker，按 sessionId 去重并发 ensureWorker */
  readonly #pending = new Map<string, Promise<void>>();
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

  #sessionsRoot(): string {
    const dir = join(app.getPath("userData"), "sessions");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * 用数据库里的完整改动列表覆盖 worker 自报的 fileChanges。
   * 改动的真源是 DB，这样 worker 被回收重启后仍能完整重建，不会丢历史。
   */
  #withDbChanges(view: ConversationView): ConversationView {
    return { ...view, fileChanges: listSessionFileChanges(view.sessionId) };
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

    const workerPath = join(__dirname, "worker.js");
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

    let resolveReady: () => void;
    let rejectReady: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const entry: WorkerEntry = {
      sessionId: options.sessionId,
      child,
      lastActiveAt: Date.now(),
      running: false,
      ready,
    };
    this.#workers.set(options.sessionId, entry);

    child.on("message", (message: WorkerMessage) => {
      switch (message.type) {
        case "ready":
          // 持久化内核会话 ID，下次打开时续接历史
          setKernelSessionId(options.sessionId, message.kernelSessionId);
          resolveReady();
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
          if (message.fatal) rejectReady(new Error(message.message));
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
            toolName: message.toolName,
            inputJson: message.inputJson,
            isError: message.isError,
            durationMs: message.durationMs,
            timestamp: message.timestamp,
          });
          break;

        case "branches":
          entry.pendingBranches?.(message.nodes);
          entry.pendingBranches = undefined;
          break;

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

    await ready;
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

  /** 查询分支树：发命令后等 worker 回复 */
  async branches(sessionId: string): Promise<BranchNode[]> {
    const entry = this.#workers.get(sessionId);
    if (!entry) throw new Error(`会话未运行：${sessionId}`);
    return new Promise<BranchNode[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        entry.pendingBranches = undefined;
        reject(new Error("查询分支超时"));
      }, 10_000);
      entry.pendingBranches = (nodes) => {
        clearTimeout(timer);
        resolve(nodes);
      };
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
