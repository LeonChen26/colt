/**
 * 只读工具白名单：唯一真源。
 *
 * 跨进程两处消费，语义必须完全一致：
 *   - main/approval/policy.ts：名单内的工具不产生副作用，直接放行、不进审批队列；
 *   - worker/entry.ts：after_tool 的「未经闸门即执行」安全告警据此豁免——既然 policy
 *     保证它们会被放行，本就不该经过闸门；名单漏项会让这些工具被误报为闸门失效。
 * 两份列表一旦漂移，要么对合法调用刷告警、要么遮蔽真正的漏报。
 */
export const READONLY_TOOLS: ReadonlySet<string> = new Set([
  "read", "grep", "glob", "ls", "list", "search", "todo",
]);
