/**
 * Provider 装配契约测试：自定义 openai-compatible 模型的能力与计价
 * 必须来自用户的显式声明（设置页表单 → ModelOption），缺省值即历史行为
 * （纯文本、无推理、零计价、maxTokens 钳 min(上下文, 8192)）。
 *
 * pi-ai 无 electron 依赖，可在 node 测试里真实装配并读取模型元数据，
 * 这里直接断言装配产物，防止装配端与声明契约分叉。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildProvider, type ProviderBuildConfig } from "@shared/provider-factory";
import { LEGACY_MAX_TOKENS } from "@shared/model-option";

const BASE: ProviderBuildConfig = {
  id: "custom",
  name: "Custom",
  kind: "openai-compatible",
  baseUrl: "https://api.example.com/v1",
  models: [],
};

function buildModel(option: ProviderBuildConfig["models"][number]) {
  const provider = buildProvider({ ...BASE, models: [option] });
  const model = provider.getModels().find((item) => item.id === option.id);
  assert.ok(model, "装配后的 provider 应包含声明的模型");
  return model;
}

describe("buildProvider 按声明装配自定义模型", () => {
  test("声明图片、推理、计价与最大输出时逐项生效", () => {
    const model = buildModel({
      id: "m",
      name: "M",
      contextWindow: 128_000,
      imageInput: true,
      reasoning: true,
      maxTokens: 65_536,
      price: { input: 1.5, output: 6 },
    });
    assert.deepEqual(model.input, ["text", "image"]);
    assert.equal(model.reasoning, true);
    assert.equal(model.maxTokens, 65_536);
    assert.equal(model.cost.input, 1.5);
    assert.equal(model.cost.output, 6);
    assert.equal(model.cost.cacheRead, 0);
    assert.equal(model.cost.cacheWrite, 0);
  });

  test("未声明回落历史行为：纯文本、无推理、零计价、8192 钳制", () => {
    const model = buildModel({ id: "m", name: "M", contextWindow: 32_000 });
    assert.deepEqual(model.input, ["text"]);
    assert.equal(model.reasoning, false);
    assert.equal(model.maxTokens, Math.min(32_000, LEGACY_MAX_TOKENS));
    assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  test("上下文小于钳制值时 maxTokens 取上下文本身", () => {
    const model = buildModel({ id: "m", name: "M", contextWindow: 4_000 });
    assert.equal(model.maxTokens, 4_000);
  });

  test("deepseek 内置仍走官方工厂，模型表来自 pi-ai 目录", () => {
    const provider = buildProvider({
      ...BASE,
      id: "deepseek",
      kind: "deepseek",
      baseUrl: "https://api.deepseek.com",
    });
    assert.ok(provider.getModels().length > 0, "内置工厂应自带模型目录");
  });
});
