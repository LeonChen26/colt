/**
 * provider 目录投影的钉子（工作包 C）。
 *
 * 这份投影会被塞进 `init` 消息体交给 worker —— 它是**唯一**一条
 * 「主进程把 provider 配置交给别人」的通道，所以它的失败方式只有一种：
 * **多带了一个字段**。多带的可能是一个密钥（今天还没有这种字段，明天会有），
 * 也可能是一个「省略掉就没人能装配」的字段（baseUrl / models / kind）。
 *
 * 两条都靠结构断言钉住：① 输出对象**逐字段**等于一份显式期望（多一个字段就红）；
 * ② 故意喂一个带 `apiKey` / `key` / `oauthToken` 的脏对象，断言它们一个都不在输出里
 *    ——包括**键名**（`{...provider, apiKey: undefined}` 那种黑名单写法的典型残留）。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { toDirectoryEntry, toProviderDirectory } from "../src/shared/provider-directory";
import type { ProviderConfig } from "../src/shared/protocol";

const PROVIDER: ProviderConfig = {
  id: "custom",
  name: "自建服务",
  kind: "openai-compatible",
  baseUrl: "https://api.example.com/v1",
  builtin: false,
  requiresKey: true,
  hasKey: true,
  models: [
    {
      id: "m1",
      name: "M1",
      contextWindow: 128_000,
      imageInput: true,
      reasoning: true,
      maxTokens: 4096,
      price: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
    },
    { id: "m2", name: "M2", contextWindow: 32_000 },
  ],
};

describe("toDirectoryEntry：白名单投影", () => {
  test("逐字段挑出装配需要的，界面字段一个不带", () => {
    const entry = toDirectoryEntry(PROVIDER);
    assert.deepEqual(Object.keys(entry).sort(), [
      "baseUrl",
      "id",
      "kind",
      "models",
      "name",
      "requiresKey",
    ]);
    assert.deepEqual(entry.models[0], {
      id: "m1",
      name: "M1",
      contextWindow: 128_000,
      imageInput: true,
      reasoning: true,
      maxTokens: 4096,
      price: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
    });
  });

  test("未声明的可选字段不落成 undefined 键（键名也是会泄漏的东西）", () => {
    const entry = toDirectoryEntry(PROVIDER);
    assert.deepEqual(Object.keys(entry.models[1]!).sort(), ["contextWindow", "id", "name"]);
    assert.equal("price" in entry.models[1]!, false);
    assert.equal("imageInput" in entry.models[1]!, false);
  });

  test("密钥字段哪怕以 undefined 形式出现也不算过（黑名单写法的典型残留）", () => {
    const hostile = {
      ...PROVIDER,
      apiKey: "sk-should-not-travel",
      key: "sk-should-not-travel",
      oauthToken: "tok-should-not-travel",
      secret: undefined,
    } as unknown as ProviderConfig;
    const entry = toDirectoryEntry(hostile) as unknown as Record<string, unknown>;
    for (const name of ["apiKey", "key", "oauthToken", "secret", "hasKey", "builtin"]) {
      assert.equal(name in entry, false, `${name} 不该出现在目录项里`);
    }
    // 也不能藏在模型的子对象里
    for (const model of entry.models as Record<string, unknown>[]) {
      for (const name of ["apiKey", "key", "secret"]) {
        assert.equal(name in model, false);
      }
    }
  });

  test("requiresKey 只在显式 false 时才为 false（缺字段一律按需要密钥，宁严勿松）", () => {
    assert.equal(toDirectoryEntry(PROVIDER).requiresKey, true);
    assert.equal(
      toDirectoryEntry({ ...PROVIDER, requiresKey: false }).requiresKey,
      false,
    );
    const missing = { ...PROVIDER } as Partial<ProviderConfig>;
    delete missing.requiresKey;
    assert.equal(toDirectoryEntry(missing as ProviderConfig).requiresKey, true);
  });

  test("整份目录保持主进程给的顺序（内置在前），条数不多不少", () => {
    const builtin: ProviderConfig = {
      ...PROVIDER,
      id: "deepseek",
      name: "DeepSeek",
      kind: "deepseek",
      builtin: true,
    };
    const list = toProviderDirectory([builtin, PROVIDER]);
    assert.deepEqual(list.map((item) => item.id), ["deepseek", "custom"]);
    assert.deepEqual(Object.keys(list[0]!).sort(), [
      "baseUrl",
      "id",
      "kind",
      "models",
      "name",
      "requiresKey",
    ]);
  });
});
