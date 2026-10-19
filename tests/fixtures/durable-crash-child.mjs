// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 崩溃恢复用例的**子进程**：真的在工具执行中 `process.exit`（不 close harness、不刷盘收尾），
 * 由父进程重新打开同一个 SQLite 库验证「pending 任务会被 resume」。
 *
 * 用法：node tests/fixtures/durable-crash-child.mjs <db> <marker> <safe|unsafe>
 *
 * 判据只依赖两件在父进程可观测的事实：
 *  - execute 被调用过（marker 追加一行）——`intent` 在 execute 之前已提交（内核文档保证）；
 *  - 退出码 17——父进程据此确认「这次是真崩，不是正常收尾」。
 */
import { appendFileSync, existsSync } from "node:fs";
import {
  Harness,
  createRegistry,
  defineExtension,
  defineTool,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";

const [db, marker, mode] = process.argv.slice(2);
if (db === undefined || marker === undefined || mode === undefined) {
  process.stderr.write("用法：node durable-crash-child.mjs <db> <marker> <safe|unsafe>\n");
  process.exit(2);
}

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);

const slow = defineTool({
  name: "slow",
  description: "记录一次执行后永不返回，供崩溃恢复用例使用",
  ...(mode === "safe" ? { replay: "safe" } : {}),
  parameters: Type.Object({ tag: Type.String() }),
  execute: async (args) => {
    appendFileSync(marker, `execute:${args.tag}\n`, "utf8");
    return await new Promise(() => {
      // 故意永不 settle：父进程在 marker 出现后杀掉本进程
    });
  },
});

const registry = createRegistry();
registry.install(defineExtension({ name: "crash-fixture", tools: [slow] }));

const harness = await Harness.open(
  await openNodeSqliteStorage(db, { busyTimeoutMs: 5_000 }),
  { models, registry },
  BACKGROUND_CONTEXT,
);
harness.resume();
const root = await harness.root(BACKGROUND_CONTEXT, {
  agent: {
    model: { provider: faux.provider.id, modelId: faux.getModel().id },
    cwd: process.cwd(),
  },
});

faux.setResponses([
  fauxAssistantMessage([fauxToolCall("slow", { tag: mode })], { stopReason: "toolUse" }),
]);
await root.submit(
  { type: "input", content: "go", requestId: `crash-${mode}` },
  BACKGROUND_CONTEXT,
);

const deadline = Date.now() + 10_000;
while (!existsSync(marker)) {
  if (Date.now() > deadline) {
    process.stderr.write("工具在 10s 内没有开始执行\n");
    process.exit(3);
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
}

// 不 close、不 dispose：模拟进程被直接干掉。intent 已在 execute 之前提交。
process.exit(17);
