/**
 * 会话模型标识拆分与解析测试。
 * 该格式跨 main / worker / renderer 三端使用，切分规则必须唯一且稳定；
 * 解析规则则决定「会话能否打开」，主进程与渲染层共用同一份，漂移会让二者判断不一致。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_DEFAULT_MODEL_REF,
  displayModelRef,
  firstUsableProvider,
  hasUsableProvider,
  isUsableProvider,
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
    requiresKey: true,
  };
}

/** 本地 / 自建 endpoint：无需密钥 */
function keyless(id: string, models: string[]): ProviderConfig {
  return { ...provider(id, models), requiresKey: false };
}

const DEEPSEEK = provider("deepseek", ["deepseek-v4-flash", "deepseek-v4"], true);
const CUSTOM = provider("custom", ["kimi-k2"]);
const LOCAL = keyless("ollama", ["qwen3:8b"]);

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

  /**
   * 回落链要看**密钥状态**：用户可能一个 DeepSeek 密钥都不配、只用自定义服务。
   * 回归背景（用户实测）：没有 DeepSeek 密钥 + 配好自定义 provider，默认解析却落到内置
   * DeepSeek，界面报「尚未配置 DeepSeek 的 API Key」，发消息也被启动检查拒绝——
   * 明明有能用的服务，一个也用不上。
   */
  describe("回落时优先可用的服务", () => {
    const withKey = (base: ProviderConfig, hasKey: boolean): ProviderConfig => ({ ...base, hasKey });

    test("只配了自定义服务（内置缺密钥）时回落它，而不是没密钥的内置默认", () => {
      const list = [withKey(DEEPSEEK, false), withKey(CUSTOM, true)];
      assert.deepEqual(resolveSessionModel(null, list), {
        providerId: "custom",
        modelId: "kimi-k2",
      });
    });

    test("选定项已失效 + 内置缺密钥：同样回落到可用的自定义服务", () => {
      const list = [withKey(DEEPSEEK, false), withKey(CUSTOM, true)];
      assert.deepEqual(resolveSessionModel("gone/kimi-k2", list), {
        providerId: "custom",
        modelId: "kimi-k2",
      });
      assert.deepEqual(resolveSessionModel("custom/kimi-k2-old", list), {
        providerId: "custom",
        modelId: "kimi-k2",
      });
    });

    test("内置可用时仍优先内置（内置在列表最前，行为与修复前一致）", () => {
      const list = [withKey(DEEPSEEK, true), withKey(CUSTOM, true)];
      assert.deepEqual(resolveSessionModel(null, list), BUILTIN_FALLBACK);
    });

    test("会话选定仍优先于可用回落（不夺走用户的显式选择）", () => {
      const list = [withKey(DEEPSEEK, true), withKey(CUSTOM, true)];
      assert.deepEqual(resolveSessionModel("custom/kimi-k2", list), {
        providerId: "custom",
        modelId: "kimi-k2",
      });
    });

    test("一个都没配密钥：仍回落内置默认（界面据此提示去配密钥）", () => {
      const list = [withKey(DEEPSEEK, false), withKey(CUSTOM, false)];
      assert.deepEqual(resolveSessionModel(null, list), BUILTIN_FALLBACK);
    });

    test("可用的自定义服务没有模型时不算可用，回落内置默认", () => {
      const list = [withKey(DEEPSEEK, false), withKey(provider("empty", []), true)];
      assert.deepEqual(resolveSessionModel(null, list), BUILTIN_FALLBACK);
    });
  });
});

/**
 * 「是否已有可用模型服务」的判定。
 * 界面黄条（尚未配置 API Key）用它决定是否显示——只看内置 DeepSeek 会在
 * 「只配了 OpenAI 兼容服务」时误报，本用例即锁住该回归。
 */
describe("hasUsableProvider", () => {
  /** 带密钥状态的 provider */
  function withKey(base: ProviderConfig, hasKey: boolean): ProviderConfig {
    return { ...base, hasKey };
  }

  test("只配了 OpenAI 兼容服务（内置 DeepSeek 空着）也算就绪", () => {
    const providers = [withKey(DEEPSEEK, false), withKey(CUSTOM, true)];
    assert.equal(hasUsableProvider(providers), true);
    assert.equal(firstUsableProvider(providers)?.id, "custom");
  });

  test("一个都没配密钥时未就绪", () => {
    assert.equal(hasUsableProvider([withKey(DEEPSEEK, false), withKey(CUSTOM, false)]), false);
    assert.equal(hasUsableProvider([]), false);
    assert.equal(firstUsableProvider([]), undefined);
  });

  test("配了密钥但没填模型的服务不算可用（照样开不了会话）", () => {
    const empty = { ...provider("empty", []), hasKey: true };
    assert.equal(hasUsableProvider([empty]), false);
  });

  test("内置项在前，全都可用时提示仍指向 DeepSeek", () => {
    assert.equal(firstUsableProvider([withKey(DEEPSEEK, true), withKey(CUSTOM, true)])?.id, "deepseek");
  });
});

/**
 * 界面「当前模型」该显示哪个引用。
 *
 * 回归背景（用户实测）：「未开启会话就不能选 model」——会话可能根本没有 worker
 * （未打开 / 已空闲回收），此时 `session.view` 为 null、`view.model` 永远是空的。
 * 若显示值只认 worker 汇报的模型，已经选好并落库的选择就会显示成空，
 * 看上去就是「选了没反应」。本用例锁住「落库的选择优先」这条规则。
 */
describe("displayModelRef", () => {
  const providers = [DEEPSEEK, CUSTOM];

  test("会话已选定且仍有效：显示落库的选择，即使 worker 汇报的是另一个模型", () => {
    assert.deepEqual(displayModelRef("custom/kimi-k2", providers, "deepseek/deepseek-v4"), {
      modelRef: "custom/kimi-k2",
    });
  });

  test("会话已选定且仍有效、但没有 worker：照样显示落库的选择（本轮修复的核心）", () => {
    assert.deepEqual(displayModelRef("custom/kimi-k2", providers, undefined), {
      modelRef: "custom/kimi-k2",
    });
    assert.deepEqual(displayModelRef("custom/kimi-k2", providers, null), {
      modelRef: "custom/kimi-k2",
    });
  });

  test("选定仍有效但缺密钥：仍显示选定本身（那是「还差一步」，不是失效）", () => {
    assert.deepEqual(displayModelRef("custom/kimi-k2", [{ ...CUSTOM, hasKey: false }], undefined), {
      modelRef: "custom/kimi-k2",
    });
  });

  test("选定已失效：显示**实际会用**的模型，并回填原引用供界面提示漂移", () => {
    assert.deepEqual(displayModelRef("gone/kimi-k2", providers, undefined), {
      modelRef: "deepseek/deepseek-v4-flash",
      driftedFrom: "gone/kimi-k2",
    });
    assert.deepEqual(displayModelRef("custom/kimi-k2-old", providers, undefined), {
      modelRef: "deepseek/deepseek-v4-flash",
      driftedFrom: "custom/kimi-k2-old",
    });
  });

  test("从未选过：回落到 worker 汇报的模型（可能已按规则回退过）", () => {
    assert.deepEqual(displayModelRef(null, providers, "deepseek/deepseek-v4-flash"), {
      modelRef: "deepseek/deepseek-v4-flash",
    });
    assert.deepEqual(displayModelRef(undefined, providers, "deepseek/deepseek-v4"), {
      modelRef: "deepseek/deepseek-v4",
    });
  });

  test("两者都没有：返回空串，界面据此显示占位符而不是空白值", () => {
    assert.equal(displayModelRef(null, providers, undefined).modelRef, "");
    assert.equal(displayModelRef(undefined, providers, null).modelRef, "");
    assert.equal(displayModelRef(null, providers, "").modelRef, "");
  });
});

/**
 * 「可用」不能等同于「配了密钥」。
 *
 * 回归背景（用户实测）：只用本地 / 自建 endpoint 的用户（ollama、vLLM …）本来就没有、
 * 也不需要密钥。旧判据 `hasKey === true` 把这类服务永远排除在外，默认解析落到内置
 * DeepSeek，一发消息就报「尚未配置 DeepSeek 的 API Key」——明明跑着模型，一个也用不上。
 */
describe("isUsableProvider 认可无需密钥的服务", () => {
  function withKey(base: ProviderConfig, hasKey: boolean): ProviderConfig {
    return { ...base, hasKey };
  }

  test("无需密钥且有模型即算可用（本地 endpoint）", () => {
    assert.equal(isUsableProvider(LOCAL), true);
    assert.equal(hasUsableProvider([withKey(DEEPSEEK, false), LOCAL]), true);
    assert.equal(firstUsableProvider([withKey(DEEPSEEK, false), LOCAL])?.id, "ollama");
  });

  test("无需密钥但没有模型仍不算可用（开不了会话）", () => {
    assert.equal(isUsableProvider(keyless("empty", [])), false);
  });

  test("默认解析能落到无需密钥的服务上（不再误落到没密钥的内置默认）", () => {
    assert.deepEqual(resolveSessionModel(null, [withKey(DEEPSEEK, false), LOCAL]), {
      providerId: "ollama",
      modelId: "qwen3:8b",
    });
  });
});
