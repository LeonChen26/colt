/**
 * `createVisibleInterval`（F11）的测试：页面不可见时暂停的周期定时器。
 *
 * 为什么逐拍代入假环境而不是「读代码觉得对」：这段逻辑的坑全在**时序**上——
 * 「隐藏时来了周期」「恢复时是否补跳」「重复事件会不会叠定时器」，都是定性
 * 判断最容易想当然的地方（同 AGENTS.md §3.3 的教训：代入具体数值跑一遍）。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  createVisibleInterval,
  type IntervalEnvironment,
} from "../src/renderer/src/lib/visible-interval";

/** 假环境：手动控制「时钟走一拍」与「可见性翻转」，并记录定时器数量 */
function fakeEnv(initialHidden = false) {
  let hidden = initialHidden;
  let nextHandle = 0;
  const timers = new Map<number, () => void>();
  const listeners = new Set<() => void>();
  const env: IntervalEnvironment = {
    setInterval: (callback) => {
      const handle = ++nextHandle;
      timers.set(handle, callback);
      return handle;
    },
    clearInterval: (handle) => {
      timers.delete(handle as number);
    },
    isHidden: () => hidden,
    onVisibilityChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    env,
    /** 时钟走一拍：所有存活定时器各跳一次 */
    tick: () => {
      for (const callback of [...timers.values()]) callback();
    },
    /** 翻转可见性并派发事件 */
    setHidden: (value: boolean) => {
      hidden = value;
      for (const listener of [...listeners]) listener();
    },
    timerCount: () => timers.size,
    listenerCount: () => listeners.size,
  };
}

describe("createVisibleInterval", () => {
  test("可见时启动：立即跳一次，之后每拍一跳", () => {
    const { env, tick, timerCount } = fakeEnv(false);
    let calls = 0;
    createVisibleInterval(() => calls++, 1000, env);
    assert.equal(calls, 1, "启动应立即补跳一次（对齐「先 tick 再 setInterval」的旧写法）");
    assert.equal(timerCount(), 1);
    tick();
    tick();
    assert.equal(calls, 3);
  });

  test("隐藏时启动：不跳也不建定时器；转可见时立即补跳并开始走拍", () => {
    const { env, tick, setHidden, timerCount } = fakeEnv(true);
    let calls = 0;
    createVisibleInterval(() => calls++, 1000, env);
    assert.equal(calls, 0);
    assert.equal(timerCount(), 0, "隐藏期间不应持有定时器");
    setHidden(false);
    assert.equal(calls, 1, "恢复可见应立即补跳——隐藏期间状态可能早已变化");
    tick();
    assert.equal(calls, 2);
  });

  test("可见转隐藏：周期停止；再转可见：立即补跳后恢复周期", () => {
    const { env, tick, setHidden, timerCount } = fakeEnv(false);
    let calls = 0;
    createVisibleInterval(() => calls++, 1000, env);
    tick();
    assert.equal(calls, 2);
    setHidden(true);
    assert.equal(timerCount(), 0);
    tick();
    tick();
    assert.equal(calls, 2, "隐藏期间一拍都不许走");
    setHidden(false);
    assert.equal(calls, 3, "恢复时补跳");
    tick();
    assert.equal(calls, 4);
  });

  test("重复可见/隐藏事件不叠定时器（start 幂等）", () => {
    const { env, setHidden, timerCount } = fakeEnv(false);
    createVisibleInterval(() => undefined, 1000, env);
    setHidden(true);
    setHidden(false);
    setHidden(false);
    setHidden(true);
    setHidden(true);
    setHidden(false);
    assert.equal(timerCount(), 1, "任何事件序列下最多一个定时器");
  });

  test("停止后：定时器清掉、事件退订，再翻可见性也无任何效果", () => {
    const { env, tick, setHidden, timerCount, listenerCount } = fakeEnv(false);
    let calls = 0;
    const stop = createVisibleInterval(() => calls++, 1000, env);
    stop();
    assert.equal(timerCount(), 0);
    assert.equal(listenerCount(), 0);
    tick();
    setHidden(true);
    setHidden(false);
    tick();
    assert.equal(calls, 1, "只剩启动那一跳，之后彻底静默");
  });
});
