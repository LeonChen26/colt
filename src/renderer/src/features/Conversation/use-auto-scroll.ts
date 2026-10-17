// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 消息区的自动吸底：新内容到达时滚到底，但**不抢用户正在读的位置**。
 *
 * 两条规则都能在 `index.tsx` 里直接写，抽出来是因为那个文件被
 * `tests/size-guard.test.ts` 的「React 内建 hook 数 ≤ 50」盯着（抽取时正好 50）。
 * 这里多出来的两个内建 hook（useRef + useEffect）不计入那个上限。
 *
 * 为什么不放在 `MessageList.tsx` 的 `MessageWindow` 里：窗口只管「挂多少」，
 * 阻塞卡（审批 / 提问）由 `Conversation` 在窗口**之后**渲染，滚到底要量的是整个
 * 滚动容器，而不是窗口那一段。
 *
 * 规则：
 * - 用户本就停在底部附近（`NEAR_BOTTOM_PX`）→ 跟着新内容走；
 * - 用户正在上翻读历史 → 不动他，除非**出现阻塞卡**（审批 / 提问）：
 *   那是 lane 停在这里等人回话的地方，看不见就等于没提示。
 */
import { useEffect, useRef } from "react";
import { NEAR_BOTTOM_PX } from "@/lib/message-window";

export interface AutoScrollInput {
  /** 待处置的授权卡数量 */
  approvals: number;
  /** 待作答的提问卡数量 */
  questions: number;
  /** 消息条数（流式期间不涨，故也把下面三项带上） */
  messages: number;
  streamingText: string | null | undefined;
  thought: string | null | undefined;
  /** 运行中的工具（引用每次视图推送都会换） */
  runningTools: readonly unknown[] | undefined;
}

export function useAutoScroll(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  input: AutoScrollInput,
): void {
  // 上一次看到的阻塞卡数量：只有**增加**才强制吸底（答复 / 跳过后卡片消失不该触发）
  const seen = useRef({ approvals: 0, questions: 0 });
  const { approvals, questions, messages, streamingText, thought, runningTools } = input;

  useEffect(() => {
    const node = scrollRef.current;
    if (node === null) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    const prev = seen.current;
    seen.current = { approvals, questions };
    const appeared = approvals > prev.approvals || questions > prev.questions;
    if (distance <= NEAR_BOTTOM_PX || appeared) node.scrollTop = node.scrollHeight;
  }, [scrollRef, approvals, questions, messages, streamingText, thought, runningTools]);
}
