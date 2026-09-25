/**
 * 子代理**收尾时序**的测试（`src/worker/lib/subagent-handoff.ts`）。
 *
 * 这条时序有一件特别值得钉住的事：**到上限不是「杀」，而是「先要一份交接」**。
 * 直接 abort 会把跑了半小时的上下文一起丢掉，调用方只拿到一句「结果不完整」；
 * 先 steer 一句话让它收笔，才让那半小时不完全白费。
 *
 * 用假时钟逐拍推进（30 分钟的墙钟不可能真等），验三件事：
 *   ① 到点**只**要交接、不动手杀；② 收笔窗口过了才中止，中止后仍不返回才停止等待；
 *   ③ run 正常收尾（`cancel`）之后三段定时器全部安静——包括「窗口内写完」这条路径。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  GRACE_AFTER_ABORT_MS,
  HANDOFF_WINDOW_MS,
  MAX_SUBAGENT_MS,
  createHandoffTimer,
  handoffInstruction,
  type HandoffEnv,
} from "../src/worker/lib/subagent-handoff.ts";

/** 假时钟：只跑注入进来的定时器，`advance` 按到期顺序逐拍推进 */
function fakeClock(): { env: HandoffEnv; advance: (ms: number) => void } {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    env: {
      setTimeout: (callback, ms) => {
        const id = nextId;
        nextId += 1;
        timers.set(id, { at: now + ms, callback });
        return id;
      },
      clearTimeout: (handle) => {
        timers.delete(handle as number);
      },
    },
    advance: (ms) => {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        const [id, timer] = due;
        timers.delete(id); // 一次性：先摘掉再回调，回调里注册的新定时器才不会被这轮重复触发
        now = timer.at;
        timer.callback();
      }
      now = target;
    },
  };
}

function recorder(): { log: string[]; hooks: Parameters<typeof createHandoffTimer>[0] } {
  const log: string[] = [];
  return {
    log,
    hooks: {
      onHandoff: () => log.push("handoff"),
      onAbort: () => log.push("abort"),
      onGiveUp: () => log.push("giveUp"),
    },
  };
}

const LIMITS = { maxMs: 1000, windowMs: 200, graceMs: 100 };

describe("子代理收尾时序（到上限先要交接，再收笔，最后才中止）", () => {
  test("常量：上限 30 分钟 / 收笔窗口 2 分钟 / 中止后宽限 30 秒", () => {
    assert.equal(MAX_SUBAGENT_MS, 30 * 60 * 1000, "2026-09 由 10 分钟上调到 30 分钟");
    assert.equal(HANDOFF_WINDOW_MS, 2 * 60 * 1000);
    assert.equal(GRACE_AFTER_ABORT_MS, 30 * 1000);
  });

  test("交接指令把四件事都说到（停止新动作 / 依据 / 没做完的 / 直接输出）", () => {
    const text = handoffInstruction();
    assert.match(text, /停止新的探索与工具调用/);
    assert.match(text, /依据/);
    assert.match(text, /没做完的部分/);
    assert.match(text, /不要再调用任何工具/);
  });

  test("到上限：只**要交接**，不动手杀", () => {
    const clock = fakeClock();
    const { log, hooks } = recorder();
    const handle = createHandoffTimer(hooks, LIMITS, clock.env);

    clock.advance(LIMITS.maxMs - 1);
    assert.deepEqual(log, [], "还没到点，什么都不该发生");
    assert.equal(handle.handoffRequested(), false);

    clock.advance(1);
    assert.deepEqual(log, ["handoff"], "到点只要交接，不能顺手 abort");
    assert.equal(handle.handoffRequested(), true);
    assert.equal(handle.timedOut(), false);
    handle.cancel();
  });

  test("收笔窗口过了才中止，中止后仍不返回才停止等待", () => {
    const clock = fakeClock();
    const { log, hooks } = recorder();
    const handle = createHandoffTimer(hooks, LIMITS, clock.env);

    clock.advance(LIMITS.maxMs);
    assert.deepEqual(log, ["handoff"]);
    clock.advance(LIMITS.windowMs - 1);
    assert.deepEqual(log, ["handoff"], "还在收笔窗口里，不许中止");
    clock.advance(1);
    assert.deepEqual(log, ["handoff", "abort"]);
    assert.equal(handle.timedOut(), true);
    clock.advance(LIMITS.graceMs);
    assert.deepEqual(log, ["handoff", "abort", "giveUp"]);
    handle.cancel();
  });

  test("它在收笔窗口内写完了（run 正常结算）→ cancel 之后不会再中止", () => {
    const clock = fakeClock();
    const { log, hooks } = recorder();
    const handle = createHandoffTimer(hooks, LIMITS, clock.env);

    clock.advance(LIMITS.maxMs); // 到点，要了交接
    clock.advance(50); // 它写完交接，run 结算 → 调用方 cancel
    handle.cancel();
    clock.advance(10_000);
    assert.deepEqual(log, ["handoff"], "写完了就不该再 abort");
    assert.equal(handle.handoffRequested(), true);
    assert.equal(handle.timedOut(), false);
  });

  test("没到点就正常结束 → 三段定时器全程安静", () => {
    const clock = fakeClock();
    const { log, hooks } = recorder();
    const handle = createHandoffTimer(hooks, LIMITS, clock.env);

    clock.advance(LIMITS.maxMs - 100);
    handle.cancel();
    clock.advance(10_000);
    assert.deepEqual(log, []);
    assert.equal(handle.handoffRequested(), false);
    assert.equal(handle.timedOut(), false);
  });

  test("不传 limits 时用生产常量（30 分钟到点才要交接）", () => {
    const clock = fakeClock();
    const { log, hooks } = recorder();
    const handle = createHandoffTimer(hooks, {}, clock.env);

    clock.advance(10 * 60 * 1000);
    assert.deepEqual(log, [], "10 分钟不该再触发任何事（旧上限已废除）");
    clock.advance(20 * 60 * 1000);
    assert.deepEqual(log, ["handoff"]);
    handle.cancel();
  });
});
