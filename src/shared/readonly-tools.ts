// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 只读工具白名单：唯一真源。
 *
 * 跨进程两处消费，语义必须完全一致：
 *   - main/approval/policy.ts：名单内的工具**不对用户工作区产生副作用**，直接放行、不进审批队列；
 *   - worker/entry.ts：after_tool 的「未经闸门即执行」安全告警据此豁免——既然 policy
 *     保证它们会被放行，本就不该经过闸门；名单漏项会让这些工具被误报为闸门失效。
 * 两份列表一旦漂移，要么对合法调用刷告警、要么遮蔽真正的漏报。
 *
 * ⚠️ 判据是「**用户工作区**」而不是「不产生任何副作用」：`todo` 也在名单里，它**会写库**
 * （应用自有的 SQLite）。免审批的边界问的是「模型能不能借它在用户的文件里落东西」——
 * 而不是「它有没有落任何东西」。`todo` 的入参里没有任何路径，会话隔离由主进程按
 * `entry.sessionId` 强制，故它不越界（论证见 `docs/SECURITY.md`）。
 */
export const READONLY_TOOLS: ReadonlySet<string> = new Set([
  "read", "grep", "glob", "ls", "list", "search", "todo", "memory_search",
]);
