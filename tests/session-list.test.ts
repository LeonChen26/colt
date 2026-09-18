/**
 * 会话列表相关纯函数的行为测试（`src/renderer/src/lib/session.ts`）。
 *
 * 回归背景（两件事，都是「没用过的会话」这一件事的两面）：
 * ① 项目一个会话都没有时，中间区只有一句「新建一个会话开始对话」，输入框要跑到侧栏点「+」
 *    才出现。现在渲染层会自动建一条**草稿**，打开就见输入框——判据是 `shouldOfferDraft`。
 * ② `session.create` 过去立刻 INSERT 一行、渲染层又把它插进侧栏，于是「点了新建就退出」
 *    会在侧栏留下一串 `message_count=0`、点开还没反应的空会话（用户一个字都没发过）。
 *    现在草稿不进侧栏（列表以库为准），只有落库（首次发消息）后才出现。
 *
 * 这里测的是**行为**（喂进去、看返回什么），不是源码长什么样。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isDraftSession, shouldOfferDraft } from "../src/renderer/src/lib/session.ts";
import type { SessionInfo } from "../src/shared/protocol.ts";

/** 造一个会话；`draft` 时按主进程约定把 jsonlPath 置空串 */
function session(id: string, projectId = "p1", draft = false): SessionInfo {
  return {
    id,
    projectId,
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

describe("isDraftSession：按 jsonlPath 空串判别草稿", () => {
  test("空串 → 草稿", () => {
    assert.equal(isDraftSession({ jsonlPath: "" }), true);
  });

  test("非空串 → 已落库", () => {
    assert.equal(isDraftSession({ jsonlPath: "/tmp/a.jsonl" }), false);
  });
});

describe("shouldOfferDraft：无会话时该不该就地给一条草稿", () => {
  test("列表已到、确实为空、当前也没会话 → 给（「打开就见输入框」的那条路）", () => {
    assert.equal(shouldOfferDraft("p1", [], null), true);
  });

  test("项目下已有落库会话 → 不给（它们自己就能显示）", () => {
    assert.equal(shouldOfferDraft("p1", [session("a")], null), false);
  });

  test("列表还没拉到（undefined）→ 先等，别急着建", () => {
    // 分不清「空」和「还没到」就会每次启动都白建一条，而且是在错误的前提下建
    assert.equal(shouldOfferDraft("p1", undefined, null), false);
  });

  test("当前会话已经是本项目的草稿 → 不给（否则会无限建下去）", () => {
    assert.equal(shouldOfferDraft("p1", [], session("draft", "p1", true)), false);
  });

  test("当前会话是本项目**已落库**的会话 → 也不给（本项目已经有人在显示）", () => {
    assert.equal(shouldOfferDraft("p1", [], session("a", "p1")), false);
  });

  test("当前会话属于另一个项目 → 给（本项目这边是空的）", () => {
    assert.equal(shouldOfferDraft("p1", [], session("b", "p2", true)), true);
  });

  test("没有项目 → 不给（该先让用户打开一个目录）", () => {
    assert.equal(shouldOfferDraft(undefined, [], null), false);
  });
});
