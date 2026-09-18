// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 阻塞态队列：审批（`approval`）与提问（`ask_user`）的订阅与处置。
 *
 * 两者是**同一个交互形态的两个实例**——lane 正阻塞在这里等人回话，不处理就不会往下走：
 *   - 审批：等人给许可（默认值「放行」，所以主进程那边有策略在兜底）
 *   - 提问：等人给信息（默认值「没答案」，**不受审批策略管辖**——走审批会被静默批准成「已通过」）
 *
 * 从 `Conversation/index.tsx` 抽出来：那个文件有体量闸与「React 内建 hook 数不许涨」两道守卫，
 * 而自定义 hook 正是它鼓励的抽出方式。这里只管「订阅 → 状态 → 处置」，渲染仍留在会话视图里。
 *
 * 落定后卡片立即消失（审批也是这样）：答案与跳过说明都由随后的工具结果承载，
 * 不在这里留一张「已完成」的卡——那种卡片的寿命没有定义，只会变成过期的悬空块。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApprovalRequest, UserQuestionRequest } from "@shared/protocol";

export interface ApprovalResolution {
  approved: boolean;
  remember?: "signature" | "tool";
  deny?: "signature" | "tool";
}

export interface BlockingCards {
  approvals: ApprovalRequest[];
  questions: UserQuestionRequest[];
  /** 主动重拉两个队列（会话 open 之后调用：那时可能已有堆积的待处理项） */
  refresh: () => Promise<void>;
  resolveApproval: (toolCallId: string, input: ApprovalResolution) => Promise<void>;
  answerQuestion: (toolCallId: string, answers: Record<string, string>) => Promise<void>;
  skipQuestion: (toolCallId: string) => Promise<void>;
}

/** `onError` 由调用方给（它持有错误条的展示权），本模块不自己弹任何东西 */
export function useBlockingCards(sessionId: string, onError: (message: string) => void): BlockingCards {
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [questions, setQuestions] = useState<UserQuestionRequest[]>([]);
  // 会话切走后到达的答复/拉取结果一律丢弃：否则会把上一个会话的待办画到新会话里
  const currentSession = useRef(sessionId);
  currentSession.current = sessionId;

  useEffect(() => {
    let disposed = false;
    // 换会话即清空：旧会话的待办对新会话没有意义（主进程会随后推全量覆盖）
    setApprovals([]);
    setQuestions([]);
    const offApproval = window.colt.on("approval.pending", (payload) => {
      if (disposed || payload.sessionId !== sessionId) return;
      setApprovals(payload.requests);
    });
    const offQuestion = window.colt.on("userquestion.pending", (payload) => {
      if (disposed || payload.sessionId !== sessionId) return;
      setQuestions(payload.requests);
    });
    return () => {
      disposed = true;
      offApproval();
      offQuestion();
    };
  }, [sessionId]);

  const refresh = useCallback(async () => {
    const target = sessionId;
    const [pending, ask] = await Promise.all([
      window.colt.invoke("approval.list", { sessionId: target }),
      window.colt.invoke("userquestion.list", { sessionId: target }),
    ]);
    if (currentSession.current !== target) return;
    setApprovals(pending);
    setQuestions(ask);
  }, [sessionId]);

  const resolveApproval = useCallback(
    async (toolCallId: string, input: ApprovalResolution) => {
      // 乐观移除：主进程随后会推全量待审覆盖
      setApprovals((list) => list.filter((item) => item.toolCallId !== toolCallId));
      try {
        await window.colt.invoke("approval.resolve", {
          sessionId,
          toolCallId,
          approved: input.approved,
          remember: input.remember,
          deny: input.deny,
        });
      } catch (e) {
        onError(e instanceof Error ? e.message : String(e));
      }
    },
    [sessionId, onError],
  );

  const answerQuestion = useCallback(
    async (toolCallId: string, answers: Record<string, string>) => {
      setQuestions((list) => list.filter((item) => item.toolCallId !== toolCallId));
      try {
        await window.colt.invoke("userquestion.answer", { sessionId, toolCallId, answers });
      } catch (e) {
        onError(e instanceof Error ? e.message : String(e));
      }
    },
    [sessionId, onError],
  );

  const skipQuestion = useCallback(
    async (toolCallId: string) => {
      setQuestions((list) => list.filter((item) => item.toolCallId !== toolCallId));
      try {
        await window.colt.invoke("userquestion.skip", { sessionId, toolCallId });
      } catch (e) {
        onError(e instanceof Error ? e.message : String(e));
      }
    },
    [sessionId, onError],
  );

  return { approvals, questions, refresh, resolveApproval, answerQuestion, skipQuestion };
}
