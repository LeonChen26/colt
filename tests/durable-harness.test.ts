// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * pi-durable 内核接线的**最小端到端**用例（免模型、不出网、不计费）。
 *
 * 目的不是覆盖 Colt 的全部产品行为，而是先把几个**不能靠读文档确定**的事实钉住：
 *  1. `Harness.open → root → submit().wait()` 能跑完一轮，视图里能拿到 user/assistant 条目；
 *  2. 模型的 toolCall 会被 `ToolTask` 执行，结果以 `pi.tool-result` 条目落进视图；
 *  3. `ToolTask.beforeTool` 的 `block` 能让工具不执行，并给模型一个错误结果；
 *  4. `section()` 的提示词真的进入模型上下文（不是只注册、没人调用）。
 *
 * 这些是 worker 迁移的地基；任何一条不成立，后面的工具/审批/视图移植都会建在沙上。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import {
  Harness,
  MemoryStorage,
  ToolTask,
  createRegistry,
  defineExtension,
  defineTool,
  hook,
  section,
  type ConversationView,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createWriteTool } from "@earendil-works/pi-durable/tools";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { createGuardedReadTool } from "../src/worker/lib/read-guard.ts";

function textOf(message: { content?: unknown } | undefined): string {
  if (message === undefined) return "";
  // UserMessage 的 content 允许是纯字符串；AssistantMessage 是内容块数组。
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((block): block is { type: "text"; text: string } => {
      return typeof block === "object" && block !== null && (block as { type?: string }).type === "text";
    })
    .map((block) => block.text)
    .join("");
}

function entryText(view: ConversationView, kind: string): string {
  const entry = view.entries.find((item) => item.kind === kind);
  return textOf(entry?.model?.[0] as { content?: unknown } | undefined);
}

async function openHarness(options: { blockTool?: boolean } = {}) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);

  const seen: string[] = [];
  const echo = defineTool({
    name: "echo",
    description: "把输入原样返回，用于验证工具链路",
    parameters: Type.Object({ text: Type.String() }),
    execute: async (args) => ({
      output: [{ type: "text", text: `echo:${args.text}` }],
      details: { text: args.text },
    }),
  });

  const extension = defineExtension({
    name: "test-extension",
    tools: [echo],
    sections: [section("test-system", () => "DURABLE_SECTION_SENTINEL", { tag: false })],
    hooks: [
      hook(ToolTask, {
        beforeTool: (call) => {
          seen.push(call.name);
          return options.blockTool === true ? { block: "测试拦截" } : undefined;
        },
      }),
    ],
  });

  const registry = createRegistry();
  registry.install(extension);

  const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
  harness.resume();
  const root = await harness.root(BACKGROUND_CONTEXT, {
    agent: {
      model: { provider: faux.provider.id, modelId: faux.getModel().id },
      cwd: process.cwd(),
    },
  });

  return { harness, root, faux, seen };
}

describe("pi-durable 最小接线", () => {
  test("一轮对话：视图里有 user / assistant，section 真的进了上下文", async () => {
    const { harness, root, faux } = await openHarness();
    try {
      faux.setResponses([fauxAssistantMessage("你好，我是测试模型。")]);
      const submission = await root.submit(
        { type: "input", content: "你好" },
        BACKGROUND_CONTEXT,
      );
      const settled = await submission.wait(BACKGROUND_CONTEXT);
      assert.equal(settled.status, "done");

      const view = await root.viewState(BACKGROUND_CONTEXT);
      try {
        assert.equal(entryText(view.value, "pi.user"), "你好");
        assert.equal(entryText(view.value, "pi.assistant"), "你好，我是测试模型。");

        // section 是位置化 system entry；模型请求里能读到它。
        const context = await root.context(BACKGROUND_CONTEXT);
        const systemText = context.messages
          .filter((message) => message.role === "system")
          .map((message) => {
            const system = message as { content?: unknown; sections?: Record<string, string | null> };
            return [
              textOf(system as { content?: unknown }),
              ...Object.values(system.sections ?? {}).filter((value): value is string => typeof value === "string"),
            ].join("\n");
          })
          .join("\n");
        assert.ok(
          systemText.includes("DURABLE_SECTION_SENTINEL"),
          `section 必须真的进入请求上下文，实得：${systemText.slice(0, 200)}`,
        );
      } finally {
        view.dispose();
      }
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  });

  test("工具调用：ToolTask 执行，结果以 pi.tool-result 落进视图", async () => {
    const { harness, root, faux, seen } = await openHarness();
    try {
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("echo", { text: "a" })], { stopReason: "toolUse" }),
        fauxAssistantMessage("工具已完成。"),
      ]);
      const submission = await root.submit(
        { type: "input", content: "调用工具" },
        BACKGROUND_CONTEXT,
      );
      const settled = await submission.wait(BACKGROUND_CONTEXT);
      assert.equal(settled.status, "done");
      assert.deepEqual(seen, ["echo"]);

      const view = await root.viewState(BACKGROUND_CONTEXT);
      try {
        assert.equal(entryText(view.value, "pi.tool-result"), "echo:a");
      } finally {
        view.dispose();
      }
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  });

  test("beforeTool 的 block 真的拦下工具，并让模型看到错误结果", async () => {
    const { harness, root, faux, seen } = await openHarness({ blockTool: true });
    try {
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("echo", { text: "a" })], { stopReason: "toolUse" }),
        fauxAssistantMessage("工具被拦截了。"),
      ]);
      const submission = await root.submit(
        { type: "input", content: "调用工具" },
        BACKGROUND_CONTEXT,
      );
      await submission.wait(BACKGROUND_CONTEXT);
      assert.deepEqual(seen, ["echo"]);

      const view = await root.viewState(BACKGROUND_CONTEXT);
      try {
        const result = view.value.entries.find((entry) => entry.kind === "pi.tool-result");
        const message = result?.model?.[0] as
          | { content?: unknown; isError?: boolean }
          | undefined;
        assert.equal(message?.isError, true);
        assert.ok(textOf(message).includes("测试拦截"));
      } finally {
        view.dispose();
      }
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  });

  test("内置 coding 工具真的落到磁盘：`HarnessOptions.env` 的接线不能断", async () => {
    // 这条防的是「工具注册了、env 没接」这类**静默失败**：durable 的 read / write 都从
    // `api.env` 取执行环境，漏了 `HarnessOptions.env` 时工具只是报错，不会有人注意到。
    // 判据取磁盘上的真实内容 + 模型收到的 read 结果，而不是「工具被调用过」。
    const dir = mkdtempSync(join(tmpdir(), "colt-coding-tools-"));
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    registry.install(
      defineExtension({
        name: "coding",
        tools: [createWriteTool(), createGuardedReadTool(dir)],
      }),
    );
    const harness = await Harness.open(
      new MemoryStorage(),
      { models, registry, env: (target) => new NodeExecutionEnv({ cwd: target.cwd ?? dir }) },
      BACKGROUND_CONTEXT,
    );
    try {
      harness.resume();
      const root = await harness.root(BACKGROUND_CONTEXT, {
        agent: {
          model: { provider: faux.provider.id, modelId: faux.getModel().id },
          cwd: dir,
        },
      });
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("write", { path: "a.txt", content: "hello\n" })], {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage([fauxToolCall("read", { path: "a.txt" })], { stopReason: "toolUse" }),
        fauxAssistantMessage("done"),
      ]);
      const submission = await root.submit({ type: "input", content: "写再读" }, BACKGROUND_CONTEXT);
      await submission.wait(BACKGROUND_CONTEXT);

      assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "hello\n", "write 必须真的落盘");

      const view = await root.viewState(BACKGROUND_CONTEXT);
      try {
        const results = view.value.entries
          .filter((entry) => entry.kind === "pi.tool-result")
          .map((entry) => entry.model?.[0] as { content?: unknown } | undefined);
        assert.equal(results.length, 2, "两次工具调用都要有结果");
        assert.ok(textOf(results[1]).includes("hello"), "read 的内容要回到模型");
      } finally {
        view.dispose();
      }
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("head write 是回卷、fork 才是分支：两者语义必须分开", async () => {
    const { harness, root, faux } = await openHarness();
    try {
      faux.setResponses([fauxAssistantMessage("A1"), fauxAssistantMessage("A2")]);
      await (await root.submit({ type: "input", content: "one" }, BACKGROUND_CONTEXT)).wait(
        BACKGROUND_CONTEXT,
      );
      await (await root.submit({ type: "input", content: "two" }, BACKGROUND_CONTEXT)).wait(
        BACKGROUND_CONTEXT,
      );

      const before = await root.viewState(BACKGROUND_CONTEXT);
      const assistants = before.value.entries.filter((entry) => entry.kind === "pi.assistant");
      before.dispose();
      assert.equal(assistants.length, 2);
      const firstAssistant = assistants[0]!.id;

      // head 指向 A1：active 范围从 A1 开始，但 A2 仍然在范围内——这是「回卷」，不是「砍掉未来」。
      await root.commit(
        (tx) => tx.appendEntry(root.id, { kind: "app.rewind", head: firstAssistant }),
        BACKGROUND_CONTEXT,
      );
      const rewound = await root.viewState(BACKGROUND_CONTEXT);
      try {
        assert.equal(
          rewound.value.entries.filter((entry) => entry.kind === "pi.assistant").length,
          2,
          "head write 不会隐藏目标之后的条目",
        );
      } finally {
        rewound.dispose();
      }

      // 真正的「从这里分叉」是 fork：新 conversation 只继承到 A1。
      const forked = await root.fork(
        firstAssistant,
        { ownership: { kind: "ownerless" } },
        BACKGROUND_CONTEXT,
      );
      const forkView = await forked.viewState(BACKGROUND_CONTEXT);
      try {
        const forkAssistants = forkView.value.entries.filter(
          (entry) => entry.kind === "pi.assistant",
        );
        assert.equal(forkAssistants.length, 1);
        assert.equal(textOf(forkAssistants[0]?.model?.[0] as { content?: unknown }), "A1");
      } finally {
        forkView.dispose();
      }
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  });
});
