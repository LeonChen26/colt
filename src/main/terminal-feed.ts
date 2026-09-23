// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 终端输出流的两个纯算法（terminal-host 用，tests/terminal-feed.test.ts 直接覆盖）：
 *
 * 1. **合帧后的推进**（`advanceFeed`）：一次 flush = 帧号 +1、输出合入回放缓冲并
 *    截头。抽成纯函数是因为「截到多少、帧号怎么走」是数据不变量，不该散在定时器
 *    回调里无人验证。
 * 2. **渲染层的 seq 过滤**（`shouldAcceptFrame`）：先订阅事件再 invoke open 的窗口
 *    里，旧帧会先到——`seq < nextSeq` 的内容已在 replay 里，丢弃不丢数据。
 */

/** 回放缓冲上限（字符数）。UTF-16 code unit 计，量级即字节级，够用 */
export const REPLAY_LIMIT = 64 * 1024;

/** 合帧间隔：一帧 60fps 的时间，肉眼无感又把几十段 chunk 收敛成一次 send */
export const FLUSH_MS = 16;

export interface FeedState {
  /** 回放缓冲（含已 flush 的全部输出，头部超限截断） */
  buffer: string;
  /** 已发出的最后一帧序号；下一帧是 seq + 1 */
  seq: number;
}

/**
 * 一次 flush 的状态推进。调用方已确认 `data !== ""`（空数据不该 flush）。
 * 返回新状态与新帧（帧号 = 新 seq，渲染层按它过滤）。
 */
export function advanceFeed(state: FeedState, data: string): FeedState & {
  frame: { data: string; seq: number };
} {
  const seq = state.seq + 1;
  const merged = state.buffer + data;
  return {
    buffer: merged.length > REPLAY_LIMIT ? merged.slice(-REPLAY_LIMIT) : merged,
    seq,
    frame: { data, seq },
  };
}

/** 渲染层收到一帧时的过滤判定：旧帧（内容已在 replay 里）丢弃，新帧接收 */
export function shouldAcceptFrame(seq: number, nextSeq: number): boolean {
  return seq >= nextSeq;
}
