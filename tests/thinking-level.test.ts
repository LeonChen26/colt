/**
 * 思考等级的取值收敛。
 *
 * 这几条断言守着同一个底线：**默认值绝不能是 off**。off 会被 provider 兼容层
 * 翻译成「显式关闭思考」（zai 协议必写 thinking.type=disabled），而「始终思考」的
 * 模型会直接 400 —— 压缩、审批分析器这类**不带工具**的请求会整条失效。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_THINKING_LEVEL,
  THINKING_LEVELS,
  isThinkingLevel,
  resolveThinkingLevel,
  toStoredThinkingLevel,
} from "../src/shared/thinking-level.ts";

describe("思考等级", () => {
  test("默认值不是 off，且本身是合法取值", () => {
    assert.notEqual(DEFAULT_THINKING_LEVEL, "off");
    assert.ok(THINKING_LEVELS.includes(DEFAULT_THINKING_LEVEL));
  });

  test("从未选过（NULL / undefined / 空串）一律回落到默认值", () => {
    for (const stored of [null, undefined, ""]) {
      assert.equal(resolveThinkingLevel(stored), DEFAULT_THINKING_LEVEL);
    }
  });

  test("用户显式选过的合法值原样沿用", () => {
    for (const level of THINKING_LEVELS) {
      assert.equal(resolveThinkingLevel(level), level);
    }
  });

  test("脏值回落到默认值，不原样透传给内核", () => {
    assert.equal(resolveThinkingLevel("medium2"), DEFAULT_THINKING_LEVEL);
    assert.equal(resolveThinkingLevel("HIGH"), DEFAULT_THINKING_LEVEL);
    assert.equal(resolveThinkingLevel("minimal"), DEFAULT_THINKING_LEVEL);
  });

  test("toStoredThinkingLevel：非法值视为「从未选过」，合法值原样保留", () => {
    assert.equal(toStoredThinkingLevel(null), null);
    assert.equal(toStoredThinkingLevel("bogus"), null);
    assert.equal(toStoredThinkingLevel("off"), "off");
    assert.equal(toStoredThinkingLevel("high"), "high");
  });

  test("isThinkingLevel 只认开放的四档，不认内核的完整枚举", () => {
    assert.equal(isThinkingLevel("off"), true);
    assert.equal(isThinkingLevel("high"), true);
    assert.equal(isThinkingLevel("minimal"), false);
    assert.equal(isThinkingLevel("xhigh"), false);
    assert.equal(isThinkingLevel(1), false);
    assert.equal(isThinkingLevel(undefined), false);
  });
});
