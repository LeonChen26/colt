// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * worker 池的两条**纯**决策：该空闲回收谁、池满时淘汰谁。
 *
 * 为什么抽出来：回收器是「60 秒一跳、超时 30 分钟」，冒烟里根本等不到——
 * 于是「钉住到底拦不拦得住」这件事**没法用冒烟验**。把它从「读时钟 + 改进程池」
 * 里剥成纯函数，「钉住的不回收 / 全钉住时最后才淘汰」就能被普通单测钉死。
 *
 * 依赖注入 `isPinned` 而不是 import 具体实现：这两条规则不该知道钉住是存在内存还是库里。
 */

export interface PoolEntry {
  sessionId: string;
  running: boolean;
  lastActiveAt: number;
}

/** 该回收的：**未运行**、**未被钉住**、且空闲超过 `idleTimeoutMs`。三条缺一不可 */
export function reapTargets(
  entries: readonly PoolEntry[],
  now: number,
  idleTimeoutMs: number,
  isPinned: (sessionId: string) => boolean,
): string[] {
  return entries
    .filter((entry) => !entry.running && !isPinned(entry.sessionId) && now - entry.lastActiveAt > idleTimeoutMs)
    .map((entry) => entry.sessionId);
}

/**
 * 池满时淘汰谁：只在**未运行**的里挑（正在跑的不能动）。
 *
 * 排序键是「先没钉住、后钉住」，组内再按最久未活动——所以钉住的**最后**才被淘汰。
 * 是「最后」而不是「绝不」：真把 6 条全钉住，还是得让出一条，否则新会话永远开不出来，
 * 那就成了一个没有出口的死锁。全都未运行且全被钉住时，返回的就是其中最早活动的那个。
 * 一条空闲的都没有（全在跑）则返回 `undefined`，由调用方如实报「并发已达上限」。
 */
export function evictionVictim(
  entries: readonly PoolEntry[],
  isPinned: (sessionId: string) => boolean,
): string | undefined {
  const idle = entries.filter((entry) => !entry.running);
  if (idle.length === 0) return undefined;
  return [...idle].sort(
    (a, b) =>
      Number(isPinned(a.sessionId)) - Number(isPinned(b.sessionId)) || a.lastActiveAt - b.lastActiveAt,
  )[0]!.sessionId;
}
