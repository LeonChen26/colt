// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 「分叉到新会话」的存储前提。
 *
 * 产品链路是「复制源库快照 → 在新会话的副本里 fork」，这里钉住两件不能靠读文档确定的事：
 *   1. `VACUUM INTO` 复制到的包含**已在 WAL 里提交**的数据（源 worker 关闭后 WAL 未必清空）；
 *   2. 复制出来的库仍能按**同一个条目 id** 分叉，而且分叉只看到目标条目的前缀。
 *
 * 第 2 条是整条链路的地基：如果复制会换掉条目 id，新 worker 的 `init.forkAt` 就找不到目标，
 * 分叉按钮会以一个与现场无关的报错收场。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Harness, createRegistry, type EntryId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { copySessionDatabase } from "../src/main/session-fork.ts";
import { makeTempDir, removeTempDir } from "./helpers/temp.ts";

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

describe("会话分叉的库快照", () => {
  test("WAL 里已提交的数据也会进副本", () => {
    const dir = makeTempDir("colt-session-fork-");
    try {
      const source = join(dir, "source.db");
      const destination = join(dir, "destination.db");
      const db = new DatabaseSync(source);
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("CREATE TABLE notes (text TEXT)");
      db.prepare("INSERT INTO notes (text) VALUES (?)").run("已提交");
      // 故意不 close：数据此刻可能还留在 -wal 里，正是要验的场景
      copySessionDatabase(source, destination);
      db.close();

      const copy = new DatabaseSync(destination, { readOnly: true });
      try {
        const row = copy.prepare("SELECT text FROM notes").get() as { text: string };
        assert.equal(row.text, "已提交");
      } finally {
        copy.close();
      }
    } finally {
      removeTempDir(dir);
    }
  });

  test("复制后的库仍能按同一条目 id 分叉，且只看到目标条目之前的历史", async () => {
    const dir = makeTempDir("colt-session-fork-harness-");
    const sourcePath = join(dir, "source.db");
    const copyPath = join(dir, "copy.db");
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    try {
      const sourceStorage = await openNodeSqliteStorage(sourcePath, { busyTimeoutMs: 5_000 });
      const source = await Harness.open(
        sourceStorage,
        { models, registry: createRegistry() },
        BACKGROUND_CONTEXT,
      );
      source.resume();
      const root = await source.root(BACKGROUND_CONTEXT, {
        agent: {
          model: { provider: faux.provider.id, modelId: faux.getModel().id },
          cwd: dir,
        },
      });

      faux.setResponses([fauxAssistantMessage("第一答"), fauxAssistantMessage("第二答")]);
      const first = await root.submit({ type: "input", content: "第一问" }, BACKGROUND_CONTEXT);
      assert.equal((await first.wait(BACKGROUND_CONTEXT)).status, "done");

      const view = await root.viewState(BACKGROUND_CONTEXT);
      let firstAnswerId: EntryId | undefined;
      try {
        firstAnswerId = view.value.entries.find((entry) => entry.kind === "pi.assistant")?.id;
      } finally {
        view.dispose();
      }
      assert.ok(firstAnswerId !== undefined, "第一轮必须留下一条 pi.assistant 条目");

      const second = await root.submit({ type: "input", content: "第二问" }, BACKGROUND_CONTEXT);
      assert.equal((await second.wait(BACKGROUND_CONTEXT)).status, "done");
      const rootId = root.id;
      await source.close(BACKGROUND_CONTEXT);

      copySessionDatabase(sourcePath, copyPath);

      const copyStorage = await openNodeSqliteStorage(copyPath, { busyTimeoutMs: 5_000 });
      const copy = await Harness.open(
        copyStorage,
        { models, registry: createRegistry() },
        BACKGROUND_CONTEXT,
      );
      try {
        const parent = await copy.conversation(rootId, BACKGROUND_CONTEXT);
        assert.ok(parent !== undefined, "副本里必须还能按原对话 id 打开父对话");

        const forked = await parent.fork(
          firstAnswerId,
          { ownership: { kind: "ownerless" } },
          BACKGROUND_CONTEXT,
        );
        const context = await forked.context(BACKGROUND_CONTEXT);
        const users = context.entries
          .filter((entry) => entry.kind === "pi.user")
          .map((entry) => textOf(entry.model?.[0] as { content?: unknown } | undefined));
        const assistants = context.entries
          .filter((entry) => entry.kind === "pi.assistant")
          .map((entry) => textOf(entry.model?.[0] as { content?: unknown } | undefined));

        assert.deepEqual(users, ["第一问"], "分叉只继承到目标条目为止的提问");
        assert.deepEqual(assistants, ["第一答"], "目标条目本身（第一轮的最终回复）要在分叉里");
      } finally {
        await copy.close(BACKGROUND_CONTEXT);
      }
    } finally {
      removeTempDir(dir);
    }
  });
});
