/**
 * 审批分析器的模型选择（工作包 C）。
 *
 * 三条必须钉住的行为：**设置缺省 = 会话模型**（单 provider 用户全程无感，
 * 这是回归面最大的那条）、**设置后 = 指定模型**、以及**未配置时不去查 provider 目录**
 * （分析器在自动审批里是热路径，白查一遍目录是纯开销）。
 * 第四条同样重要：设置里的引用**已失效**（服务被删 / 模型下线）时要**如实回落并带出
 * driftedFrom**——静默回落会让用户以为复核换了模型，实际花的还是会话那家的钱。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { resolveAnalyzerTarget } from "../src/main/approval/analyzer-model";
import type { ProviderConfig } from "../src/shared/protocol";

function provider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: "deepseek",
    name: "DeepSeek",
    kind: "deepseek",
    baseUrl: "https://api.deepseek.com",
    builtin: true,
    requiresKey: true,
    hasKey: true,
    models: [{ id: "deepseek-flash", name: "Flash", contextWindow: 128_000 }],
    ...overrides,
  };
}

const OTHER = provider({
  id: "cheap",
  name: "便宜服务",
  kind: "openai-compatible",
  baseUrl: "https://cheap.example.com/v1",
  builtin: false,
  models: [{ id: "small", name: "Small", contextWindow: 32_000 }],
});

const PROVIDERS = [provider(), OTHER];

const KEYS: Record<string, string> = { deepseek: "sk-session", cheap: "sk-cheap" };

/** providers 目录被真的求值过没有（用来钉「没配过就不查库」这条） */
let providerLookups = 0;

function resolve(configuredRef: string | null | undefined) {
  providerLookups = 0;
  return resolveAnalyzerTarget({
    session: { provider: provider(), modelId: "deepseek-flash", apiKey: "sk-session" },
    configuredRef,
    providers: () => {
      providerLookups += 1;
      return PROVIDERS;
    },
    apiKeyOf: (providerId) => KEYS[providerId],
  });
}

describe("resolveAnalyzerTarget：缺省即现状", () => {
  test("未配置（null / undefined / 空串）→ 沿用会话模型与密钥", () => {
    for (const ref of [null, undefined, "", "   "]) {
      const target = resolve(ref);
      assert.equal(target.provider.id, "deepseek");
      assert.equal(target.modelId, "deepseek-flash");
      assert.equal(target.apiKey, "sk-session");
      assert.equal(target.driftedFrom, undefined);
    }
  });

  test("未配置时**不查** provider 目录（分析器是热路径，没配过就别加开销）", () => {
    resolve(null);
    assert.equal(providerLookups, 0, "没配专用模型时不该去查一遍 provider 目录");
    resolve("cheap/small");
    assert.equal(providerLookups, 1, "配了才需要目录来校验引用");
  });
});

describe("resolveAnalyzerTarget：配了就换那一家", () => {
  test("指定另一家服务上的模型 → 用它的配置与**它自己**的密钥", () => {
    const target = resolve("cheap/small");
    assert.equal(target.provider.id, "cheap");
    assert.equal(target.provider.baseUrl, "https://cheap.example.com/v1");
    assert.equal(target.modelId, "small");
    assert.equal(target.apiKey, "sk-cheap", "密钥要按目标 provider 取，不能沿用会话那家的");
    assert.equal(target.driftedFrom, undefined);
  });

  test("同一家服务上的另一个模型 → 仍解析得出来", () => {
    const target = resolve("deepseek/deepseek-flash");
    assert.equal(target.provider.id, "deepseek");
    assert.equal(target.modelId, "deepseek-flash");
  });
});

describe("resolveAnalyzerTarget：失效引用如实回落", () => {
  test("服务被删 → 回落会话模型，并带回 driftedFrom", () => {
    const target = resolve("ghost/small");
    assert.equal(target.provider.id, "deepseek");
    assert.equal(target.modelId, "deepseek-flash");
    assert.equal(target.driftedFrom, "ghost/small");
  });

  test("模型下线（服务还在）→ 同样回落并带回 driftedFrom", () => {
    const target = resolve("cheap/retired-model");
    assert.equal(target.provider.id, "deepseek");
    assert.equal(target.driftedFrom, "cheap/retired-model");
  });
});
