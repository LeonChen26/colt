// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * durable 记忆整理：用一条独立子对话跑，结果必须有出口（通知 / 报错）。
 * 免模型、不出网；记忆文件放在临时目录里，不碰用户数据。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
} from "@earendil-works/pi-ai";

import { runMemoryTidy } from "../src/worker/durable/memory-tidy";

const context = BACKGROUND_CONTEXT;

function tools() {
  return [
    defineTool({
      name: "read",
      description: "读文件",
      parameters: Type.Object({ path: Type.String() }),
      execute: async () => ({ output: [{ type: "text", text: "read" }], details: null }),
    }),
    defineTool({
      name: "write",
      description: "写文件",
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      execute: async () => ({ output: [{ type: "text", text: "written" }], details: null }),
    }),
    defineTool({
      name: "memory_search",
      description: "检索记忆",
      parameters: Type.Object({ query: Type.String() }),
      execute: async () => ({ output: [{ type: "text", text: "[]" }], details: null }),
    }),
    defineTool({
      name: "bash",
      description: "不该出现在白名单里",
      parameters: Type.Object({ command: Type.String() }),
      execute: async () => ({ output: [{ type: "text", text: "ran" }], details: null }),
    }),
  ];
}

async function openHarness() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(defineExtension({ name: "tidy-test", tools: tools() }));
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
  harness.resume();
  const root = await harness.root(context, {
    agent: {
      model: { provider: faux.provider.id, modelId: faux.getModel().id },
      cwd: process.cwd(),
    },
  });
  return { harness, root, faux, registry };
}

describe("durable 记忆整理", () => {
  test("跑在独立子对话里，完成后重报索引并给通知", async () => {
    const dir = await mkdtemp(join(tmpdir(), "colt-tidy-"));
    const { harness, faux, registry } = await openHarness();
    try {
      await mkdir(join(dir, ".colt"), { recursive: true });
      await writeFile(join(dir, ".colt", "memory.md"), "- 早先沉淀的一条事实\n", "utf8");
      faux.setResponses([fauxAssistantMessage("合并 0 条，删除 0 条，保留 1 条。")]);

      const indexed: { scope: string; content: string | null }[] = [];
      const outcome = await runMemoryTidy(
        {
          harness,
          cwd: dir,
          model: { provider: faux.provider.id, modelId: faux.getModel().id },
          tools: registry.snapshot().tools().map((entry) => entry.tool),
          reportMemoryIndex: (scope, content) => indexed.push({ scope, content }),
        },
        context,
      );

      assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.message);
      if (outcome.ok) assert.ok(outcome.notice.includes("记忆整理完成"), outcome.notice);
      assert.equal(indexed.length, 1);
      assert.equal(indexed[0]?.scope, "project");
      assert.ok(indexed[0]?.content?.includes("早先沉淀的一条事实"));
    } finally {
      await harness.close(context);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("白名单工具缺失时明确报错，不静默跳过", async () => {
    const { harness, registry, faux } = await openHarness();
    try {
      const outcome = await runMemoryTidy(
        {
          harness,
          cwd: process.cwd(),
          model: { provider: faux.provider.id, modelId: faux.getModel().id },
          tools: registry
            .snapshot()
            .tools()
            .map((entry) => entry.tool)
            .filter((tool) => tool.name !== "write"),
          reportMemoryIndex: () => undefined,
        },
        context,
      );
      assert.equal(outcome.ok, false);
      if (!outcome.ok) assert.ok(outcome.message.includes("write"), outcome.message);
    } finally {
      await harness.close(context);
    }
  });
});
