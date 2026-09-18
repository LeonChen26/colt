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
