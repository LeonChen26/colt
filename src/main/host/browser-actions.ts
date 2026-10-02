// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * `browser_act` 的动作分类：**哪些动作会改变页面**这件事的唯一真源。
 *
 * 独立成纯模块（不碰 electron、不碰宿主状态）有两个理由：
 *   ① 这份名单被三处读——宿主 `handle` 的接管拦截、审批层的前置否决、以及「agent 刚操作过」
 *      的归属标记。三处各写一份，新加一个改页面的动作时必然漏掉一处（表现是「接管时拦不住」
 *      或「状态条永远不亮」）；
 *   ② 纯模块才测得了——宿主与审批两端都牵进 Electron / 数据库，塞在那里就只剩「靠肉眼看」。
 *
 * 分类口径：`wait` 是**只等不改**，不算改动；`viewport` 只改渲染视口、不改页面内容，但它
 * 仍属于「用户在操作时不该被 agent 抢去的动作」，故计入。只读的 browser_read / screenshot
 * 不在这里——它们压根不是 `browser_act` 的动作。
 */

/** agent 操作浏览器的工具名（宿主实现、审批豁免名单里都没有它，故天然过审批闸门） */
export const BROWSER_ACT_TOOL = "browser_act";

/** 会改变页面状态（或抢走操作权）的动作；其余为只读或只等 */
export const MUTATING_BROWSER_ACTIONS: ReadonlySet<string> = new Set([
  "navigate",
  "click",
  "type",
  "key",
  "scroll",
  "viewport",
  "upload",
]);

/**
 * `browser_act` 的入参里**第一个**改动类动作（没有则 undefined）。
 *
 * 单动作看 `action`；动作链看 `actions` 里任一环——返回具体动作名，好让拒绝理由能点名
 * 是哪个动作（如「已拒绝『click』」）。
 */
export function firstMutatingAction(args: Record<string, unknown>): string | undefined {
  if (Array.isArray(args.actions)) {
    for (const item of args.actions) {
      if (item === null || typeof item !== "object") continue;
      const action = String((item as { action?: unknown }).action);
      if (MUTATING_BROWSER_ACTIONS.has(action)) return action;
    }
    return undefined;
  }
  const action = String(args.action);
  return MUTATING_BROWSER_ACTIONS.has(action) ? action : undefined;
}

/**
 * 用户接管期间拒绝改动类动作的理由。
 *
 * 宿主 `handle` 的拦截与审批层的前置否决**共用这一份文案**——两处各写一遍，改一处忘一处
 * 就会出现「同一个拒绝，两种说法」。要同时说清**为什么被拒**与**期间能做什么**：只说
 * 「你不能再操作」，模型会把它当成偶发失败然后反复重试，那是这套机制里最贵的一种错。
 */
export function controlBlockedMessage(action: string): string {
  return (
    `用户已接管浏览器（他在面板上点了「接管」），已拒绝「${action}」：` +
    `此时改动页面会与他正在做的事打架。请等用户点「交还」后再继续，` +
    `期间可以用 browser_read / browser_screenshot 查看页面。`
  );
}

/**
 * 「用户接管期间拒绝改动类 `browser_act`」的完整判据（纯函数）：构成否决就返回理由，
 * 否则 undefined。宿主把它包一层（补上「这个会话是否已接管」的查表）即可。
 *
 * 把决策整段放在纯模块里，而不是散在宿主方法里：它是安全相关的，必须能被单测逐条钉住
 * （工具名对不对、只读动作放不放行、动作链算不算）——宿主牵 Electron，放那儿就只剩肉眼。
 */
export function controlBlockReason(
  controlled: boolean,
  toolName: string,
  args: Record<string, unknown>,
): string | undefined {
  if (!controlled) return undefined;
  if (toolName !== BROWSER_ACT_TOOL) return undefined;
  const action = firstMutatingAction(args);
  return action === undefined ? undefined : controlBlockedMessage(action);
}
