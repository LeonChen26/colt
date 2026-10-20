// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 界面历史缓存：全量读一遍 + 之后只追加。
 *
 * 这两个函数决定「压缩之后用户还能不能看到历史」，所以边界必须钉住：
 * 分页要按升序拼完整、追加要去重且不改顺序、没有新条目时返回 false（不触发重投影）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { appendDisplayEntries, loadDisplayState } from "../src/worker/durable/display.ts";

const entry = (id: number): EntryRecord =>
  ({
    id,
    conversationId: 1,
    kind: "pi.user",
    model: [{ role: "user", content: `m${id}` }],
  }) as never;

describe("display 缓存", () => {
  test("loadDisplayState 分页读完并按升序拼起来（不依赖单页能装下）", async () => {
    const all = [entry(1), entry(2), entry(3), entry(4), entry(5)];
    const cursors: unknown[] = [];
    const storage = {
      async scanEntries(
        query: { order?: string },
        _limit: number,
        cursor: { index: number } | undefined,
      ) {
        assert.equal(query.order, "ascending", "必须从旧到新读");
        cursors.push(cursor);
        const start = cursor?.index ?? 0;
        const items = all.slice(start, start + 2);
        const next = start + items.length < all.length ? { index: start + items.length } : undefined;
        return { items, next };
      },
    };

    const display = await loadDisplayState(storage as never, 1 as never, {} as never);
    assert.deepEqual(
      display.entries.map((item) => item.id),
      [1, 2, 3, 4, 5],
    );
    assert.equal(display.known.size, 5);
    assert.equal(cursors.length, 3, "5 条按每页 2 条读 = 3 次往返");
  });

  test("appendDisplayEntries 只加新条目、保序、可判「没变化」", () => {
    const display = { entries: [entry(1), entry(2)], known: new Set(["1", "2"]) };

    // 压缩会重复带来已有的条目（view.entries 的头部），不能重复入列
    assert.equal(appendDisplayEntries(display, [entry(2), entry(3)]), true);
    assert.deepEqual(
      display.entries.map((item) => item.id),
      [1, 2, 3],
    );
    assert.equal(appendDisplayEntries(display, [entry(1), entry(2)]), false, "没有新条目 → 不重投影");
    assert.deepEqual(
      display.entries.map((item) => item.id),
      [1, 2, 3],
    );
  });
});
