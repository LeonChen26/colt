/**
 * Provider 装配契约测试：自定义 openai-compatible 模型的能力与计价
 * 必须来自用户的显式声明（设置页表单 → ModelOption），缺省值即历史行为
 * （纯文本、无推理、零计价、maxTokens 钳 min(上下文, 8192)）。
 *
 * 另有一条**安全契约**（工作包 B）：密钥只能从**第二个参数**进来。
 * 这里直接把 provider 的 ApiKeyAuth 解出来验「给什么就是什么」，
 * 并验「环境变量里放了密钥也读不到」——后者是本包要消灭的那条路，
 * 只靠读代码很容易在别处再被接上。
 *
 * pi-ai 无 electron 依赖，可在 node 测试里真实装配并读取模型元数据，
 * 这里直接断言装配产物，防止装配端与声明契约分叉。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import { buildProvider, type ProviderBuildConfig } from "@shared/provider-factory";
import { LEGACY_MAX_TOKENS } from "@shared/model-option";

const BASE: ProviderBuildConfig = {
  id: "custom",
  name: "Custom",
  kind: "openai-compatible",
  baseUrl: "https://api.example.com/v1",
  models: [],
};

/** 装配用的假密钥：走参数而非环境变量（见文件头的安全契约） */
const TEST_KEY = "test-key-not-a-real-secret";

function buildModel(option: ProviderBuildConfig["models"][number]) {
  const provider = buildProvider({ ...BASE, models: [option] }, TEST_KEY);
  const model = provider.getModels().find((item) => item.id === option.id);
  assert.ok(model, "装配后的 provider 应包含声明的模型");
  return model;
}

/** 把装配产物的 ApiKeyAuth 解一次，看它到底会拿哪个密钥去请求 */
async function resolveApiKey(
  provider: ReturnType<typeof buildProvider>,
  env: Record<string, string> = {},
): Promise<string | undefined> {
  const auth = provider.auth?.apiKey;
  assert.ok(auth, "每个 provider 都必须有 apiKey auth");
  const result = await auth.resolve({
    ctx: {
      env: async (name: string) => env[name],
      fileExists: async () => false,
    },
    signal: new AbortController().signal,
  });
  return result?.auth.apiKey;
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

  test("deepseek 内置的模型表仍取 pi-ai 原表（装配换成 createProvider 后不缩水）", () => {
    const provider = buildProvider(
      {
        ...BASE,
        id: "deepseek",
        kind: "deepseek",
        baseUrl: "https://api.deepseek.com",
      },
      TEST_KEY,
    );

    // 与静态目录逐项对齐，而不是「有几个就行」：内置分支不再调 `deepseekProvider()`，
    // 但必须仍取 `DEEPSEEK_MODELS` **原表**——兼容层要的 `compat` / `thinkingLevelMap` /
    // 价格都在原表里，换成 config.models 那份界面投影会静默丢掉思考等级与计价。
    // 不写死 id 清单——来源模块的注释已说明「不手写常量，避免 pi-ai 升表后此处漂移」。
    const fromCatalog = Object.values(DEEPSEEK_MODELS)
      .map((model) => model.id)
      .sort();
    // 目录为空时下面的相等断言会恒真，先把它堵掉
    assert.ok(fromCatalog.length > 0, "pi-ai 目录不该是空的");
    assert.deepEqual(
      provider
        .getModels()
        .map((model) => model.id)
        .sort(),
      fromCatalog,
    );
  });
});

describe("密钥只从参数进来（工作包 B 的安全契约）", () => {
  test("装配时给的密钥会被原样解析出来（内置与自定义两条装配路径都是）", async () => {
    const custom = buildProvider({ ...BASE, models: [] }, TEST_KEY);
    assert.equal(await resolveApiKey(custom), TEST_KEY);

    const builtin = buildProvider(
      { ...BASE, id: "deepseek", kind: "deepseek", baseUrl: "https://api.deepseek.com" },
      "deepseek-key",
    );
    assert.equal(await resolveApiKey(builtin), "deepseek-key");
  });

  test("环境变量里放了密钥也读不到——「回落 env」这条路已经拆掉", async () => {
    const provider = buildProvider({ ...BASE, models: [] }, undefined);
    const hostile = { COLT_PROVIDER_KEY: "leaked", DEEPSEEK_API_KEY: "leaked" };
    assert.equal(
      await resolveApiKey(provider, hostile),
      undefined,
      "密钥必须只能来自装配参数；能从 env 读到就等于 worker 环境里那个洞还在",
    );
  });

  test("密钥为空串时不当作「已配置」（与「环境变量没配」同一语义）", async () => {
    const provider = buildProvider({ ...BASE, models: [] }, "");
    assert.equal(await resolveApiKey(provider), undefined);
  });
});
