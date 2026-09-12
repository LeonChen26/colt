/**
 * 待审批队列：主进程侧的审批状态中枢。
 *
 * worker 阻塞在 before_tool 等答复，本模块负责：
 *   1. 用 policy 判定是放行还是要问用户
 *   2. 需要问的挂进待审队列并通知渲染层
 *   3. 用户处置后回传 worker，并按需记忆放行规则
 *
 * 记忆规则只在会话生命周期内有效，不落盘——权限决定不应悄悄长期生效。
 */
import type { ApprovalMode, ApprovalRequest, ApprovalRisk } from "@shared/protocol";
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
  rules: AllowRule[];
  /** 会话内记住的拒绝规则：命中即自动拒绝，不再打扰用户 */
  denyRules: AllowRule[];
  /** 该会话显式设定的审批模式；未设定时回退全局默认 */
  mode?: ApprovalMode;
  pending: Map<string, ApprovalRequest>;
}

export class ApprovalStore {
  private readonly sessions = new Map<string, SessionState>();
  private mode: ApprovalMode = "approval";

  /** 读取审批模式：传入 sessionId 时优先该会话的设定，否则为全局默认 */
  getMode(sessionId?: string): ApprovalMode {
    if (sessionId !== undefined) {
      const state = this.sessions.get(sessionId);
      if (state?.mode !== undefined) return state.mode;
    }
    return this.mode;
  }

  /** 设定审批模式：传入 sessionId 时只改该会话，否则改全局默认 */
  setMode(mode: ApprovalMode, sessionId?: string): void {
    if (sessionId !== undefined) {
      const state = this.sessions.get(sessionId);
      if (state) {
        state.mode = mode;
        return;
      }
    }
    this.mode = mode;
  }

  /** 会话建立时登记项目根目录；重复登记会重置该会话的记忆规则 */
  register(sessionId: string, projectRoot: string): void {
    this.sessions.set(sessionId, {
      projectRoot,
      rules: [],
      denyRules: [],
      pending: new Map(),
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
   * 返回 decision 表示立即放行；返回 request 表示需要用户处置。
   */
  evaluate(input: {
    sessionId: string;
    toolCallId: string;
    toolName: string;
    argsJson: string;
    now: number;
    /** worker 上报的等待上限；缺省用兜底值 */
    timeoutMs?: number;
  }): { decision: ApprovalDecision } | { request: ApprovalRequest } {
    const state = this.sessions.get(input.sessionId);
    // 未登记的会话按最保守处理：不认识就放行会让审批形同虚设
    const projectRoot = state?.projectRoot ?? "";

    let args: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(input.argsJson);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      args = {};
    }

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

    const request: ApprovalRequest = {
      toolCallId: input.toolCallId,
      sessionId: input.sessionId,
      toolName: input.toolName,
      argsJson: input.argsJson,
      summary: verdict.summary,
      risk: verdict.risk as ApprovalRisk,
      reason: verdict.reason,
      signature: verdict.signature,
      requestedAt: input.now,
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
    state?.pending.set(input.toolCallId, request);
    return { request };
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
          input.remember === "tool"
            ? { toolName: request.toolName, scope: "tool" }
            : { toolName: request.toolName, scope: "signature", signature: request.signature },
        );
      }
    }

    // 「始终拒绝」：记住拒绝，下次同类调用直接拦下
    if (!input.approved && input.deny) {
      state.denyRules.push(
        input.deny === "tool"
          ? { toolName: request.toolName, scope: "tool" }
          : { toolName: request.toolName, scope: "signature", signature: request.signature },
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

  /** 会话被回收或中断时清空待审，避免界面残留幽灵条目 */
  clearPending(sessionId: string): ApprovalRequest[] {
    const state = this.sessions.get(sessionId);
    if (!state) return [];
    const dropped = [...state.pending.values()];
    state.pending.clear();
    return dropped;
  }
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
