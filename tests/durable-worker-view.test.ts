// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * durable worker 的纯逻辑：`projectDurableView` —— durable 的条目 / 文档 →
 * 渲染层的 `ConversationView`。
 *
 * 这是「换内核但界面与工具行为不变」的关键接缝。它不依赖 Electron / 网络，
 * 用 faux provider 与一个假工具就能钉住；跑真 worker 只能验证「进程起得来」，
 * 验证不了这些逐字段的映射。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import {
  Harness,
  MemoryStorage,
  ToolTask,
  createRegistry,
  defineExtension,
  defineTool,
  hook,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";

import { durableTranscript, projectDurableView } from "../src/worker/durable/project.ts";
import type { ConversationView } from "../src/shared/worker-protocol.ts";

const meta = {
  sessionId: "s1",
  cwd: process.cwd(),
  model: "faux/faux-model",
  imageInput: false,
  thinkingLevel: "high" as const,
  skills: [],
  fileChanges: [],
  todos: [],
  lastRun: null,
  subagents: [],
};

async function conversationWithTool() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);

  const echo = defineTool({
    name: "echo",
    description: "回显",
    parameters: Type.Object({ text: Type.String() }),
    execute: async (args) => ({
      output: [{ type: "text", text: `echo:${args.text}` }],
      details: { text: args.text },
    }),
  });
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "test",
      tools: [echo],
      hooks: [hook(ToolTask, { beforeTool: () => undefined })],
    }),
  );

  const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
  harness.resume();
  const root = await harness.root(BACKGROUND_CONTEXT, {
    agent: {
      model: { provider: faux.provider.id, modelId: faux.getModel().id },
      cwd: process.cwd(),
    },
  });
  return { harness, root, faux };
}

describe("durable → ConversationView 投影", () => {
  test("user / assistant / tool-result 都投影成渲染层认识的两列", async () => {
    const { harness, root, faux } = await conversationWithTool();
    try {
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("echo", { text: "a" })], { stopReason: "toolUse" }),
        fauxAssistantMessage("工具已完成。"),
      ]);
      await (
        await root.submit({ type: "input", content: "调用工具" }, BACKGROUND_CONTEXT)
      ).wait(BACKGROUND_CONTEXT);

      const state = await root.viewState(BACKGROUND_CONTEXT);
      const view = projectDurableView(state.value, {
        ...meta,
        cwd: process.cwd(),
      });
      state.dispose();

      assert.deepEqual(
        view.messages.map((message) => message.role),
        ["user", "assistant", "assistant"],
      );
      assert.equal(view.messages[0]?.text, "调用工具");
      // 第一条助手消息带工具调用；耗时来自 ToolResultMessage.durationMs（可能缺省）
      assert.equal(view.messages[1]?.toolCalls[0]?.name, "echo");
      assert.equal(view.messages[2]?.text, "工具已完成。");
      // 工具结果只进 toolResults，不再塞进 messages
      assert.equal(view.toolResults.length, 1);
      assert.equal(view.toolResults[0]?.output, "echo:a");
      assert.equal(view.toolResults[0]?.isError, false);
      // 统计：user + assistant + tool-result + assistant = 4 条，空闲、没有流式文本
      assert.equal(view.stats.messageCount, 4);
      assert.equal(view.running, false);
      assert.equal(view.streamingText, null);
      assert.equal(view.queuedCount, 0);
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  });

  test("durableTranscript 跳过 pi.system，保留压缩条目的摘要正文", () => {
    const entries = [
      {
        id: 1 as never,
        conversationId: 1 as never,
        kind: "pi.system",
        model: [{ role: "system", content: "", timestamp: 1 } as never],
      },
      {
        id: 2 as never,
        conversationId: 1 as never,
        kind: "pi.user",
        model: [{ role: "user", content: "你好", timestamp: 2 } as never],
      },
      {
        id: 3 as never,
        conversationId: 1 as never,
        kind: "pi.compaction",
        data: { reason: "manual" } as never,
        model: [
          {
            role: "user",
            content: "这是摘要正文",
            timestamp: 3,
          } as never,
        ],
      },
    ];
    const transcript = durableTranscript(entries);
    assert.equal(transcript.length, 2);
    assert.deepEqual(
      transcript.map((entry) => (entry as { type: string }).type),
      ["message", "compaction"],
    );
    assert.equal(
      (transcript[1] as { summary: string }).summary,
      "这是摘要正文",
      "压缩摘要的 content 是字符串，也必须读出来",
    );
  });

  test("空会话也不炸：所有集合为空、统计为零", async () => {
    const { harness, root } = await conversationWithTool();
    try {
      const state = await root.viewState(BACKGROUND_CONTEXT);
      const view: ConversationView = projectDurableView(state.value, {
        ...meta,
        cwd: process.cwd(),
      });
      state.dispose();
      assert.deepEqual(view.messages, []);
      assert.deepEqual(view.toolResults, []);
      assert.equal(view.stats.messageCount, 0);
      assert.equal(view.stats.promptTokens, 0);
      assert.equal(view.lastRun, null);
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  });
});
