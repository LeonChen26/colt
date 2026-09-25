// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 子代理**到点之后的收尾时序**：到上限不立刻杀，先要一份「总结交接」。
 *
 * 为什么不直接 abort：子代理跑了半小时，它 transcript 里的结论是这次委派**唯一**的产物——
 * 直接中止会把整段上下文一起丢掉，调用方只拿到一句「已中止、结果不完整」，
 * 而这半小时就白跑了。让它自己收笔写一版交接，代价是一次很短的回答，
 * 换来的是「接着干的人有路可走」。
 *
 * 三段时间，每一段都是「等不到就往下走」：
 *   ① `maxMs`    正常工作的墙钟上限（30 分钟）——到点只**要交接**，不动手杀；
 *   ② `windowMs` 收笔窗口——它在这段时间里写完交接；写完了，run 就正常结算；
 *   ③ `graceMs`  还写不出来就硬中止；而 abort **不保证立刻生效**（内核可能正卡在一个
 *                不可中断的 await 上），再等一程才彻底放弃，把并发额度还回去。
 *
 * 为什么抽成独立模块：这三段的时序是**最容易写错、又最难验**的一段——30 分钟的墙钟
 * 不可能在冒烟里等。注入定时器之后，单测能逐拍验：到 0.5 倍上限时什么都不该发生、
 * 到上限**只 steer 不 abort**、窗口过了才 abort、`cancel()` 之后彻底安静
 * （范式同 `renderer/src/lib/visible-interval.ts`）。
 */

/**
 * 单个子代理的墙钟上限。
 *
 * 30 分钟（2026-09 由 10 分钟上调）：一个「读十几个文件 + 跑几轮测试」的调研任务
 * 在 10 分钟里常被砍在半路，而 cut 掉的那次连结论都拿不到。上限的真正作用是
 * **兜住跑飞的那一路**（额度只有 3 个），不是压着它快点干完。
 */
export const MAX_SUBAGENT_MS = 30 * 60 * 1000;

/**
 * 到点之后留给它**写交接**的窗口。
 *
 * 2 分钟：一份交接就是一屏文字，正常十几秒写完；窗口太长则「到点」这个信号失去意义
 * （等它慢慢磨，等于上限变成了 32 分钟）。窗口内写完的 run **正常结算**，
 * 只是结果文本会说明「这是交接、任务不一定做完」。
 */
export const HANDOFF_WINDOW_MS = 2 * 60 * 1000;

/**
 * 收笔窗口也过了、硬中止之后**还会等多久**。30s：够一次网络往返或一次工具的收尾，
 * 又不至于让「卡死的额度」占太久——额度是 3 个。
 */
export const GRACE_AFTER_ABORT_MS = 30 * 1000;

/**
 * 到点后 steer 给子代理的那句话（生成器，便于单测核对要素）。
 *
 * 四条要求都不能少：**停止新动作**（否则它继续探索，交接写不完）、
 * **说清依据**（接手的人要能复核）、**如实报没做完的部分**（这才是交接的价值所在）、
 * **直接输出**（不要又去读文件确认一遍）。
 */
export function handoffInstruction(): string {
  return [
    "【时间上限】本次委派已到墙钟上限。",
    "",
    "请**立刻停止新的探索与工具调用**，用你手上已有的信息写一份**总结交接**，包含四段：",
    "1. 已经确认的结论与依据（文件、行号、命令、链接——接手的人要能照着复核）；",
    "2. 已经做过的改动，以及它们现在的状态（改到哪一步、有没有半成品）；",
    "3. 没做完的部分、卡在哪里、为什么；",
    "4. 接手的人下一步具体该做什么。",
    "",
    "不要再调用任何工具，直接输出这份交接——它就是这次委派的交付物。",
  ].join("\n");
}

export interface HandoffHooks {
  /** 到上限：**只**要交接（实现方负责 steer 那句指令），不要在这里动手杀 */
  onHandoff: () => void;
  /** 收笔窗口也过了：硬中止 */
  onAbort: () => void;
  /** 中止之后仍不返回：停止等待（额度还回去，lane 交给会话自己收） */
  onGiveUp: () => void;
}

/** 定时器抽象（生产传真实 `setTimeout`；单测传假时钟，逐拍推进） */
export interface HandoffEnv {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

/** 三段时间的可覆盖值：生产不传，取上面三个常量；测试与冒烟用小值把时序压进秒级 */
export interface HandoffLimits {
  maxMs?: number;
  windowMs?: number;
  graceMs?: number;
}

export interface HandoffHandle {
  /** 是否已要求它写交接（到过上限） */
  handoffRequested: () => boolean;
  /** 是否已硬中止 */
  timedOut: () => boolean;
  /** run 正常结束了：撤掉所有在等的定时器 */
  cancel: () => void;
}

/** 按「上限 → 收笔窗口 → 硬中止 → 停止等待」布置定时器 */
export function createHandoffTimer(
  hooks: HandoffHooks,
  limits: HandoffLimits,
  env: HandoffEnv,
): HandoffHandle {
  const maxMs = limits.maxMs ?? MAX_SUBAGENT_MS;
  const windowMs = limits.windowMs ?? HANDOFF_WINDOW_MS;
  const graceMs = limits.graceMs ?? GRACE_AFTER_ABORT_MS;

  let handedOff = false;
  let timedOut = false;
  let cancelled = false;
  let windowTimer: unknown;
  let graceTimer: unknown;

  const maxTimer = env.setTimeout(() => {
    if (cancelled) return;
    handedOff = true;
    hooks.onHandoff();
    windowTimer = env.setTimeout(() => {
      if (cancelled) return;
      timedOut = true;
      hooks.onAbort();
      graceTimer = env.setTimeout(() => {
        if (cancelled) return;
        hooks.onGiveUp();
      }, graceMs);
    }, windowMs);
  }, maxMs);

  return {
    handoffRequested: () => handedOff,
    timedOut: () => timedOut,
    cancel: () => {
      cancelled = true;
      env.clearTimeout(maxTimer);
      env.clearTimeout(windowTimer);
      env.clearTimeout(graceTimer);
    },
  };
}
