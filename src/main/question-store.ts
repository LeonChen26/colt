/**
 * 待答提问队列：主进程侧的 `ask_user` 状态中枢。
 *
 * 与审批**同形**（worker 阻塞、主进程回答、有超时兜底），但**不共用**任何存储与策略：
 * 审批的默认值是「放行」（`full-access` / `auto` 会自动批准），提问的默认值必须是
 * 「没答案」——一旦让提问流进审批策略，用户切到全权模式后每次提问都会被静默
 * 「批准」，模型收到的是「已通过」而不是答案，那比没有提问工具更糟（持续撒谎）。
 * 见 `docs/DESIGN-ask-user.md` §3。
 *
 * 本模块只管队列与超时；「回发 worker」和「推界面」由宿主的回调决定，
 * 这样状态机在这里是完整可读的，副作用仍然留在 session-manager 手上。
 */
import { APPROVAL_TIMEOUT_MS } from "@shared/limits";
import type {
  AskUserQuestion,
  AskUserSkipReason,
  WorkerCommand,
} from "@shared/worker-protocol";

export interface UserQuestionRecord {
  toolCallId: string;
  questions: AskUserQuestion[];
  /** 入队时刻（ms），界面据此算剩余时间 */
  requestedAt: number;
  timeoutMs: number;
}

/**
 * 宿主接线：队列只负责**何时**该发什么，发到哪由宿主决定。
 * 三者都是一行委托（`post` / `emit` / `#syncAttention`），放在这里是想把
 * 「入队 → 推界面 → 等答复 → 回 worker → 出队」这条状态机留在同一个文件里读完。
 */
export interface QuestionStoreHost {
  /** 把答复发回 worker；队列保证只在「这条确实还挂着」时调用 */
  post: (sessionId: string, command: WorkerCommand) => void;
  /** 推送待答列表给界面（全量，渲染层直接替换） */
  emit: (sessionId: string, requests: UserQuestionRecord[]) => void;
  /** 队列变化后同步「请求注意」状态（与审批共用闪烁） */
  attention: (sessionId: string) => void;
}

export class QuestionStore {
  readonly #bySession = new Map<string, Map<string, UserQuestionRecord>>();
  /** 超时定时器，key 为 toolCallId；与 worker 侧的等待上限保持同步 */
  readonly #timers = new Map<string, NodeJS.Timeout>();
  readonly #host: QuestionStoreHost;

  constructor(host: QuestionStoreHost) {
    this.#host = host;
  }

  /** 当前待答的提问（渲染层与冒烟据此渲染 / 断言） */
  list(sessionId: string): UserQuestionRecord[] {
    const bySession = this.#bySession.get(sessionId);
    if (!bySession) return [];
    return [...bySession.values()];
  }

  count(sessionId: string): number {
    return this.#bySession.get(sessionId)?.size ?? 0;
  }

  /** 入队并起超时；timeoutMs 传 0 时沿用审批的等待上限（同一份常量，别写第二份） */
  enqueue(
    sessionId: string,
    toolCallId: string,
    questions: AskUserQuestion[],
    timeoutMs: number,
  ): void {
    const durationMs = timeoutMs > 0 ? timeoutMs : APPROVAL_TIMEOUT_MS;
    // 同一条重复入队（上游重发）时先撤旧定时器：它到点会把**新**记录一起判成超时，
    // 此后用户真正的作答会因「队列里已经没有这条」被静默丢弃
    this.#clearTimer(toolCallId);
    let bySession = this.#bySession.get(sessionId);
    if (!bySession) {
      bySession = new Map();
      this.#bySession.set(sessionId, bySession);
    }
    bySession.set(toolCallId, {
      toolCallId,
      questions,
      requestedAt: Date.now(),
      timeoutMs: durationMs,
    });

    const timer = setTimeout(() => {
      this.#timers.delete(toolCallId);
      this.#settle(sessionId, toolCallId, undefined, "timeout");
    }, durationMs);
    timer.unref?.();
    this.#timers.set(toolCallId, timer);

    this.#host.emit(sessionId, this.list(sessionId));
    this.#host.attention(sessionId);
  }

  /** 用户作答 */
  answer(sessionId: string, toolCallId: string, answers: Record<string, string>): void {
    this.#settle(sessionId, toolCallId, answers, undefined);
  }

  /**
   * 用户点了「跳过」：明确的不回答，对话仍在继续。
   * 与「会话被中断」分成两档——两者对模型的含义完全不同（前者可以按假设继续，后者要停）。
   */
  skip(sessionId: string, toolCallId: string): void {
    this.#settle(sessionId, toolCallId, undefined, "skipped");
  }

  /** 会话中断 / worker 回收：全部作废，否则界面留着一张点不动的卡 */
  cancelAll(sessionId: string): void {
    const bySession = this.#bySession.get(sessionId);
    if (!bySession) return;
    for (const toolCallId of [...bySession.keys()]) {
      this.#settle(sessionId, toolCallId, undefined, "cancelled");
    }
  }

  /** 清掉某条提问的超时定时器：结算与重复入队都要走它，别在别处再写一遍 */
  #clearTimer(toolCallId: string): void {
    const timer = this.#timers.get(toolCallId);
    if (timer) {
      clearTimeout(timer);
      this.#timers.delete(toolCallId);
    }
  }

  /** 落定的唯一出口：清定时器、出队、通知宿主 */
  #settle(
    sessionId: string,
    toolCallId: string,
    answers: Record<string, string> | undefined,
    skipped: AskUserSkipReason | undefined,
  ): void {
    this.#clearTimer(toolCallId);
    const bySession = this.#bySession.get(sessionId);
    const existed = bySession?.delete(toolCallId) ?? false;
    // 队列里本来就没有这条（重复作答或已超时）时不回发：worker 侧已不在这条上等
    if (existed) {
      this.#host.post(sessionId, {
        type: "askUserResult",
        toolCallId,
        ...(answers !== undefined ? { answers } : {}),
        ...(skipped !== undefined ? { skipped } : {}),
      } satisfies WorkerCommand);
    }
    this.#host.emit(sessionId, this.list(sessionId));
    this.#host.attention(sessionId);
  }
}
