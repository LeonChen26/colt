// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 跨进程共享的**上限与阈值**。
 *
 * 能进这个文件的只有一类值：**两侧不同值就会静默出错**的那些。
 *
 * 这类值的共同点是「main 与 worker 各读一次，谁也不校验对方」——漂成两份时
 * 症状**不是报错**，而是挂在半路：
 *
 * - `APPROVAL_TIMEOUT_MS`：主进程按它自动拒绝、worker 按它解除阻塞。
 *   若 main 更短，worker 还在等一个已经被判死的答复；若 worker 更短，用户看到的
 *   倒计时还在走、链路其实已经放弃了。两种都是「界面停住，没有任何失败信号」。
 * - `SNIFF_BYTES`：预览（`main/file-read.ts`）与净值基线（`worker/lib/baseline.ts`）
 *   各判一次「是不是二进制」。判据不同 → 同一个文件一边算得出净值、一边说「二进制」。
 *
 * 所以它们**只允许在这里定义一次**，别处一律 import——不要图省事再写一份字面量。
 * 「没人再写死第二份」由 `tests/limits.test.ts` 守卫。
 *
 * 只放常量，不 import 任何东西（本层是纯契约层，见 `docs/ARCHITECTURE.md` §三）。
 * 仅 main / worker 本地使用的上限（如各类文件体积上限）不必进这里，留在原处即可。
 */

/** 审批等待上限：超时视为拒绝，避免 lane 永久挂起 */
export const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

/** 二进制判定的嗅探字节数：只扫头部，不必为判定读完整文件 */
export const SNIFF_BYTES = 8000;

/**
 * MCP 的**单步**超时：worker 侧「连一台 server」与「列它的工具」各算一步。
 *
 * 进这个文件的理由与上面两条同源，但症状是**假失败**（本文件头说的那类静默出错）：
 * worker 拿它当 `connect` / `listTools` 的超时（`worker/lib/mcp-tools.ts`），主进程拿它
 * 算「等 MCP 回话」的预算（`main/session-manager.ts` 的 `MCP_QUERY_TIMEOUT_MS`）。
 * 主进程那边只要比 worker 短，设置页就会弹「查询 MCP 状态超时」——而 worker 正在
 * 正常连接，用户看到的失败是编出来的。
 */
export const MCP_STEP_TIMEOUT_MS = 15_000;

/**
 * MCP **首次装载**（会话冷启动）的启动预算：连全部 server 最多等这么久，
 * 超时的那些**转后台**——连上后自动补挂进 harness，会话照常就绪、照常可用。
 *
 * 进这个文件的理由与上一条同源，症状同样是**假失败**：它与主进程的 `READY_TIMEOUT_MS`
 * （`main/session-manager.ts`，等 worker 报 ready 的上限）是一对——预算必须显著小于它，
 * 否则 worker 还在连、主进程已经判超时，用户看到的又是「会话进程启动超时，请重试」，
 * 而真实原因（某台 server 连不上）根本没机会报出来。
 *
 * 只约束 worker 侧的**首次装载**（`worker/lib/mcp-tools.ts`）。设置页「重新加载」
 * 由用户显式触发、按钮在等待期间禁用，点按钮就是要等到结果，不适用预算。
 *
 * 主进程那边读它做同一条预算的说明（见 `session-manager.ts` 的 `READY_TIMEOUT_MS` 注释）。
 */
export const MCP_STARTUP_BUDGET_MS = 15_000;
