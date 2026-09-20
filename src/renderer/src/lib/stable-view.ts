// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 视图的「稳定投影」：**内容没变就复用上一份的对象**。
 *
 * 为什么需要它：`ConversationView` 是**全量快照**，流式期间每 50ms 整份重推一次
 * （`worker/entry.ts` 的 `scheduleFlush`）。每次都新建 `messages` / `toolResults` /
 * `fileChanges` 三个数组，于是**每个元素都是新对象**——哪怕内容一个字节都没变。
 * 渲染层把这些对象当 props 传下去，React 只能整列表重渲染：实测 370 条消息时
 * 每帧 544ms（约 5fps），而这 370 条里真正变的往往只有 1 条。
 *
 * 这里只做一件事：**逐字段比对**，把没变的换成旧引用。引用稳定之后 `memo` 的
 * 默认浅比较就够了，不必给组件写自定义比较器——自定义比较器的危险在于
 * **漏比一个字段就等于静默不更新**（本仓出过这类翻车）。
 *
 * 判据是**内容**，不是「哪个字段变了」，所以这里必须覆盖契约里的**每一个**字段：
 * 漏掉一个就会表现成「后台数据变了、界面纹丝不动」。`tests/stable-view.test.ts`
 * 用「逐字段扰动」的办法守着这件事——契约新增字段而这里没跟上，那条用例会先红。
 */
import type {
  ViewFileChange,
  ViewMessage,
  ViewRunningTool,
  ViewSubagent,
  ViewToolResult,
} from "@shared/worker-protocol";

/** 图片块：`data` 是 base64、可能很长，但 `===` 先比引用能短路掉绝大多数调用 */
function sameImage(
  a: { data: string; mimeType: string } | undefined,
  b: { data: string; mimeType: string } | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return a.data === b.data && a.mimeType === b.mimeType;
}

/** 消息里的工具调用：按位置逐字段比（顺序本身就是内容的一部分） */
function sameToolCalls(
  a: ViewMessage["toolCalls"],
  b: ViewMessage["toolCalls"],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index]!;
    const right = b[index]!;
    if (
      left.id !== right.id ||
      left.name !== right.name ||
      left.args !== right.args ||
      left.durationMs !== right.durationMs
    ) {
      return false;
    }
  }
  return true;
}

/** 一条消息内容是否等价（可用于「换掉旧引用」） */
export function sameViewMessage(a: ViewMessage, b: ViewMessage): boolean {
  if (a === b) return true;
  return (
    a.id === b.id &&
    a.role === b.role &&
    a.text === b.text &&
    a.thought === b.thought &&
    a.timestamp === b.timestamp &&
    sameImage(a.image, b.image) &&
    sameToolCalls(a.toolCalls, b.toolCalls)
  );
}

/** 一条工具结果内容是否等价（含「图在视图外」这个标记） */
export function sameViewToolResult(a: ViewToolResult, b: ViewToolResult): boolean {
  if (a === b) return true;
  return (
    a.id === b.id &&
    a.output === b.output &&
    a.isError === b.isError &&
    a.hasImage === b.hasImage &&
    sameImage(a.image, b.image)
  );
}

/** 一条文件改动内容是否等价（patch 与净值都要比：它们都会显示出来） */
export function sameViewFileChange(a: ViewFileChange, b: ViewFileChange): boolean {
  if (a === b) return true;
  return (
    a.id === b.id &&
    a.path === b.path &&
    a.kind === b.kind &&
    a.patch === b.patch &&
    a.addedLines === b.addedLines &&
    a.removedLines === b.removedLines &&
    a.timestamp === b.timestamp &&
    a.netAddedLines === b.netAddedLines &&
    a.netRemovedLines === b.netRemovedLines
  );
}

/**
 * 按 `id` 复用旧元素：内容等价（`same` 为真）**且位置一致**时连数组本身都不换。
 *
 * 位置必须一起比：只按 id 认的话，两条消息互换位置会得到一个顺序错误、
 * 却与旧数组等长的结果——那正是「复用」最容易埋进去的错。
 */
export function keepStableById<T extends { id: string }>(
  prev: T[],
  next: T[],
  same: (a: T, b: T) => boolean,
): T[] {
  if (prev === next) return next;
  if (prev.length === 0 && next.length === 0) return prev;
  const before = new Map<string, T>();
  for (const item of prev) before.set(item.id, item);
  const out: T[] = new Array(next.length);
  let stable = prev.length === next.length;
  for (let index = 0; index < next.length; index += 1) {
    const fresh = next[index]!;
    const old = before.get(fresh.id);
    const kept = old !== undefined && same(old, fresh) ? old : fresh;
    out[index] = kept;
    if (kept !== prev[index]) stable = false;
  }
  return stable ? prev : out;
}

/**
 * `toolCallId → 结果` 的查表：内容等价时返回**同一个 Map 引用**。
 * 消息组件拿的是整张表，Map 换了引用就等于所有消息都换了 props——这份稳定是必需的。
 */
export function keepStableResultMap(
  prev: Map<string, ViewToolResult> | undefined,
  next: ViewToolResult[],
): Map<string, ViewToolResult> {
  if (prev !== undefined && prev.size === next.length) {
    let unchanged = true;
    for (const item of next) {
      const old = prev.get(item.id);
      if (old === undefined || !sameViewToolResult(old, item)) {
        unchanged = false;
        break;
      }
    }
    if (unchanged) return prev;
  }
  const map = new Map<string, ViewToolResult>();
  for (const item of next) map.set(item.id, item);
  return map;
}

/** 一条正在跑的工具是否等价（子代理尾部里也会出现它） */
function sameRunningTool(a: ViewRunningTool, b: ViewRunningTool): boolean {
  if (a === b) return true;
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.args === b.args &&
    a.output === b.output &&
    a.fullOutputPath === b.fullOutputPath &&
    a.startedAt === b.startedAt
  );
}

function sameRunningTools(a: ViewRunningTool[], b: ViewRunningTool[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (!sameRunningTool(a[index]!, b[index]!)) return false;
  }
  return true;
}

/**
 * 一个子代理总账是否等价。
 *
 * 尾部与统计都要逐项比：它们**都会显示出来**（④ 卡里的预览与耗时/花费）。
 * 只比 status 的话，运行中的文本流与工具进度就永远刷不出来——界面看着像卡住了。
 */
export function sameViewSubagent(a: ViewSubagent, b: ViewSubagent): boolean {
  if (a === b) return true;
  return (
    a.id === b.id &&
    a.toolCallId === b.toolCallId &&
    a.name === b.name &&
    a.title === b.title &&
    a.status === b.status &&
    a.startedAt === b.startedAt &&
    a.endedAt === b.endedAt &&
    a.error === b.error &&
    a.tail.streamingText === b.tail.streamingText &&
    a.tail.thought === b.tail.thought &&
    a.tail.stepCount === b.tail.stepCount &&
    sameRunningTools(a.tail.runningTools, b.tail.runningTools) &&
    sameViewMessageList(a.tail.recentSteps, b.tail.recentSteps) &&
    a.stats.inputTokens === b.stats.inputTokens &&
    a.stats.outputTokens === b.stats.outputTokens &&
    a.stats.costUsd === b.stats.costUsd
  );
}

/** 一组消息是否逐条等价（顺序也是内容的一部分） */
function sameViewMessageList(a: ViewMessage[], b: ViewMessage[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (!sameViewMessage(a[index]!, b[index]!)) return false;
  }
  return true;
}

/**
 * `toolCallId → 子代理` 的查表（④ 卡靠它把工具调用认成子代理卡）。
 * 与 `keepStableResultMap` 同一套理由：视图每 50ms 重推，Map 换引用等于整列表重渲染。
 */
export function keepStableSubagentMap(
  prev: Map<string, ViewSubagent> | undefined,
  next: ViewSubagent[],
): Map<string, ViewSubagent> {
  if (prev !== undefined && prev.size === next.length) {
    let unchanged = true;
    for (const item of next) {
      const old = prev.get(item.toolCallId);
      if (old === undefined || !sameViewSubagent(old, item)) {
        unchanged = false;
        break;
      }
    }
    if (unchanged) return prev;
  }
  const map = new Map<string, ViewSubagent>();
  for (const item of next) map.set(item.toolCallId, item);
  return map;
}
