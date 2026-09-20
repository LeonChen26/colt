/**
 * 子代理视图投影的测试（`src/worker/lib/subagent-view.ts`）。
 *
 * 两条核心口径：
 *   1. **有界**：视图每 50ms 整份重推，尾部必须有上限（`MAX_SUBAGENT_STEPS_IN_VIEW`）——
 *      否则 N 个子代理的全文开销会按推送次数乘上去。
 *   2. **截断必须如实**：给了上限，就必须同时给出**真实总步数**，否则界面上的
 *      「最近 12 步」会被读成「一共 12 步」（`docs/ERRORS.md`：静默截断不行）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { LaneSnapshot } from "@earendil-works/pi-agent-core";
import {
  MAX_SUBAGENT_STEPS_IN_VIEW,
  projectSubagent,
} from "../src/worker/lib/subagent-view.ts";

const message = (id: string, text: string): unknown => ({
  type: "message",
  id,
  message: { role: "assistant", content: [{ type: "text", text }], timestamp: 1 },
});

const snapshot = (input: {
  transcript: unknown[];
  streamingMessage?: unknown;
  runningTools?: unknown[];
}): LaneSnapshot =>
  ({
    transcript: input.transcript,
    operation:
      input.streamingMessage === undefined && input.runningTools === undefined
        ? undefined
        : { streamingMessage: input.streamingMessage, runningTools: input.runningTools ?? [] },
  }) as unknown as LaneSnapshot;

const base = {
  id: "sub:researcher:abcd1234",
  toolCallId: "call_sub",
  name: "researcher",
  title: "查一下 read 工具在哪注册",
  status: "running" as const,
  startedAt: 100,
  stats: { inputTokens: 10, outputTokens: 2, costUsd: 0.01 },
};

describe("projectSubagent：尾部有界且截断如实", () => {
  test("正常投影：步数、状态、身份逐字段带出", () => {
    const view = projectSubagent({
      ...base,
      snapshot: snapshot({ transcript: [message("m1", "第一条"), message("m2", "第二条")] }),
    });
    assert.equal(view.id, base.id);
    assert.equal(view.toolCallId, base.toolCallId);
    assert.equal(view.name, "researcher");
    assert.equal(view.title, base.title);
    assert.equal(view.status, "running");
    assert.equal(view.startedAt, 100);
    assert.equal(view.tail.stepCount, 2);
    assert.equal(view.tail.recentSteps.length, 2);
  });

  test("超过上限时只留最近 N 步，但**总步数如实给出**", () => {
    const transcript = Array.from({ length: 20 }, (_, index) => message(`m${index}`, `${index}`));
    const view = projectSubagent({ ...base, snapshot: snapshot({ transcript }) });
    assert.equal(view.tail.recentSteps.length, MAX_SUBAGENT_STEPS_IN_VIEW);
    assert.equal(view.tail.stepCount, 20, "截断了却把总数也报成 12，就是在撒谎");
    // 留下的必须是**最近**的（最后一条仍在，最早一条已不在）
    assert.ok(view.tail.recentSteps.some((item) => item.id === "m19"));
    assert.ok(!view.tail.recentSteps.some((item) => item.id === "m0"));
  });

  test("流式中的文本与思考进尾部，没有流式操作时为 null", () => {
    const streaming = projectSubagent({
      ...base,
      snapshot: snapshot({
        transcript: [],
        streamingMessage: {
          content: [
            { type: "text", text: "正在写结论" },
            { type: "thinking", thinking: "先定位注册点" },
          ],
        },
      }),
    });
    assert.equal(streaming.tail.streamingText, "正在写结论");
    assert.equal(streaming.tail.thought, "先定位注册点");

    const idle = projectSubagent({ ...base, snapshot: snapshot({ transcript: [] }) });
    assert.equal(idle.tail.streamingText, null);
    assert.equal(idle.tail.thought, null);
  });

  test("运行中的工具进尾部（④ 卡的预览靠它说「在干什么」）", () => {
    const view = projectSubagent({
      ...base,
      snapshot: snapshot({
        transcript: [],
        runningTools: [
          {
            toolCallId: "t1",
            toolName: "read",
            args: { path: "a.ts" },
            result: { content: [{ type: "text", text: "读到的内容" }] },
            startedAt: 10,
          },
        ],
      }),
    });
    assert.equal(view.tail.runningTools.length, 1);
    assert.equal(view.tail.runningTools[0]?.id, "t1");
    assert.equal(view.tail.runningTools[0]?.name, "read");
    assert.equal(view.tail.runningTools[0]?.output, "读到的内容");
  });

  test("可选字段（endedAt / error）没有就不产出该键，有就带出", () => {
    const running = projectSubagent({ ...base, snapshot: snapshot({ transcript: [] }) });
    assert.equal("endedAt" in running, false);
    assert.equal("error" in running, false);

    const failed = projectSubagent({
      ...base,
      status: "failed",
      endedAt: 200,
      error: "连接被拒",
      snapshot: snapshot({ transcript: [] }),
    });
    assert.equal(failed.endedAt, 200);
    assert.equal(failed.error, "连接被拒");
  });

  test("统计是**复制**一份，不与输入共享引用（免得后续累加改到调用方的对象）", () => {
    const stats = { inputTokens: 10, outputTokens: 2, costUsd: 0.01 };
    const view = projectSubagent({ ...base, stats, snapshot: snapshot({ transcript: [] }) });
    assert.deepEqual(view.stats, stats);
    assert.notStrictEqual(view.stats, stats);
  });
});

/**
 * 单步耗时是**同一件事在两处**（有界预览 / 完整流 `session.subagentTranscript`）都要给的量。
 * 预览侧曾经恒用空表，于是同一张卡展开看得到耗时、点进下钻却看不到——口径不一致看起来
 * 像「预览坏了」。这两条钉住「给不给耗时表」的两种结果，且都先断言**确实造出了工具调用**：
 * 否则夹具形态一旦不对，断言会变成「必然为真」，比删掉它更贵。
 */
describe("预览里的工具耗时与完整流同源", () => {
  const stepWithCall = (toolCallId: string): unknown => ({
    type: "message",
    id: `m-${toolCallId}`,
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "a.ts" } }],
      timestamp: 1,
    },
  });

  test("给了耗时表：预览里的 toolCalls 带上 durationMs", () => {
    const view = projectSubagent({
      ...base,
      snapshot: snapshot({ transcript: [stepWithCall("call_1")] }),
      durations: new Map([["call_1", 123]]),
    });
    const calls = view.tail.recentSteps[0]?.toolCalls ?? [];
    assert.equal(calls.length, 1, "夹具没产出工具调用，这条断言会必然为真——先修夹具");
    assert.equal(calls[0]?.durationMs, 123);
  });

  test("不给耗时表：字段缺省（没测到就不编一个耗时）", () => {
    const view = projectSubagent({
      ...base,
      snapshot: snapshot({ transcript: [stepWithCall("call_2")] }),
    });
    const calls = view.tail.recentSteps[0]?.toolCalls ?? [];
    assert.equal(calls.length, 1, "夹具没产出工具调用，这条断言会必然为真——先修夹具");
    assert.equal(calls[0]?.durationMs, undefined);
  });
});
