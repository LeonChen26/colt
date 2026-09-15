/**
 * ModelOption 清洗的单测。
 *
 * 模型声明来自用户手填，落库前必须归一（见 src/shared/model-option.ts）。
 * 这里把「非法回落默认、非法剔除、id 空剔除整行」三条规则钉死——
 * 装配端（provider-factory）与界面展示都依赖这个归一后的形状。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONTEXT_WINDOW,
  LEGACY_MAX_TOKENS,
  normalizeModelOption,
  normalizeModelOptions,
} from "@shared/model-option";

describe("normalizeModelOption", () => {
  test("最小声明：name 回落到 id，contextWindow 回落默认", () => {
    const model = normalizeModelOption({ id: " m1 ", name: "  ", contextWindow: 0 });
    assert.deepEqual(model, {
      id: "m1",
      name: "m1",
      contextWindow: DEFAULT_CONTEXT_WINDOW,
    });
  });

  test("完整声明逐字段保留", () => {
    const model = normalizeModelOption({
      id: "m",
      name: " M ",
      contextWindow: 200_000,
      imageInput: true,
      reasoning: true,
      maxTokens: 65_536,
      price: { input: 1.5, output: 6, cacheRead: 0, cacheWrite: 0.1 },
    });
    assert.deepEqual(model, {
      id: "m",
      name: "M",
      contextWindow: 200_000,
      imageInput: true,
      reasoning: true,
      maxTokens: 65_536,
      price: { input: 1.5, output: 6, cacheRead: 0, cacheWrite: 0.1 },
    });
  });

  test("id 为空剔除整行——唯一会剔除行的条件", () => {
    assert.equal(
      normalizeModelOption({ id: "   ", name: "x", contextWindow: 1000 }),
      null,
    );
    assert.equal(
      // @ts-expect-error 非字符串 id 同样剔除（数据可能来自手改坏 JSON）
      normalizeModelOption({ id: 42, contextWindow: 1000 }),
      null,
    );
  });

  test("能力布尔只认显式 true——缺省即 false，宁严勿松", () => {
    const model = normalizeModelOption({
      id: "m",
      name: "m",
      contextWindow: 1000,
      imageInput: false,
      // @ts-expect-error 非布尔值同样按未声明处理
      reasoning: "yes",
    });
    assert.ok(model, "清洗不应剔除该行");
    assert.equal(model.imageInput, undefined);
    assert.equal(model.reasoning, undefined);
  });

  test("maxTokens 非法一律剔除，装配端自行回落历史钳制", () => {
    for (const bad of [0, -1, 8192.5, "64k", Number.NaN]) {
      const model = normalizeModelOption({
        id: "m",
        name: "m",
        contextWindow: 1000,
        maxTokens: bad as number,
      });
      assert.ok(model, "清洗不应剔除该行");
      assert.equal(model.maxTokens, undefined, `maxTokens=${String(bad)} 应被剔除`);
    }
  });

  test("价格逐键校验：负数/非数剔除，0 保留（免费 endpoint 合法）", () => {
    const model = normalizeModelOption({
      id: "m",
      name: "m",
      contextWindow: 1000,
      price: { input: -1, output: Number.NaN, cacheRead: 0, cacheWrite: Number.POSITIVE_INFINITY },
    });
    assert.ok(model, "清洗不应剔除该行");
    assert.deepEqual(model.price, { cacheRead: 0 });
  });

  test("价格全非法时整块剔除", () => {
    const model = normalizeModelOption({
      id: "m",
      name: "m",
      contextWindow: 1000,
      price: { input: -1 },
    });
    assert.ok(model, "清洗不应剔除该行");
    assert.equal(model.price, undefined);
  });

  test("历史钳制常量钉死为 8192——装配端的回落行为依赖它", () => {
    assert.equal(LEGACY_MAX_TOKENS, 8192);
  });
});

describe("normalizeModelOptions", () => {
  test("剔除无效行并保序", () => {
    const models = normalizeModelOptions([
      { id: "", name: "a", contextWindow: 1 },
      { id: "b", name: "b", contextWindow: 2 },
      { id: "c", name: "", contextWindow: 0, maxTokens: 100 },
    ]);
    assert.deepEqual(
      models.map((model) => model.id),
      ["b", "c"],
    );
  });

  test("非数组输入返回空数组——空列表由调用方裁决", () => {
    assert.deepEqual(normalizeModelOptions(undefined as unknown as []), []);
  });
});
