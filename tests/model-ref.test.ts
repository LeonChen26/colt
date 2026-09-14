/**
 * 会话模型标识拆分与解析测试。
 * 该格式跨 main / worker / renderer 三端使用，切分规则必须唯一且稳定；
 * 解析规则则决定「会话能否打开」，主进程与渲染层共用同一份，漂移会让二者判断不一致。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_DEFAULT_MODEL_REF,
  resolveSessionModel,
  splitModelRef,
} from "../src/shared/model-ref.ts";
import type { ProviderConfig } from "../src/shared/protocol.ts";

/** 构造一个 provider（只用到解析相关的字段） */
function provider(id: string, models: string[], builtin = false): ProviderConfig {
  return {
    id,
    name: id,
    kind: builtin ? "deepseek" : "openai-compatible",
    baseUrl: "https://example.com",
    builtin,
    models: models.map((model) => ({ id: model, name: model, contextWindow: 1000 })),
  };
}

const DEEPSEEK = provider("deepseek", ["deepseek-v4-flash", "deepseek-v4"], true);
const CUSTOM = provider("custom", ["kimi-k2"]);

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

describe("resolveSessionModel", () => {
  const providers = [DEEPSEEK, CUSTOM];
  /** 内置默认的解析结果（provider/model 拆开后以 providerId/modelId 命名） */
  const BUILTIN_FALLBACK = { providerId: "deepseek", modelId: "deepseek-v4-flash" };

  test("会话未选过模型（null）时用内置默认", () => {
    assert.deepEqual(resolveSessionModel(null, providers), BUILTIN_FALLBACK);
    assert.deepEqual(resolveSessionModel(undefined, providers), BUILTIN_FALLBACK);
    assert.deepEqual(BUILTIN_DEFAULT_MODEL_REF, "deepseek/deepseek-v4-flash");
  });

  test("会话选定的 provider 与模型都在，按会话选定", () => {
    assert.deepEqual(resolveSessionModel("custom/kimi-k2", providers), {
      providerId: "custom",
      modelId: "kimi-k2",
    });
  });

  test("选定的 provider 已被删除，退回内置默认（否则会话永久打不开）", () => {
    assert.deepEqual(resolveSessionModel("gone/kimi-k2", providers), BUILTIN_FALLBACK);
  });

  test("选定的模型已下线，退回内置默认", () => {
    assert.deepEqual(resolveSessionModel("custom/kimi-k2-old", providers), BUILTIN_FALLBACK);
  });

  test("modelRef 无斜杠时按内置 provider 解释", () => {
    assert.deepEqual(resolveSessionModel("deepseek-v4", providers), {
      providerId: "deepseek",
      modelId: "deepseek-v4",
    });
  });
});
