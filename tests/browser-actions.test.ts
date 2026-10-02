/**
 * `browser_act` 动作分类（纯模块）测试。
 *
 * 这份名单决定两件会「静默漏气」的事：① 用户接管期间**哪些动作该被拒**（漏一个就是
 * 接管没拦住，agent 在用户手底下改页面）；② 哪些动作算「agent 刚操作过」（漏一个就是
 * 状态条不亮、用户分不清页面变动归谁）。所以逐个钉住分类边界，尤其是 `wait`（只等不改，
 * 必须**不**在改动集合里）与动作链的「任一环即算」。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  BROWSER_ACT_TOOL,
  MUTATING_BROWSER_ACTIONS,
  controlBlockReason,
  controlBlockedMessage,
  firstMutatingAction,
} from "../src/main/host/browser-actions";

describe("MUTATING_BROWSER_ACTIONS：改变页面的动作集合", () => {
  test("写操作与抢操作权的动作都在内", () => {
    for (const action of ["navigate", "click", "type", "key", "scroll", "viewport", "upload"]) {
      assert.ok(MUTATING_BROWSER_ACTIONS.has(action), `${action} 应当是改动类`);
    }
  });

  test("wait 是「只等不改」，不在改动集合里", () => {
    assert.ok(!MUTATING_BROWSER_ACTIONS.has("wait"));
    assert.equal(BROWSER_ACT_TOOL, "browser_act");
  });
});

describe("firstMutatingAction：单动作", () => {
  test("改动类动作原样返回（拒绝理由要点名是哪个）", () => {
    assert.equal(firstMutatingAction({ action: "click" }), "click");
    assert.equal(firstMutatingAction({ action: "type" }), "type");
  });

  test("只读 / 只等动作、缺失、非字符串一律 undefined", () => {
    assert.equal(firstMutatingAction({ action: "wait" }), undefined);
    assert.equal(firstMutatingAction({}), undefined);
    assert.equal(firstMutatingAction({ action: 42 }), undefined);
    assert.equal(firstMutatingAction({ action: undefined }), undefined);
  });
});

describe("firstMutatingAction：动作链（任一环即算）", () => {
  test("链里含改写动作 → 命中它", () => {
    assert.equal(firstMutatingAction({ actions: [{ action: "type" }, { action: "key" }] }), "type");
    assert.equal(
      firstMutatingAction({ actions: [{ action: "wait" }, { action: "click" }] }),
      "click",
      "前面的只读动作不该掩盖后面的改动动作",
    );
  });

  test("全链只等 / 空链 → undefined", () => {
    assert.equal(firstMutatingAction({ actions: [{ action: "wait" }] }), undefined);
    assert.equal(firstMutatingAction({ actions: [] }), undefined);
  });

  test("scroll 属于改动类（不是只读），链里出现即命中", () => {
    assert.equal(
      firstMutatingAction({ actions: [{ action: "wait" }, { action: "scroll" }] }),
      "scroll",
    );
  });

  test("链里的坏元素（null / 非对象）跳过，不炸", () => {
    assert.equal(firstMutatingAction({ actions: [null, "x", { action: "click" }] }), "click");
    assert.equal(firstMutatingAction({ actions: [null, "x"] }), undefined);
  });

  test("单动作与链同时存在时以链为准（与执行层一致）", () => {
    assert.equal(firstMutatingAction({ action: "wait", actions: [{ action: "click" }] }), "click");
  });
});

describe("controlBlockedMessage：拒绝理由要能直接回给模型", () => {
  test("点名被拒动作，且同时说清「为什么」与「期间能做什么」", () => {
    const message = controlBlockedMessage("click");
    assert.match(message, /已接管/);
    assert.match(message, /「click」/);
    assert.match(message, /交还/);
    assert.match(message, /browser_read/);
  });
});

describe("controlBlockReason：接管期间的前置否决判据", () => {
  test("已接管 + 改动类 browser_act → 给出理由（点名该动作）", () => {
    const reason = controlBlockReason(true, BROWSER_ACT_TOOL, { action: "click" });
    assert.ok(reason !== undefined);
    assert.match(reason, /「click」/);
  });

  test("已接管 + 动作链里有改动动作 → 也否决（任一环即算）", () => {
    const reason = controlBlockReason(true, BROWSER_ACT_TOOL, {
      actions: [{ action: "wait" }, { action: "key", key: "Enter" }],
    });
    assert.ok(reason !== undefined);
    assert.match(reason, /「key」/);
  });

  test("已接管但只需只等（wait）→ 放行（看/等不算改页面）", () => {
    assert.equal(controlBlockReason(true, BROWSER_ACT_TOOL, { action: "wait" }), undefined);
    assert.equal(
      controlBlockReason(true, BROWSER_ACT_TOOL, { actions: [{ action: "wait" }] }),
      undefined,
    );
  });

  test("已接管但工具不是 browser_act → 不管（本判据只管浏览器动作）", () => {
    assert.equal(controlBlockReason(true, "edit", { path: "E:/a.ts" }), undefined);
    assert.equal(controlBlockReason(true, "bash", { command: "ls" }), undefined);
  });

  test("未接管 → 一律放行（判据的前提是「用户明确点过接管」）", () => {
    assert.equal(controlBlockReason(false, BROWSER_ACT_TOOL, { action: "click" }), undefined);
    assert.equal(controlBlockReason(false, BROWSER_ACT_TOOL, { action: "navigate" }), undefined);
  });
});
