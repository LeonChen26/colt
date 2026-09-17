/**
 * 右栏宽度计算的测试（`src/renderer/src/lib/dock.ts`）。
 *
 * 这一段数学是本仓库 `AGENTS.md` §3.3 记下的**真实翻车点**：拖拽时「取负」取错了对象
 * （`const px = -raw`，而 `raw` 里混着 `startWidth`），结果被钳到下限、拖拽看起来毫无反应。
 * 当时的铁律是「涉及坐标/位移的计算，必须拿具体数值代入跑一遍」——但这段数学当年困在
 * 组件内的 `useCallback` 里，`tests/` 零引用，**根本没法代入**。抽成纯函数后才可以。
 *
 * 所以下面的用例一律写「起始宽 X，从 A 拖到 B，期望 Z」这种**具体数值**，
 * 而不是「断言方向对不对」这种定性判断。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  clampDockWidth,
  dockWidthFromDrag,
  MIN_CENTER_WIDTH,
  MIN_DOCK_WIDTH,
} from "../src/renderer/src/lib/dock.ts";

describe("dockWidthFromDrag：只对位移取负", () => {
  test("向左拖 20px → 右栏变宽（300 → 320）", () => {
    // 把手在中栏↔右栏边界上：手指左移，右栏就该变宽
    assert.equal(dockWidthFromDrag(300, 500, 480), 320);
  });

  test("向右拖 20px → 右栏变窄（300 → 280）", () => {
    assert.equal(dockWidthFromDrag(300, 500, 520), 280);
  });

  test("没动 → 宽度不变", () => {
    assert.equal(dockWidthFromDrag(300, 500, 500), 300);
  });

  test("大位移也成立：左拖 400px（300 → 700）", () => {
    assert.equal(dockWidthFromDrag(300, 500, 100), 700);
  });

  test("回归守卫：左拖绝不能算出负值（§3.3 那次就是算出了 -320）", () => {
    // 错误写法 `-(startWidth + dx)` 会给出 -320；正确写法只对 dx 取负
    const result = dockWidthFromDrag(300, 500, 480);
    assert.ok(result > 0, `左拖宽度应为正，实际 ${result}`);
    assert.equal(result, 320);
  });
});

describe("clampDockWidth：钳到 [下限, 可用宽度 − 中栏下限]", () => {
  test("区间内原样返回", () => {
    assert.equal(clampDockWidth(300, 1000), 300);
  });

  test("超过上限则钳到「可用宽度 − 中栏下限」（1000 − 360 = 640）", () => {
    assert.equal(clampDockWidth(900, 1000), 1000 - MIN_CENTER_WIDTH);
    assert.equal(clampDockWidth(900, 1000), 640);
  });

  test("低于下限则钳到下限（220）", () => {
    assert.equal(clampDockWidth(100, 1000), MIN_DOCK_WIDTH);
    assert.equal(clampDockWidth(100, 1000), 220);
  });

  test("负值也钳到下限", () => {
    assert.equal(clampDockWidth(-320, 1000), 220);
  });

  test("恰好在边界上：下限与上限都原样通过", () => {
    assert.equal(clampDockWidth(220, 1000), 220);
    assert.equal(clampDockWidth(640, 1000), 640);
  });

  test("窗口过窄时上下限不打架：上限回退到下限，不会比下限还小", () => {
    // 可用 500 − 中栏 360 = 140，比下限 220 还小 → 上限取 220，不应产生 < 220 的值
    assert.equal(clampDockWidth(300, 500), 220);
    assert.equal(clampDockWidth(1000, 500), 220);
  });

  test("可用宽度尚未量到（space ≤ 0）时只兜下限", () => {
    assert.equal(clampDockWidth(300, 0), 300);
    assert.equal(clampDockWidth(100, 0), 220);
    assert.equal(clampDockWidth(100, -1), 220);
  });

  test("拖拽全流程：300 宽左拖 20 不被钳制，仍是 320", () => {
    const next = dockWidthFromDrag(300, 500, 480);
    assert.equal(clampDockWidth(next, 1000), 320);
  });

  test("拖拽全流程：拖到越界会被钳回来", () => {
    // 从 640 再向左拖 200 → 840，超上限，钳回 640
    const next = dockWidthFromDrag(640, 500, 300);
    assert.equal(next, 840);
    assert.equal(clampDockWidth(next, 1000), 640);
  });
});
