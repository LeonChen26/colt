/**
 * 会话模型标识拆分测试。
 * 该格式跨 main / worker / renderer 三端使用，切分规则必须唯一且稳定。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { splitModelRef } from "../src/shared/model-ref.ts";

describe("splitModelRef", () => {
  test("拆分 provider 与 model", () => {
    assert.deepEqual(splitModelRef("deepseek/deepseek-v4", "fallback"), {
      provider: "deepseek",
      model: "deepseek-v4",
    });
  });

  test("无斜杠时整体作为 model，provider 用回落值", () => {
    assert.deepEqual(splitModelRef("solo-model", "fallback"), {
      provider: "fallback",
      model: "solo-model",
    });
  });

  test("只在首个斜杠处切分，模型名内含斜杠不被截断", () => {
    assert.deepEqual(splitModelRef("openai/org/model-x", "fallback"), {
      provider: "openai",
      model: "org/model-x",
    });
  });

  test("未给回落值时 provider 为空串（调用方可据此判定缺少 provider）", () => {
    assert.deepEqual(splitModelRef("solo-model"), { provider: "", model: "solo-model" });
    assert.deepEqual(splitModelRef(""), { provider: "", model: "" });
  });
});
