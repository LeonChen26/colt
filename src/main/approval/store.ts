/**
 * 待审批队列：主进程侧的审批状态中枢。
 *
 * worker 阻塞在 before_tool 等答复，本模块负责：
 *   1. 用 policy 判定是放行还是要问用户
 *   2. 需要问的挂进待审队列并通知渲染层
 *   3. 用户处置后回传 worker，并按需记忆放行规则
 *
 * 记忆规则与审批模式只存在于内存、以 Banyan 会话为单位存活：不落盘，也不随
 * worker 进程启停重置；删除会话（unregister）或退出应用即失效——权限决定不应
 * 悄悄长期生效。待审队列则与 worker 同寿命，进程没了即清空。
 */
import type {
  ApprovalMode,
  ApprovalRequest,
  ApprovalRisk,
  ApprovalRuleKind,
  ApprovalRuleView,
} from "@shared/protocol";
import { buildSignature, evaluateTool, type AllowRule, type ToolInvocation } from "./policy";

export interface ApprovalDecision {
  approved: boolean;
  /** 拒绝时回给模型的说明 */
  reason: string;
}

/** 审批等待上限的默认值（worker 未上报时兜底）：5 分钟 */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

interface SessionState {
  projectRoot: string;
  /** 会话内记住的放行规则：与 mode 同寿命，跨 worker 启停保留 */
  rules: AllowRule[];
  /** 会话内记住的拒绝规则：命中即自动拒绝，不再打扰用户 */
  denyRules: AllowRule[];
  /** 该会话显式设定的审批模式；未设定时回退全局默认 */
  mode?: ApprovalMode;
  /** 待审队列：与 worker 同寿命，进程没了即清空（阻塞在 before_tool 的调用方已消失） */
  pending: Map<string, ApprovalRequest>;
}

export class ApprovalStore {
  private readonly sessions = new Map<string, SessionState>();
  private mode: ApprovalMode = "auto";
  /** 规则 id 单调递增，仅在本进程内唯一即可（规则本身就不落盘） */
  #ruleSeq = 0;

  /** 给规则补一个稳定 id */
  #withId(rule: AllowRule): AllowRule {
    return rule.id !== undefined ? rule : { ...rule, id: `r${(this.#ruleSeq += 1)}` };
  }

  /** 读取审批模式：传入 sessionId 时优先该会话的设定，否则为全局默认 */
  getMode(sessionId?: string): ApprovalMode {
    if (sessionId !== undefined) {
      const state = this.sessions.get(sessionId);
      if (state?.mode !== undefined) return state.mode;
    }
    return this.mode;
  }

  /**
   * 设定审批模式。
   * 传入 sessionId：只改该会话的设定；会话尚未登记时先建一个占位 state，
   *   避免把「会话级」误写成全局默认（否则会污染其他会话）。
   * 不传 sessionId：改全局默认，作为未单独设定会话的回退值。
   *
   * 切到 full-access 时清空记忆的放行/拒绝规则：两者的语义都是代用户做后续
   * 决定，在全权模式下已无意义；而拒绝规则优先级高于模式（见 evaluate 中 deny
   * 检查在 evaluateTool 之前），不清空会让用户切了全权仍被旧规则拦住，且界面
   * 无从解释。
   */
  setMode(mode: ApprovalMode, sessionId?: string): void {
    if (sessionId !== undefined) {
      const state = this.sessions.get(sessionId);
      if (state) {
        state.mode = mode;
        if (mode === "full-access") this.#forgetRules(state);
      } else {
        // 会话未登记（worker 未起）：建占位 state，register 时会保留这里的 mode
        this.sessions.set(sessionId, {
          projectRoot: "",
          rules: [],
          denyRules: [],
          pending: new Map(),
          mode,
        });
      }
      return;
    }
    this.mode = mode;
    // 改全局默认同样清空各会话的记忆规则，避免旧规则继续压过新模式
    if (mode === "full-access") {
      for (const state of this.sessions.values()) this.#forgetRules(state);
    }
  }

  /** 清空某会话记忆的放行与拒绝规则 */
  #forgetRules(state: SessionState): void {
    state.rules.length = 0;
    state.denyRules.length = 0;
  }

  /**
   * 会话建立时登记项目根目录。
   * 重复登记（worker 回收后重开）**保留会话级状态**：审批模式与记忆规则都以
   * Banyan 会话为单位存活，不随 worker 进程重置——否则用户点过「本会话内始终
   * 允许」后，只要切走一次会话（卸载会 dispose worker）就会再次被询问。
   * 只有待审队列随进程清空：阻塞在 before_tool 的调用方已随该进程消失。
   */
  register(sessionId: string, projectRoot: string): void {
    const previous = this.sessions.get(sessionId);
    this.sessions.set(sessionId, {
      projectRoot,
      rules: previous?.rules ?? [],
      denyRules: previous?.denyRules ?? [],
      pending: new Map(),
      mode: previous?.mode,
    });
  }

  unregister(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  listPending(sessionId: string): ApprovalRequest[] {
    const state = this.sessions.get(sessionId);
    if (!state) return [];
    return [...state.pending.values()].sort((a, b) => a.requestedAt - b.requestedAt);
  }

  /**
   * 判定一次工具调用。
   *   - decision：立即放行或拒绝；
   *   - request：需要用户处置；
   *   - analyze：自动审批模式下待大模型分析（上层调用 analyzer 后回到 commitAnalyzed）。
   */
  evaluate(input: {
    sessionId: string;
    toolCallId: string;
    toolName: string;
    argsJson: string;
    now: number;
    /** worker 上报的等待上限；缺省用兜底值 */
    timeoutMs?: number;
  }):
    | { decision: ApprovalDecision }
    | { request: ApprovalRequest }
    | { analyze: { invocation: ToolInvocation; projectRoot: string; reason: string } } {
    const state = this.sessions.get(input.sessionId);
    // 未登记的会话按最保守处理：不认识就放行会让审批形同虚设
    const projectRoot = state?.projectRoot ?? "";

    const args = safeParseArgs(input.argsJson);
    const invocation: ToolInvocation = { toolName: input.toolName, args };
    const signature = buildSignature(invocation);

    // 命中会话内的拒绝记忆 → 直接拒绝，不再打扰用户
    if (state && matchedByRules(invocation, signature, state.denyRules)) {
      return {
        decision: { approved: false, reason: `本次会话已拒绝该操作：${input.toolName}` },
      };
    }

    const verdict = evaluateTool(invocation, {
      mode: state?.mode ?? this.mode,
      projectRoot,
      allowRules: state?.rules ?? [],
    });

    if (process.env.BANYAN_APPROVAL_DEBUG === "1") {
      console.log(
        `[approval] 判定 tool=${input.toolName} → ${verdict.decision}` +
          ` risk=${verdict.risk} reason=${verdict.reason}` +
          ` mode=${this.mode} rules=${state?.rules.length ?? -1}` +
          ` 已登记=${state !== undefined} root="${projectRoot}" args=${input.argsJson.slice(0, 80)}`,
      );
    }

    if (verdict.decision === "allow") {
      return { decision: { approved: true, reason: verdict.reason } };
    }

    // 自动审批：白名单外普通操作交给大模型分析，不在 store 里做 IO
    if (verdict.decision === "analyze") {
      return {
        analyze: { invocation, projectRoot, reason: verdict.reason },
      };
    }

    return { request: this.#enqueue(input, verdict) };
  }

  /**
   * 落实大模型的分析结果（自动审批模式）。
   * 不变量：调用前该 toolCallId 应在 analyze 分支返回过，且未被用户/超时处置。
   * 分析放行时不写记忆规则：避免把一次模型判断固化成长期免问。
   */
  commitAnalyzed(input: {
    sessionId: string;
    toolCallId: string;
    toolName: string;
    argsJson: string;
    now: number;
    allow: boolean;
    reason: string;
    timeoutMs?: number;
  }): { decision: ApprovalDecision } | { request: ApprovalRequest } {
    if (input.allow) {
      return { decision: { approved: true, reason: input.reason } };
    }
    // 分析不确定/拒绝：退回人工确认（而不是直接拒绝，把最终决定权留给用户）
    const verdict = evaluateTool(
      { toolName: input.toolName, args: safeParseArgs(input.argsJson) },
      {
        // 用 approval 模式重新判定，只为拿到展示用的 summary/signature/risk
        mode: "approval",
        projectRoot: this.sessions.get(input.sessionId)?.projectRoot ?? "",
        allowRules: [],
      },
    );
    return { request: this.#enqueue(input, { ...verdict, reason: input.reason }) };
  }

  /** 构造待审条目并入队 */
  #enqueue(
    input: { sessionId: string; toolCallId: string; toolName: string; argsJson: string; now: number; timeoutMs?: number },
    verdict: { summary: string; risk: ApprovalRisk; reason: string; signature: string },
  ): ApprovalRequest {
    const request: ApprovalRequest = {
      toolCallId: input.toolCallId,
      sessionId: input.sessionId,
      toolName: input.toolName,
      argsJson: input.argsJson,
      summary: verdict.summary,
      risk: verdict.risk,
      reason: verdict.reason,
      signature: verdict.signature,
      requestedAt: input.now,
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
    this.sessions.get(input.sessionId)?.pending.set(input.toolCallId, request);
    return request;
  }

  /**
   * 处置一条待审。返回 null 表示这条不存在（重复处置或已超时清理）。
   * remember 仅在批准时生效，拒绝不产生记忆规则。
   */
  resolve(input: {
    sessionId: string;
    toolCallId: string;
    approved: boolean;
    reason?: string;
    remember?: "signature" | "tool";
    deny?: "signature" | "tool";
  }): ApprovalDecision | null {
    const state = this.sessions.get(input.sessionId);
    const request = state?.pending.get(input.toolCallId);
    if (!state || !request) return null;

    state.pending.delete(input.toolCallId);

    if (input.approved && input.remember) {
      // 高风险调用不写记忆：policy 也会兜住，这里提前拦一道避免无效规则堆积
      if (request.risk !== "dangerous") {
        state.rules.push(
          this.#withId(
            input.remember === "tool"
              ? { toolName: request.toolName, scope: "tool" }
              : { toolName: request.toolName, scope: "signature", signature: request.signature },
          ),
        );
      }
    }

    // 「始终拒绝」：记住拒绝，下次同类调用直接拦下
    if (!input.approved && input.deny) {
      state.denyRules.push(
        this.#withId(
          input.deny === "tool"
            ? { toolName: request.toolName, scope: "tool" }
            : { toolName: request.toolName, scope: "signature", signature: request.signature },
        ),
      );
    }

    return {
      approved: input.approved,
      reason:
        input.reason ??
        (input.approved
          ? "用户已批准"
          : "用户拒绝了这次工具调用。请换一种做法，或先向用户说明原因。"),
    };
  }

  /**
   * 列出会话内已记忆的规则（放行 + 拒绝），供界面查看与管理。
   * 返回视图对象而非内部数组，避免界面拿到可变引用直接改内部状态。
   */
  listRules(sessionId: string): ApprovalRuleView[] {
    const state = this.sessions.get(sessionId);
    if (!state) return [];
    const toView = (rule: AllowRule, kind: ApprovalRuleKind): ApprovalRuleView => ({
      id: rule.id ?? "",
      kind,
      toolName: rule.toolName,
      scope: rule.scope,
      ...(rule.signature !== undefined ? { signature: rule.signature } : {}),
    });
    return [
      ...state.rules.map((rule) => toView(rule, "allow")),
      ...state.denyRules.map((rule) => toView(rule, "deny")),
    ];
  }

  /**
   * 删除一条规则。返回是否删中。
   * 放行与拒绝两类共用同一套 id 空间，故两边都找一遍。
   */
  removeRule(sessionId: string, ruleId: string): boolean {
    const state = this.sessions.get(sessionId);
    if (!state) return false;
    for (const bucket of [state.rules, state.denyRules]) {
      const index = bucket.findIndex((rule) => rule.id === ruleId);
      if (index >= 0) {
        bucket.splice(index, 1);
        return true;
      }
    }
    return false;
  }

  /** 清空规则；不给 kind 时两类都清 */
  clearRules(sessionId: string, kind?: ApprovalRuleKind): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    if (kind === undefined || kind === "allow") state.rules.length = 0;
    if (kind === undefined || kind === "deny") state.denyRules.length = 0;
  }

  /** 会话被回收或中断时清空待审，避免界面残留幽灵条目 */
  clearPending(sessionId: string): ApprovalRequest[] {    const state = this.sessions.get(sessionId);
    if (!state) return [];
    const dropped = [...state.pending.values()];
    state.pending.clear();
    return dropped;
  }
}

/** 把 argsJson 安全解析成对象；非对象或解析失败一律当空对象（保守） */
function safeParseArgs(argsJson: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(argsJson);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 落到空对象
  }
  return {};
}

/** 判断已记忆的规则是否覆盖本次调用 */
function matchedByRules(
  invocation: ToolInvocation,
  signature: string,
  rules: AllowRule[],
): boolean {
  return rules.some((rule) => {
    if (rule.toolName !== invocation.toolName) return false;
    if (rule.scope === "tool") return true;
    return rule.signature === signature;
  });
}
