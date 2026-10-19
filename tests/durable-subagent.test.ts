// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * durable 子代理的端到端接线（免模型、不出网、不计费）。
 *
 * 钉住四件事：
 *  1. 主模型的 `subagent` 调用会**真的建出一个子对话**，并在里面跑完一轮；
 *  2. 子对话拿到的是定义正文（+ AGENTS.md），而不是主对话那套记忆 / 技能提示词；
 *  3. 工具面是**硬白名单**，`subagent` 自己不在里面（递归在结构上不可达）；
 *  4. 返回给主模型的是「结论 + 过程收据」，视图与完整流都能读到这次子代理。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import {
  Harness,
  MemoryStorage,
  createRegistry,
  defineExtension,
  defineTool,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";

import { DurableSubagents, conversationIdOfRunId } from "../src/worker/durable/subagent";
import type { AgentDef } from "../src/worker/lib/agent-defs";

const context = BACKGROUND_CONTEXT;

function textOf(message: { content?: unknown } | undefined): string {
  if (message === undefined) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((block): block is { type: "text"; text: string } => {
      return typeof block === "object" && block !== null && (block as { type?: string }).type === "text";
    })
    .map((block) => block.text)
    .join("");
}

function researcher(): AgentDef {
  return {
    name: "researcher",
    description: "只读调研员",
    tools: ["echo"],
    model: null,
    body: "RESEARCHER_BODY_SENTINEL",
    source: "builtin",
    path: "builtin",
  };
}

async function openHarness() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);

  const echo = defineTool({
    name: "echo",
    description: "把输入原样返回",
    parameters: Type.Object({ text: Type.String() }),
    execute: async (args) => ({
      output: [{ type: "text", text: `echo:${args.text}` }],
      details: { text: args.text },
    }),
  });
  const forbidden = defineTool({
    name: "forbidden",
    description: "不该被子代理看到",
    parameters: Type.Object({}),
    execute: async () => ({ output: [{ type: "text", text: "ran" }], details: null }),
  });

  const registry = createRegistry();
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
  harness.resume();

  let mainId: number | undefined;
  const subagents = new DurableSubagents({
    defs: [researcher()],
    cwd: process.cwd(),
    agentsMd: async () => "AGENTS_MD_SENTINEL",
    mainConversationId: () => mainId as never,
    harness: () => harness,
    ensureModel: async () => undefined,
    onUpdate: () => undefined,
  });

  registry.install(
    defineExtension({
      name: "colt-test",
      tools: [echo, forbidden, subagents.tool()],
    }),
  );

  const root = await harness.root(context, {
    agent: {
      model: { provider: faux.provider.id, modelId: faux.getModel().id },
      cwd: process.cwd(),
    },
  });
  mainId = root.id;
  return { harness, root, faux, subagents };
}

describe("durable 子代理", () => {
  test("委派会建出子对话，按定义白名单与提示词跑完，并回传收据", async () => {
    const { harness, root, faux, subagents } = await openHarness();
    try {
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("subagent", { agent: "researcher", task: "查一件事" })], {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("子代理结论：查到了。"),
        fauxAssistantMessage("主对话完成。"),
      ]);

      const settled = await (
        await root.submit({ type: "input", content: "去委派" }, context)
      ).wait(context);
      assert.equal(settled.status, "done");

      const runs = subagents.toView();
      assert.equal(runs.length, 1);
      const run = runs[0]!;
      assert.equal(run.name, "researcher");
      assert.equal(run.status, "completed");
      assert.equal(run.toolCallId.length > 0, true);
      assert.ok(run.tail.stepCount >= 2, `子代理流里应有 user + assistant，实得 ${run.tail.stepCount}`);

      // 子对话的 agent：定义正文 + AGENTS.md，工具面只有白名单里的那一个
      const conversationId = conversationIdOfRunId(run.id);
      assert.notEqual(conversationId, undefined);
      const child = await harness.conversation(conversationId!, context);
      assert.notEqual(child, undefined);
      const agent = await child!.agent(context);
      assert.ok(agent.instructions?.includes("RESEARCHER_BODY_SENTINEL"));
      assert.ok(agent.instructions?.includes("AGENTS_MD_SENTINEL"));
      assert.deepEqual(
        agent.tools.map((tool) => tool.name),
        ["echo"],
        "工具面必须是硬白名单，且不含 subagent 自己",
      );

      // 完整流按需可读（视图里只有有界尾部）
      const transcript = await subagents.transcript(run.id, context);
      assert.notEqual(transcript, undefined);
      const texts = transcript!
        .map((entry) => textOf((entry as { message?: { content?: unknown } }).message))
        .filter((text) => text !== "");
      assert.ok(texts.includes("查一件事"));
      assert.ok(texts.includes("子代理结论：查到了。"));

      // 主模型拿到的是「结论 + 过程收据」，不是子代理的原文流
      const main = await root.context(context);
      const toolResult = main.messages.find((message) => message.role === "toolResult");
      const resultText = textOf(toolResult as { content?: unknown });
      assert.ok(resultText.includes("子代理结论：查到了。"), resultText);
      assert.ok(resultText.includes("已完成"), resultText);
    } finally {
      subagents.dispose();
      await harness.close(context);
    }
  });

  test("子代理不能再委派：非主对话发起的调用直接被拒", async () => {
    const { harness, root, subagents } = await openHarness();
    try {
      const tool = subagents.tool();
      const child = await harness.createConversation(
        { ownership: { kind: "ownerless" } },
        context,
      );
      await assert.rejects(
        tool.execute(
          { agent: "researcher", task: "再委派一次" } as never,
          { taskId: 1, conversationId: child.id, callId: "call-1" } as never,
          context,
        ),
        /只允许一层/,
      );
      assert.equal(subagents.toView().length, 0);
      assert.notEqual(root, undefined);
    } finally {
      subagents.dispose();
      await harness.close(context);
    }
  });
});
