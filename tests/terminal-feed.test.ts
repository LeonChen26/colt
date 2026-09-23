/**
 * 终端输出流的纯算法测试（terminal-feed.ts）：合帧推进与 seq 过滤。
 *
 * 这两个不变量为什么值得单测：seq 错一位 = 渲染层丢一帧或重放一帧（用户看到
 * 的是「终端吃字」或「字符重复」）；缓冲截错头 = 回放缺开头。都不该等冒烟
 * 里肉眼抓——冒烟只验「链路通」，数据不变量在这里钉死。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  advanceFeed,
  FLUSH_MS,
  REPLAY_LIMIT,
  shouldAcceptFrame,
} from "../src/main/terminal-feed.ts";

describe("advanceFeed（合帧推进）", () => {
  test("首帧从 0 起号，缓冲即内容", () => {
    const next = advanceFeed({ buffer: "", seq: -1 }, "hello");
    assert.equal(next.seq, 0);
    assert.equal(next.frame.seq, 0);
    assert.equal(next.frame.data, "hello");
    assert.equal(next.buffer, "hello");
  });

  test("帧号单调递增，缓冲顺序合入", () => {
    let state = { buffer: "", seq: -1 };
    state = advanceFeed(state, "a");
    state = advanceFeed(state, "b");
    assert.equal(state.seq, 1);
    assert.equal(state.buffer, "ab");
  });

  test("缓冲超限截头保尾（环形语义：回放总是最近的 64KB）", () => {
    const head = "x".repeat(REPLAY_LIMIT - 10);
    const next = advanceFeed({ buffer: head, seq: 0 }, "0123456789ABCDEF");
    assert.equal(next.buffer.length, REPLAY_LIMIT);
    assert.ok(next.buffer.endsWith("0123456789ABCDEF"));
    // 总量超限 6 个字符，头部 6 个 x 被截掉：剩下的 x 正好补满到尾串之前
    const tail = next.buffer.slice(0, next.buffer.length - 16);
    assert.equal(tail, "x".repeat(REPLAY_LIMIT - 16));
  });

  test("恰好等于上限不截（多一个字符才截）", () => {
    const exact = "y".repeat(REPLAY_LIMIT);
    const next = advanceFeed({ buffer: "", seq: -1 }, exact);
    assert.equal(next.buffer.length, REPLAY_LIMIT);
    assert.equal(next.buffer, exact);
  });
});

describe("shouldAcceptFrame（渲染层 seq 过滤）", () => {
  test("等于水位收（open 返回的 nextSeq 本身就是第一帧）", () => {
    assert.equal(shouldAcceptFrame(3, 3), true);
  });

  test("大于水位收，并成为新水位（调用方推进）", () => {
    assert.equal(shouldAcceptFrame(5, 3), true);
  });

  test("小于水位丢（内容已在 replay 里，丢了不丢数据）", () => {
    assert.equal(shouldAcceptFrame(2, 3), false);
  });

  test("水位为 Infinity 时全丢（open 返回前的过渡态）", () => {
    assert.equal(shouldAcceptFrame(0, Number.POSITIVE_INFINITY), false);
    assert.equal(shouldAcceptFrame(Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY), false);
  });
});

describe("常量", () => {
  test("合帧间隔 16ms（一帧 60fps：再长肉眼可见迟滞，再短合不动）", () => {
    assert.equal(FLUSH_MS, 16);
  });

  test("回放上限 64KB（够滚回看，不至于把会话输出无限攒在内存）", () => {
    assert.equal(REPLAY_LIMIT, 64 * 1024);
  });
});
