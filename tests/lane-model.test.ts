/**
 * lane → 模型引用的记账（工作包 C 的**用量口径修复**）。
 *
 * 这条链路是「什么都不做也不会报错」的典型：记账错了不会有任何异常，只是用量明细里
 * 服务名与费用基准对不上（`costUsd` 由内核按**实际**模型算，服务名却来自会话模型），
 * 而按 provider 聚合出的「哪个服务在花钱」从此永远不准。故逐条钉住。
 *
 * 最该钉的是第 6、7 条：**两条 lane 跑不同模型时各记各的**——那正是修复前的错法
 * （一律按会话模型记），也是这个文件存在的全部理由。
 */
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  clearLaneModels,
  forgetLaneModel,
  laneModelRef,
  noteModelConfig,
  rememberLaneModel,
} from "../src/worker/lib/lane-model";

/** 内核 `config_update` 的 model 分支在真实运行时长这样（见 harness/runtime/lane.js 的 setModel） */
function modelConfig(lane: string, provider: string, modelId: string) {
  return {
    type: "config_update",
    lane,
    property: "model",
    previous: { provider, modelId },
    value: { provider, modelId },
  };
}

afterEach(() => {
  clearLaneModels();
});

describe("noteModelConfig：只认 model 分支", () => {
  test("model 分支记成 `providerId/modelId`（与协议里的模型引用同形）", () => {
    noteModelConfig(modelConfig("sub:cheap:abcd1234", "ollama", "qwen3:0.6b"));
    assert.equal(laneModelRef("sub:cheap:abcd1234"), "ollama/qwen3:0.6b");
  });

  test("thinkingLevel / activeTools 等其它 config_update 不污染账本", () => {
    noteModelConfig({ type: "config_update", lane: "main", property: "thinkingLevel", value: "high" });
    noteModelConfig({ type: "config_update", lane: "main", property: "activeTools", value: ["read"] });
    noteModelConfig({ type: "config_update", property: "tools", value: [] });
    assert.equal(laneModelRef("main"), undefined);
  });

  test("没有 lane 的全局 config_update 不记（记了会变成一条无主的假账）", () => {
    noteModelConfig({ type: "config_update", property: "model", value: { provider: "a", modelId: "b" } });
    assert.equal(laneModelRef(""), undefined);
    assert.equal(laneModelRef("main"), undefined);
  });

  test("形状不对时**不记**（宁可回落会话模型，也不写入一个编出来的引用）", () => {
    noteModelConfig({ type: "config_update", lane: "main", property: "model", value: undefined });
    assert.equal(laneModelRef("main"), undefined);
    noteModelConfig({ type: "config_update", lane: "main", property: "model", value: { provider: "a" } });
    assert.equal(laneModelRef("main"), undefined);
    noteModelConfig({ type: "config_update", lane: "main", property: "model", value: { provider: "", modelId: "b" } });
    assert.equal(laneModelRef("main"), undefined);
  });

  test("同一条 lane 再换模型时覆盖（账本记的是「现在」）", () => {
    noteModelConfig(modelConfig("main", "deepseek", "deepseek-flash"));
    noteModelConfig(modelConfig("main", "ollama", "qwen3:0.6b"));
    assert.equal(laneModelRef("main"), "ollama/qwen3:0.6b");
  });
});

describe("两条 lane 跑不同模型时各记各的（这就是修复前的错法）", () => {
  test("主 lane 与被子代理路由的 lane 互不干扰", () => {
    noteModelConfig(modelConfig("main", "deepseek", "deepseek-flash"));
    noteModelConfig(modelConfig("sub:cheap:aaaa1111", "ollama", "qwen3:0.6b"));

    assert.equal(laneModelRef("main"), "deepseek/deepseek-flash");
    assert.equal(
      laneModelRef("sub:cheap:aaaa1111"),
      "ollama/qwen3:0.6b",
      "被路由的子代理必须记到它自己的服务上——记成会话那家就是本次要修的 bug",
    );
  });

  test("多个子代理各跑不同服务时，三条账都对得上", () => {
    noteModelConfig(modelConfig("main", "deepseek", "deepseek-flash"));
    noteModelConfig(modelConfig("sub:a:11111111", "ollama", "qwen3:0.6b"));
    noteModelConfig(modelConfig("sub:b:22222222", "other", "small"));
    assert.deepEqual(
      ["main", "sub:a:11111111", "sub:b:22222222"].map((lane) => laneModelRef(lane)),
      ["deepseek/deepseek-flash", "ollama/qwen3:0.6b", "other/small"],
    );
  });
});

describe("回落与卸账", () => {
  test("没记到的 lane 返回 undefined（调用方据此回落会话模型，而不是拿个空串去记账）", () => {
    assert.equal(laneModelRef("sub:never-seen:00000000"), undefined);
  });

  test("forget 之后回到「没记到」（子代理跑完时调用）", () => {
    noteModelConfig(modelConfig("sub:a:11111111", "ollama", "qwen3:0.6b"));
    forgetLaneModel("sub:a:11111111");
    assert.equal(laneModelRef("sub:a:11111111"), undefined);
  });

  test("clearLaneModels 清空全部（会话收口）", () => {
    rememberLaneModel("main", "deepseek/deepseek-flash");
    rememberLaneModel("sub:a:11111111", "ollama/qwen3:0.6b");
    clearLaneModels();
    assert.equal(laneModelRef("main"), undefined);
    assert.equal(laneModelRef("sub:a:11111111"), undefined);
  });

  test("空 lane 名 / 空引用不记账（防出一条查不回来的账）", () => {
    rememberLaneModel("", "a/b");
    rememberLaneModel("main", "");
    assert.equal(laneModelRef(""), undefined);
    assert.equal(laneModelRef("main"), undefined);
  });

  test("超过上限时丢最早的一条，不无界增长", () => {
    const lanes = Array.from({ length: 600 }, (_item, index) => `sub:x:${index}`);
    for (const lane of lanes) rememberLaneModel(lane, "ollama/qwen3:0.6b");
    assert.equal(laneModelRef(lanes[0]!), undefined, "最早的那条应被淘汰");
    assert.equal(laneModelRef(lanes[599]!), "ollama/qwen3:0.6b", "最新的那条必须在");
  });
});
