/**
 * 子代理的**模型路由**（工作包 C）与 provider 按需注册。
 *
 * 验收的关键不是「代码里出现了 setModel」，而是**两条可观测的行为**：
 *   ① 定义写了 `model:` → spawn 出的 lane 真的被 setModel 到那一家/那个模型；
 *   ② 定义没写 → 一次都不碰 setModel（沿用会话模型 = 现状语义，不能有副作用）。
 *
 * 失败口径同样重要：目标 provider 取不到密钥 / 模型不存在时，spawn 必须**抛错**，
 * 绝不许静默回落到会话模型——那样委托方以为路由生效了，实际跑的是另一个模型。
 *
 * harness 与 lane 都用假实现（内核那套跑起来要真发请求）；这是本仓第一次给
 * `Subagents` 打桩，故打桩范围写得显式：**用到哪个方法实现哪个**，
 * 缺一个就会以 TypeError 直接暴露（不静默通过）。
 */
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createModels } from "@earendil-works/pi-ai";
import type { AgentHarness, ExecutionToolContext } from "@earendil-works/pi-agent-core";
import { buildProvider } from "@shared/provider-factory";
import { ProviderRegistry } from "../src/worker/lib/provider-registry";
import { Subagents } from "../src/worker/lib/subagent";
import { clearLaneModels, laneModelRef } from "../src/worker/lib/lane-model";
import type { AgentDef } from "../src/worker/lib/agent-defs";

const CONTEXT = {} as never;

// 记账是**模块级单例**（真实进程里也只有一份），用例之间必须清干净：
// 留着上一轮的账会让「跑完卸账」「读不到模型不记」这类断言读到别人的残留。
afterEach(() => {
  clearLaneModels();
});

function agentDef(overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    name: "cheap",
    description: "便宜的调研子代理",
    tools: ["read"],
    model: null,
    body: "你是一个调研子代理。",
    source: "user",
    path: "cheap.md",
    ...overrides,
  };
}

/**
 * 记下所有 setModel / setActiveTools 调用；其余方法够用就行。
 *
 * `getModel` 报的是这条 lane（在假实现里）**当前**用的模型——测试用它模拟「创建时继承的
 * 是那一刻的会话模型」：`recordLaneModelFrom` 读的就是它，故可以在此基础上断言记账口径。
 */
function fakeLane(initialModel: { provider: string; id: string } | undefined) {
  const setModelCalls: unknown[] = [];
  const setActiveToolsCalls: unknown[] = [];
  const snapshot = { transcript: [] };
  let current = initialModel;
  /**
   * **运行中**观测到的记账值。
   *
   * 必须在 prompt() 里抓：`#run` 一收尾就 `forgetLaneModel`（用量在运行期已全部产生），
   * 等 spawn 返回再查账必然是空的——那种断言恒真，等于没测。
   */
  let modelRefDuringRun: string | undefined;
  const lane = {
    /** lane 名 = `harness.lane(name)` 给的那个 id（真实进程里两者就是一回事） */
    name: "",
    setModelCalls,
    setActiveToolsCalls,
    get modelRefDuringRun() {
      return modelRefDuringRun;
    },
    async getModel() {
      return current;
    },
    async getActiveTools() {
      return [];
    },
    async setActiveTools(tools: string[]) {
      setActiveToolsCalls.push(tools);
    },
    async setModel(model: { provider: string; modelId: string }) {
      setModelCalls.push(model);
      current = { provider: model.provider, id: model.modelId };
    },
    async watch() {
      return {
        snapshot,
        start: () => undefined,
        unsubscribe: () => undefined,
        resnapshot: async () => snapshot,
      };
    },
    async prompt() {
      modelRefDuringRun = laneModelRef(lane.name);
      return { ok: true, value: { status: "completed" } };
    },
    async steer() {
      return { ok: true, value: undefined };
    },
    async abort() {
      return { ok: true, value: undefined };
    },
    async waitForIdle() {
      return undefined;
    },
    async getResult() {
      return undefined;
    },
  };
  return lane;
}

function fakeHarness(lane: ReturnType<typeof fakeLane>) {
  const laneCalls: unknown[] = [];
  return {
    laneCalls,
    async getTools() {
      return [{ name: "read" }];
    },
    async lane(name: string) {
      laneCalls.push(name);
      // lane 名**就是**传进来的那个 id：夹具必须照实，否则「记账用的名字」与
      // 「卸账用的名字」会不一致（`rememberLaneModel(lane.name)` vs `forgetLaneModel(run.id)`），
      // 表现成「卸账没生效」的假红。
      lane.name = name;
      return lane;
    },
    async lanes() {
      return [];
    },
  } as unknown as AgentHarness<ExecutionToolContext> & { laneCalls: unknown[] };
}

interface SpawnOutcome {
  text: string;
  lane: ReturnType<typeof fakeLane>;
  ensureCalls: { providerId: string; modelId: string }[];
  /** 这次 spawn 里 `harness.lane()` 被调用了几次（用来验「失败时不留空 lane」） */
  laneCalls: unknown[];
  error?: Error;
}

async function spawn(
  def: AgentDef,
  ensureModel?: (providerId: string, modelId: string) => Promise<void>,
  /**
   * 这条 lane 创建时继承到的模型。**`null` = lane 读不到模型**（用 `undefined` 不行：
   * 显式传 undefined 会触发默认值，「读不到」这个前提就建立不起来——测试会假绿）。
   */
  inheritedModel: { provider: string; id: string } | null = {
    provider: "deepseek",
    id: "deepseek-flash",
  },
): Promise<SpawnOutcome> {
  const lane = fakeLane(inheritedModel ?? undefined);
  const ensureCalls: { providerId: string; modelId: string }[] = [];
  const harness = fakeHarness(lane);
  const subagents = new Subagents({
    mainLane: "main",
    defs: [def],
    harness: () => harness,
    onUpdate: () => undefined,
    ensureModel:
      ensureModel ??
      (async (providerId, modelId) => {
        ensureCalls.push({ providerId, modelId });
      }),
  });
  const tool = subagents.tools()[0]!;
  try {
    const result = await tool.execute(
      "call-1",
      { agent: def.name, task: "查一下 read 工具在哪注册" },
      () => undefined,
      CONTEXT,
      { operationId: "op-1" } as never,
      CONTEXT,
    );
    const text = result.content
      .map((block) => ("text" in block ? block.text : ""))
      .join("");
    return { text, lane, ensureCalls, laneCalls: harness.laneCalls };
  } catch (error) {
    return { text: "", lane, ensureCalls, laneCalls: harness.laneCalls, error: error as Error };
  }
}

describe("子代理按定义选模型：写了就切、没写就不碰", () => {
  test("定义写了 model → setModel 被以正确的 provider/model 调用", async () => {
    const out = await spawn(agentDef({ model: "other/gpt-small" }));
    assert.equal(out.error, undefined);
    assert.deepEqual(out.ensureCalls, [{ providerId: "other", modelId: "gpt-small" }]);
    assert.deepEqual(out.lane.setModelCalls, [{ provider: "other", modelId: "gpt-small" }]);
  });

  test("定义没写 model → 一次都不调 setModel（沿用会话模型，零副作用）", async () => {
    const out = await spawn(agentDef());
    assert.equal(out.error, undefined);
    assert.deepEqual(out.lane.setModelCalls, []);
    assert.deepEqual(out.ensureCalls, []);
  });

  /**
   * 「没调 setModel」不等于「不用记账」：这条 lane 用的仍是**创建那一刻的会话模型**，
   * 而用户可能在它跑着的时候切模型。不记的话，用量记账会拿**现在的**会话模型去解释
   * **过去的** lane——正是 `lane-model.ts` 要修的那类错。
   */
  test("定义没写 model 也要记下这条 lane 的模型（问 lane，不靠推断）", async () => {
    const def = agentDef();
    const out = await spawn(def);
    assert.equal(out.error, undefined);
    assert.equal(
      out.lane.modelRefDuringRun,
      "deepseek/deepseek-flash",
      "没路由的 lane 也必须记到它继承到的那个模型上",
    );
  });
  test("路由的 lane 记的是**目标**模型（不是继承来的那个）", async () => {
    const def = agentDef({ model: "other/gpt-small" });
    const out = await spawn(def);
    assert.equal(out.error, undefined);
    assert.equal(out.lane.modelRefDuringRun, "other/gpt-small");
  });

  test("跑完就卸账（用量在运行期已全部产生，留着会让「还在用这个模型」一直为真）", async () => {
    const def = agentDef();
    const out = await spawn(def);
    assert.equal(
      laneModelRef(out.lane.name),
      undefined,
      "跑完必须卸账，否则「这条 lane 还在用这个模型」会一直为真",
    );
  });

  test("读不到模型时不记（没答案就留空，不写一个猜的值）", async () => {
    const def = agentDef();
    const out = await spawn(def, undefined, null);
    assert.equal(out.error, undefined);
    assert.equal(out.lane.modelRefDuringRun, undefined);
    assert.equal(laneModelRef(out.lane.name), undefined);
  });

  test("先确保 provider 可用再 setModel（顺序反了内核会报 provider 未注册）", async () => {
    const order: string[] = [];
    const out = await spawn(agentDef({ model: "other/x" }), async () => {
      order.push("ensure");
    });
    assert.equal(out.error, undefined);
    assert.deepEqual(order, ["ensure"]);
    assert.deepEqual(out.lane.setModelCalls, [{ provider: "other", modelId: "x" }]);
  });

  test("拿不到目标 provider/模型时**抛错**，不回落到会话模型", async () => {
    const out = await spawn(agentDef({ model: "missing/gpt" }), async () => {
      throw new Error("尚未配置 Missing 的 API Key，无法使用它。");
    });
    assert.ok(out.error, "spawn 必须抛错");
    assert.match(out.error!.message, /尚未配置/);
    assert.deepEqual(
      out.lane.setModelCalls,
      [],
      "失败时绝不能悄悄 setModel 到别的模型上——那会让路由「看起来生效了」",
    );
  });

  test("模型解析失败时**一条 lane 都没建**（建了再抛会在会话里留一条空 lane 当垃圾）", async () => {
    const failed = await spawn(agentDef({ model: "missing/gpt" }), async () => {
      throw new Error("没有这个服务");
    });
    assert.ok(failed.error);
    assert.deepEqual(failed.laneCalls, [], "失败路径不该调用 harness.lane");

    // 对照：正常路径确实建了（否则上一条断言恒真、等于没测）
    const ok = await spawn(agentDef({ model: "other/gpt" }));
    assert.equal(ok.error, undefined);
    assert.equal(ok.laneCalls.length, 1);
  });
});

describe("ProviderRegistry：按需注册与密钥只取一次", () => {
  function registryWith(source: (providerId: string) => Promise<string>) {
    const models = createModels();
    const calls: string[] = [];
    const registry = new ProviderRegistry(models, {
      call: async (_capability, _action, params) => {
        const providerId = String(params.providerId);
        calls.push(providerId);
        return { text: await source(providerId) };
      },
    });
    registry.setDirectory([
      {
        id: "deepseek",
        name: "DeepSeek",
        kind: "deepseek",
        baseUrl: "https://api.deepseek.com",
        models: [{ id: "deepseek-flash", name: "Flash", contextWindow: 128_000 }],
        requiresKey: true,
      },
    ]);
    return { models, registry, calls };
  }

  test("未知 providerId → 结构化错误并列出可用项", async () => {
    const { registry } = registryWith(async () => "k");
    await assert.rejects(() => registry.ensure("nope"), /没有名为「nope」的模型服务配置/);
    await assert.rejects(() => registry.ensure("nope"), /deepseek/);
  });

  test("首次生效：取一次密钥并注册进 models；第二次不再往返", async () => {
    const { models, registry, calls } = registryWith(async () => "sk-test");
    await registry.ensure("deepseek");
    assert.ok(models.getProvider("deepseek"), "装配后应能从 models 里查到");
    await registry.ensure("deepseek");
    assert.deepEqual(calls, ["deepseek"], "同一会话内同 provider 只该取一次密钥");
  });

  test("已注册的 provider 不取密钥（会话自己那家从来就在 models 里）", async () => {
    const { models, registry, calls } = registryWith(async () => "sk-test");
    const entry = registry.entry("deepseek");
    assert.ok(entry);
    models.setProvider(buildProvider(entry, "会话自己的密钥"));
    await registry.ensure("deepseek");
    assert.deepEqual(calls, [], "已注册时不该再去主进程要一次密钥");
  });

  test("取密钥失败时错误原样透出（主进程那句「尚未配置 X 的 API Key」要能被模型看到）", async () => {
    const { registry } = registryWith(async () => {
      throw new Error("尚未配置 DeepSeek 的 API Key，无法使用它。");
    });
    await assert.rejects(() => registry.ensure("deepseek"), /尚未配置 DeepSeek 的 API Key/);
  });
});
