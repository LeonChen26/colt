// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 把消息流切成「轮」：一轮 = 一条用户消息 + 随后的助手消息。
 * 轮里**最后一条**助手消息是**最终回复**，其余的助手消息是**过程**（思考与工具调用）。
 *
 * 为什么要它：回看历史时真正要看的是**问答**，而过程是高频的——一轮十几个工具调用，
 * 每个调用一张卡各占一整行（`UI-REGIONS.md` 规则 ④-C：卡片不可省略、不可简化成一行纯文本）。
 * 把一轮的过程收成一行、点开再展开，问答才读得出来。规则 ④-A「信息密度必须可调」讲的就是
 * 这件事，此前只做到「逐卡折叠」，缺的是**整轮**这一档。
 *
 * 只做算术、不知道 React（与 `message-window.ts` 同）：把边界（会话首条不是用户消息、
 * 一轮里没有助手消息、连着两条用户消息）从组件里挖出来，才能被单测逐条钉死。
 */
import type { ViewMessage } from "@shared/worker-protocol";

export type TurnGroup = {
  /** 这一轮的键：取轮内第一条消息的 id（用户消息优先）。供 React key 与「已展开」记录用 */
  key: string;
  /** 起始用户消息；会话以助手消息开头的那一段没有用户消息，为 null */
  user: ViewMessage | null;
  /**
   * 压缩卡：压缩条目自成一张卡（正文是摘要、不是任何人说的话）。内核把压缩后的
   * transcript 替换成「压缩条目 + 尾部保留」，它天然是压缩后历史的**起点**——
   * 尾部保留消息跟着归进这一轮，正好贴在压缩点之后。
   */
  compaction: ViewMessage | null;
  /** 过程：轮内除最终回复外的助手消息 */
  steps: ViewMessage[];
  /** 最终回复：轮内**最后一条**助手消息；该轮没有助手消息时为 null */
  final: ViewMessage | null;
};

/**
 * 按时间顺序切轮。
 *
 * `user` 开新轮；`assistant` 归入当前轮并**顶替**上一条的「最终回复」身份
 * （被顶替的那条降级为过程）——「最后一条才是最终回复」正是靠这一句维持的。
 * 压缩条目（带 `compaction` 标记的 `other`）也开新轮：它不成「问答」，但必须
 * 随窗口翻页被挂载/卸载——不进轮结构的话它永远渲染不出来（窗口是按轮切的）。
 * 其它 `other` 不参与：它们本来就不成条（`MessageBubble` 直接返回 null），
 * 收进来只会让「轮」的定义多一个无意义的例外。
 */
export function groupTurns(messages: ViewMessage[]): TurnGroup[] {
  const turns: TurnGroup[] = [];
  let current: TurnGroup | null = null;

  const open = (key: string): TurnGroup => {
    const turn: TurnGroup = { key, user: null, compaction: null, steps: [], final: null };
    turns.push(turn);
    return turn;
  };

  for (const message of messages) {
    if (message.role === "user") {
      current = open(message.id);
      current.user = message;
      continue;
    }
    if (message.compaction !== undefined) {
      current = open(message.id);
      current.compaction = message;
      continue;
    }
    if (message.role !== "assistant") continue;
    // 会话直接以助手消息开头时也要成轮，否则这些消息会被整段丢掉
    if (current === null) current = open(message.id);
    if (current.final !== null) current.steps.push(current.final);
    current.final = message;
  }

  return turns;
}

/**
 * 消息下标 → 轮下标。
 *
 * **只服务一件事**：折叠开关切换的是「窗口按什么数」（`message-window.ts` 的 `FOLD_CHUNK`），
 * 换单位时用户当前的位置必须换算过去——不换算就等于「切一下人就换了地方」。
 *
 * 归轮规则必须与 `groupTurns` **逐条对齐**（`user` 开新轮、压缩条目开新轮、`assistant`
 * 归当前轮、其余 `other` 不参与成轮），否则两个函数口中的「第几轮」会不一样，
 * 换算出来的位置就是错的。下标落在不成轮的结构性消息上时，
 * 按它**所在**的那一轮算；越界（负数、超过末尾）时钳到最近的轮——目录与搜索都给不出越界下标，
 * 这里只是不让越界悄悄传下去。
 */
export function turnOfMessage(messages: ViewMessage[], index: number): number {
  let turn = -1;
  const last = Math.min(index, messages.length - 1);
  for (let i = 0; i <= last; i += 1) {
    const role = messages[i]!.role;
    if (role === "user") turn += 1;
    else if (role === "other" && messages[i]!.compaction !== undefined) turn += 1;
    else if (role === "assistant" && turn < 0) turn = 0;
  }
  return Math.max(0, turn);
}

/** 折叠那一行藏起来了什么 */
export type StepSummary = {
  /** 藏起来的工具调用次数（**按调用数**算，不是按消息数：一轮里一张卡可能带好几个调用） */
  toolCount: number;
  /** 藏起来的、带思考的步骤数 */
  thoughtCount: number;
};

/** 只统计**确实被藏起来**的东西：最终回复自己的思考与工具调用不在此列 */
export function summarizeSteps(steps: ViewMessage[]): StepSummary {
  let toolCount = 0;
  let thoughtCount = 0;
  for (const step of steps) {
    toolCount += step.toolCalls.length;
    if (step.thought) thoughtCount += 1;
  }
  return { toolCount, thoughtCount };
}

/**
 * 折叠那一行上写什么。
 * **只报确实藏起来的**，没有的不提——不写「0 个工具调用」，那是在数一个不存在的东西。
 */
export function describeSteps(summary: StepSummary): string {
  const parts: string[] = [];
  if (summary.thoughtCount > 0) parts.push("已思考");
  if (summary.toolCount > 0) parts.push(`${summary.toolCount} 个工具调用`);
  return parts.length > 0 ? parts.join(" · ") : "过程";
}
