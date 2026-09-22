/**
 * 提问卡片答案拼装的测试（`src/renderer/src/lib/question-answer.ts`）。
 *
 * 为什么值得单测：它是「用户答了什么」与「模型读到什么」之间唯一的转换点，
 * 而两边都看不见中间那一层——界面看着答上了、模型收到空串或串错顺序，全是静默的。
 * 合并回传（选项 + 自填）是 v1.65 新定的口径，规则有三条（可独立自填 / 选中在前 /
 * 去重），每条都往具体输入上代一遍，别只做定性判断。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { composeAnswer, isAnswered } from "../src/renderer/src/lib/question-answer";

describe("composeAnswer", () => {
  test("只选一项：答案就是那一项", () => {
    assert.equal(composeAnswer(["Zustand"], ""), "Zustand");
  });

  test("多选：以「、」相连（顺序按点击先后）", () => {
    assert.equal(composeAnswer(["store.ts", "api.ts"], ""), "store.ts、api.ts");
  });

  test("只输入文字：自填可独立作答（没选任何选项也算答了）", () => {
    assert.equal(composeAnswer([], "用 Jotai"), "用 Jotai");
  });

  test("选中项 + 自填：选中在前、自填在后", () => {
    assert.equal(composeAnswer(["store.ts", "api.ts"], "顺便改 README"), "store.ts、api.ts、顺便改 README");
  });

  test("既选了 A 又打了 A：去重，不出现「A、A」（模型会当成两个东西）", () => {
    assert.equal(composeAnswer(["Zustand"], "Zustand"), "Zustand");
  });

  test("两端空白被去掉；选中项里的空白项被忽略", () => {
    assert.equal(composeAnswer(["  Zustand  ", "   "], "  Redux  "), "Zustand、Redux");
  });

  test("什么都没有：空串（由 isAnswered 判为没答）", () => {
    assert.equal(composeAnswer([], ""), "");
    assert.equal(composeAnswer([], "   "), "");
  });

  test("对照：不去重时同一份输入会回传重复项——证明去重那一步真的在起作用", () => {
    const naive = ["Zustand", "Zustand"].join("、");
    assert.notEqual(composeAnswer(["Zustand"], "Zustand"), naive);
  });
});

describe("isAnswered", () => {
  test("非空算答过", () => {
    assert.equal(isAnswered("Zustand"), true);
    assert.equal(isAnswered("store.ts、api.ts"), true);
  });

  test("空串 / 只有空白算没答（不能把「打了空格」当成作答）", () => {
    assert.equal(isAnswered(""), false);
    assert.equal(isAnswered("   "), false);
  });
});
