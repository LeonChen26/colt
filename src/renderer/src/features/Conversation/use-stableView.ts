// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * `ConversationView` → 渲染层直接消费的「稳定投影」（比对规则见 `@/lib/stable-view`）。
 *
 * 为什么要留在自定义 hook 里、不直接写进 `index.tsx`：容器是体量闸的棘轮对象
 * （`tests/size-guard.test.ts`，行数与 React 内建 hook 数都有上限），
 * 而闸文件自己写明「自定义 hook 正是推荐的抽出方式」。
 *
 * 它解决的是**流式重推**：视图每 50ms 整份重推一次，每次都新建数组与元素对象，
 * 于是「内容没变的消息」也拿到新 props、只能重渲染。这里把没变的部分换成旧引用，
 * 让 `MessageBubble` 的 `memo` 真正生效——只有确实变了的那条会重渲染。
 */
import { useRef } from "react";
import type {
  ConversationView,
  ViewFileChange,
  ViewMessage,
  ViewSubagent,
  ViewToolResult,
} from "@shared/worker-protocol";
import {
  keepStableById,
  keepStableResultMap,
  keepStableSubagentMap,
  sameViewFileChange,
  sameViewMessage,
} from "@/lib/stable-view";

export type StableView = {
  /** 内容没变的消息**保持同一个对象引用**——`MessageBubble` 的 `memo` 靠它生效 */
  messages: ViewMessage[];
  /** `toolCallId → 结果`；引用稳定同样是为了让消息组件不被无谓地重渲染 */
  resultMap: Map<string, ViewToolResult>;
  changes: ViewFileChange[];
  /** `toolCallId → 子代理`：④ 卡据此认出「这次工具调用是个子代理」 */
  subagents: Map<string, ViewSubagent>;
};

/**
 * 每次渲染都算一遍（不做 `useMemo`）：投影函数本身在「内容没变」时**返回旧引用**，
 * 所以重复计算只花几次字符串比较，换来的是「无论什么原因触发的重渲染都不会破坏引用稳定」。
 */
export function useStableView(view: ConversationView | null): StableView {
  const previous = useRef<StableView | null>(null);
  const last = previous.current;
  const next: StableView = {
    messages: keepStableById(last?.messages ?? [], view?.messages ?? [], sameViewMessage),
    resultMap: keepStableResultMap(last?.resultMap, view?.toolResults ?? []),
    changes: keepStableById(last?.changes ?? [], view?.fileChanges ?? [], sameViewFileChange),
    subagents: keepStableSubagentMap(last?.subagents, view?.subagents ?? []),
  };
  previous.current = next;
  return next;
}
