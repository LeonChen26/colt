/**
 * 会话列表合并的行为测试（`src/renderer/src/lib/session.ts`）。
 *
 * 回归背景：`session.list` 只读库，而**草稿**（`session.create` 返回、首次发消息才落库）
 * 不在库里。`loadProjectSessions` 原先拿它的结果**整份替换**本地缓存，于是草稿会在
 * 一次刷新后从侧栏消失、用户再也点不回来 —— 切项目来回、或删同项目其它会话都会触发。
 *
 * 这里测的是**行为**（喂进去、看拼出来什么），不是源码长什么样。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isDraftSession, mergeSessionList } from "../src/renderer/src/lib/session.ts";
import type { SessionInfo } from "../src/shared/protocol.ts";

/** 造一个会话；`draft` 时按主进程约定把 jsonlPath 置空串 */
function session(id: string, draft = false): SessionInfo {
  return {
    id,
    projectId: "p1",
    title: draft ? "新会话" : `会话 ${id}`,
    jsonlPath: draft ? "" : `/tmp/${id}.jsonl`,
    kernelSessionId: null,
    modelRef: null,
    thinkingLevel: null,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    status: "active",
  };
}

const ids = (list: readonly SessionInfo[]): string[] => list.map((item) => item.id);

describe("isDraftSession：按 jsonlPath 空串判别草稿", () => {
  test("空串 → 草稿", () => {
    assert.equal(isDraftSession({ jsonlPath: "" }), true);
  });

  test("非空串 → 已落库", () => {
    assert.equal(isDraftSession({ jsonlPath: "/tmp/a.jsonl" }), false);
  });
});

describe("mergeSessionList：刷新列表时不丢草稿", () => {
  test("草稿保留在头部——它就是本条回归的核心", () => {
    const merged = mergeSessionList([session("draft", true)], [session("a"), session("b")]);
    assert.deepEqual(ids(merged), ["draft", "a", "b"]);
  });

  test("已落库的会话不被重复保留（不会出现两条）", () => {
    const merged = mergeSessionList([session("a"), session("b")], [session("a"), session("b")]);
    assert.deepEqual(ids(merged), ["a", "b"]);
  });

  test("草稿落库后就以库为准，不重复、不错位", () => {
    // 「draft」这一条既在本地（旧副本、jsonlPath 还是空串）也已在库里
    const merged = mergeSessionList([session("draft", true)], [session("draft"), session("x")]);
    assert.deepEqual(ids(merged), ["draft", "x"]);
  });

  test("库里已删除的真实会话会被剔除（非草稿一律以库为准）", () => {
    const merged = mergeSessionList([session("gone"), session("keep", true)], [session("other")]);
    assert.deepEqual(ids(merged), ["keep", "other"]);
  });

  test("本地为空 → 即库列表", () => {
    assert.deepEqual(ids(mergeSessionList([], [session("a")])), ["a"]);
  });

  test("库为空 → 只剩草稿（清空重来后仍保留未落库的那条）", () => {
    assert.deepEqual(ids(mergeSessionList([session("draft", true)], [])), ["draft"]);
  });

  test("多个草稿保持原有相对顺序", () => {
    const merged = mergeSessionList(
      [session("d1", true), session("d2", true)],
      [session("a")],
    );
    assert.deepEqual(ids(merged), ["d1", "d2", "a"]);
  });

  test("不修改入参（纯函数）", () => {
    const previous = [session("draft", true)];
    const fromDb = [session("a")];
    mergeSessionList(previous, fromDb);
    assert.deepEqual(ids(previous), ["draft"]);
    assert.deepEqual(ids(fromDb), ["a"]);
  });
});
