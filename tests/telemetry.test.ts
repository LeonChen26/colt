/**
 * 遥测投影测试：usage 过滤规则与 tool_start/tool_end 配对。
 * 重点覆盖两处曾被变异测试漏掉的行为：
 *   1. 工具记录的时间戳必须取开始时刻，否则并行工具顺序会反
 *   2. runId 必须原样带出，否则无法按运行聚合
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  ToolCallTracker,
  buildUsageUpload,
  contextUsedFromUsage,
  serializeArgs,
  type KernelToolEndEvent,
  type KernelUsageEvent,
} from "../src/worker/lib/telemetry.ts";

function usageEvent(overrides: Partial<KernelUsageEvent> = {}): KernelUsageEvent {
  return {
    lane: "main",
    row: {
      id: "u-1",
      adjustment: false,
      usage: { input: 100, output: 20, cacheRead: 8, cacheWrite: 4, cost: { total: 0.5 } },
      ...(overrides.row ?? {}),
    },
    ...(overrides.lane === undefined ? {} : { lane: overrides.lane }),
  };
}

function endEvent(overrides: Partial<KernelToolEndEvent> = {}): KernelToolEndEvent {
  return {
    lane: "main",
    runId: "run-1",
    toolCallId: "call-1",
    toolName: "bash",
    isError: false,
    ...overrides,
  };
}

describe("contextUsedFromUsage", () => {
  test("占用取 prompt tokens（input + cacheRead + cacheWrite）", () => {
    // input 是扣除 cache 后的净输入，单看 input 会漏算缓存部分
    assert.equal(contextUsedFromUsage(usageEvent()), 112);
  });

  test("非主 lane 返回 null（子 agent 消耗不计入当前会话）", () => {
    assert.equal(contextUsedFromUsage(usageEvent({ lane: "sub" })), null);
  });

  test("adjustment 补记行返回 null（不是新的模型调用）", () => {
    const event = usageEvent();
    event.row = { ...event.row, adjustment: true };
    assert.equal(contextUsedFromUsage(event), null);
  });

  test("无缓存时等于 input", () => {
    const event = usageEvent();
    event.row = { ...event.row, usage: { ...event.row.usage, cacheRead: 0, cacheWrite: 0 } };
    assert.equal(contextUsedFromUsage(event), 100);
  });
});

describe("buildUsageUpload", () => {
  test("正常事件逐字段映射", () => {
    const upload = buildUsageUpload(usageEvent(), "deepseek/v4", "fb", 1234);
    assert.deepEqual(upload, {
      type: "usage",
      kernelUsageId: "u-1",
      provider: "deepseek",
      model: "v4",
      input: 100,
      output: 20,
      cacheRead: 8,
      cacheWrite: 4,
      costUsd: 0.5,
      timestamp: 1234,
    });
  });

  test("adjustment 行被跳过（手工补记与历史导入不是新消耗）", () => {
    const event = usageEvent();
    event.row.adjustment = true;
    assert.equal(buildUsageUpload(event, "deepseek/v4", "fb", 1), null);
  });

  test("非主 lane 被跳过（子 agent 消耗不计入当前会话）", () => {
    const event = usageEvent();
    event.lane = "subagent";
    assert.equal(buildUsageUpload(event, "deepseek/v4", "fb", 1), null);
  });
});

describe("serializeArgs", () => {
  test("普通对象序列化", () => {
    assert.equal(serializeArgs({ command: "ls" }), '{"command":"ls"}');
  });

  test("undefined 序列化为 null 字面量", () => {
    assert.equal(serializeArgs(undefined), "null");
  });

  test("循环引用回退为 null 而非抛错", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.equal(serializeArgs(circular), null);
  });
});

describe("ToolCallTracker", () => {
  test("配对后带出入参、耗时与 runId", () => {
    const tracker = new ToolCallTracker();
    tracker.start("call-1", { command: "ls" }, 1000);
    const upload = tracker.end(endEvent(), 1070);

    assert.equal(upload?.toolCallId, "call-1");
    assert.equal(upload?.runId, "run-1");
    assert.equal(upload?.toolName, "bash");
    assert.equal(upload?.inputJson, '{"command":"ls"}');
    assert.equal(upload?.durationMs, 70);
    assert.equal(upload?.isError, false);
  });

  test("时间戳取开始时刻而非结束时刻", () => {
    const tracker = new ToolCallTracker();
    tracker.start("call-1", {}, 1000);
    const upload = tracker.end(endEvent(), 9999);
    assert.equal(upload?.timestamp, 1000);
  });

  test("并行工具按开始顺序排列，快工具先结束也不会插队", () => {
    const tracker = new ToolCallTracker();
    // bash 先发起但执行久，read 后发起却先结束
    tracker.start("bash-call", { command: "ls -la" }, 1000);
    tracker.start("read-call", { path: "demo.md" }, 1010);
    const readUpload = tracker.end(endEvent({ toolCallId: "read-call", toolName: "read" }), 1013);
    const bashUpload = tracker.end(endEvent({ toolCallId: "bash-call" }), 1072);

    assert.ok(
      bashUpload!.timestamp < readUpload!.timestamp,
      "先发起的 bash 时间戳应早于后发起的 read",
    );
  });

  test("未配对到 start 时耗时为 null，入参为 null", () => {
    const tracker = new ToolCallTracker();
    const upload = tracker.end(endEvent(), 5000);
    assert.equal(upload?.durationMs, null);
    assert.equal(upload?.inputJson, null);
    assert.equal(upload?.timestamp, 5000);
  });

  test("非主 lane 的工具调用被跳过", () => {
    const tracker = new ToolCallTracker();
    tracker.start("call-1", {}, 1000);
    assert.equal(tracker.end(endEvent({ lane: "subagent" }), 1010), null);
  });

  test("isError 原样带出", () => {
    const tracker = new ToolCallTracker();
    tracker.start("call-1", {}, 1);
    assert.equal(tracker.end(endEvent({ isError: true }), 2)?.isError, true);
  });

  test("配对后条目被释放，不会无限增长", () => {
    const tracker = new ToolCallTracker();
    tracker.start("call-1", {}, 1);
    assert.equal(tracker.size, 1);
    tracker.end(endEvent(), 2);
    assert.equal(tracker.size, 0);
  });

  test("未配对的 start 超过上限时淘汰最旧条目", () => {
    const tracker = new ToolCallTracker(3);
    for (let i = 0; i < 5; i += 1) tracker.start(`call-${i}`, {}, i);
    assert.equal(tracker.size, 3);
    // 最旧的 call-0 已被淘汰，配对时取不到 meta
    assert.equal(tracker.end(endEvent({ toolCallId: "call-0" }), 100)?.durationMs, null);
    // 较新的 call-4 仍在
    assert.equal(tracker.end(endEvent({ toolCallId: "call-4" }), 100)?.durationMs, 96);
  });

  test("非主 lane 也会清理缓存，避免条目滞留", () => {
    const tracker = new ToolCallTracker();
    tracker.start("call-1", {}, 1);
    tracker.end(endEvent({ lane: "subagent" }), 2);
    assert.equal(tracker.size, 0);
  });
});
