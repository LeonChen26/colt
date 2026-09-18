/**
 * ask_user 的纯函数测试。
 *
 * 这条链路的失败模式是**静默**（提问没人答、或被当成审批自动放行），
 * 所以凡是能脱离进程测的都要测到——校验、答案渲染、三条回落文案。
 *
 * 另有一条**契约级**断言：提问绝不能混进审批通道（提问的默认值是「没答案」，审批的默认值却是「放行」）。
 * 这里守住的是「worker 侧不把 ask_user 送进闸门」这个事实的可见痕迹——
 * `isQuestionTool` 是那个分支的唯一判据，工具名改了而判据没改会立刻红。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  ASK_USER_TOOL_NAME,
  MAX_HEADER_CHARS,
  MAX_OPTIONS,
  MAX_QUESTIONS,
  formatAnswers,
  isQuestionTool,
  skipMessage,
  validateQuestionnaire,
} from "../src/worker/lib/ask-user-tool";
import { READONLY_TOOLS } from "@shared/readonly-tools";

/** 一份合法问卷，各用例在此基础上改坏一处 */
function validQuestionnaire(): unknown {
  return {
    questions: [
      {
        question: "这次重构要不要顺手改名？",
        header: "命名",
        options: [
          { label: "只改内部", description: "不动对外 API" },
          { label: "连 API 一起改", description: "破坏性变更，需要同步文档" },
        ],
      },
    ],
  };
}

describe("validateQuestionnaire", () => {
  test("合法问卷原样通过", () => {
    const result = validateQuestionnaire(validQuestionnaire());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.questions.length, 1);
    assert.equal(result.questions[0]?.options.length, 2);
  });

  test("入参不是对象 / 缺 questions 时，文案要说清正确写法", () => {
    for (const bad of [null, "x", 42, {}, { questions: "不是数组" }]) {
      const result = validateQuestionnaire(bad);
      assert.equal(result.ok, false);
      if (result.ok) continue;
      // 光说「参数错」没用：模型下次还是发不对，必须点出该长什么样
      assert.match(result.message, /questions/);
    }
  });

  test(`超过 ${MAX_QUESTIONS} 题被拒，且报出实际给了几题`, () => {
    const questions = Array.from({ length: MAX_QUESTIONS + 1 }, (_, i) => ({
      question: `第 ${i + 1} 题`,
      options: [
        { label: "A", description: "" },
        { label: "B", description: "" },
      ],
    }));
    const result = validateQuestionnaire({ questions });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, new RegExp(`${MAX_QUESTIONS + 1}`));
  });

  test(`选项少于 2 / 多于 ${MAX_OPTIONS} 都被拒`, () => {
    for (const count of [1, MAX_OPTIONS + 1]) {
      const options = Array.from({ length: count }, (_, i) => ({
        label: `选项${i}`,
        description: "",
      }));
      const result = validateQuestionnaire({ questions: [{ question: "问什么", options }] });
      assert.equal(result.ok, false, `${count} 个选项应被拒`);
    }
  });

  test(`header 超过 ${MAX_HEADER_CHARS} 字符被拒，并把原文报出来`, () => {
    const header = "一二三四五六七八九十十一十二";
    assert.ok(header.length > MAX_HEADER_CHARS);
    const result = validateQuestionnaire({
      questions: [{ question: "问什么", header, options: [{ label: "A" }, { label: "B" }] }],
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, /一二三/);
  });

  test("重复 label 被拒——答案按 label 回传，重复就分不清用户选了哪个", () => {
    const result = validateQuestionnaire({
      questions: [
        {
          question: "选哪个",
          options: [
            { label: "同一个", description: "a" },
            { label: "同一个", description: "b" },
          ],
        },
      ],
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, /重复/);
  });

  test("重复的问题正文被拒——答案以问题正文为键，重复会互相覆盖", () => {
    const result = validateQuestionnaire({
      questions: [
        { question: "选哪个", options: [{ label: "A" }, { label: "B" }] },
        { question: "选哪个", options: [{ label: "C" }, { label: "D" }] },
      ],
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, /重复的问题正文/);
  });

  test("空问题 / 空 label 被拒", () => {
    const emptyQuestion = validateQuestionnaire({
      questions: [{ question: "   ", options: [{ label: "A" }, { label: "B" }] }],
    });
    assert.equal(emptyQuestion.ok, false);
    const emptyLabel = validateQuestionnaire({
      questions: [{ question: "问什么", options: [{ label: " " }, { label: "B" }] }],
    });
    assert.equal(emptyLabel.ok, false);
  });
});

describe("formatAnswers", () => {
  test("逐题对齐，未答的如实写「未选择」而不是留空", () => {
    const questions = [
      {
        question: "用哪个库？",
        options: [
          { label: "A", description: "" },
          { label: "B", description: "" },
        ],
      },
      { question: "要不要迁移？", options: [{ label: "要", description: "" }, { label: "不要", description: "" }] },
    ];
    const text = formatAnswers(questions, { "用哪个库？": "B" });
    assert.match(text, /Q：用哪个库？\nA：B/);
    assert.match(text, /Q：要不要迁移？\nA：（未选择）/);
  });
});

describe("回落文案", () => {
  test("超时：要求模型继续并声明假设，而不是干等", () => {
    const text = skipMessage("timeout");
    assert.match(text, /未在限定时间内回答/);
    // 不写这句，模型会原样重试一次提问，用户看到的是界面又弹一张卡
    assert.match(text, /继续/);
    assert.match(text, /假设/);
  });

  test("跳过：说清是用户跳过，且对话仍在继续", () => {
    const text = skipMessage("skipped");
    assert.match(text, /跳过/);
    // 用户只是跳过了这一问，会话没断——写成「已中断」会让模型以为整轮对话没了
    assert.doesNotMatch(text, /中断/);
    assert.match(text, /继续/);
  });

  test("中断：说清是对话中断，与超时、跳过都分得开", () => {
    const text = skipMessage("cancelled");
    assert.match(text, /中断/);
    assert.doesNotMatch(text, /未在限定时间内/);
    assert.doesNotMatch(text, /跳过/);
  });
});

describe("不混进审批通道", () => {
  test("闸门判据认得的就是注册的那个名字", () => {
    assert.equal(isQuestionTool(ASK_USER_TOOL_NAME), true);
    assert.equal(isQuestionTool("bash"), false);
    assert.equal(isQuestionTool("ask_user "), false);
  });

  test("ask_user 不进只读白名单——否则审批策略会重新拿到静默批准它的机会", () => {
    // 提问的默认值必须是「没答案」，而只读白名单的语义是「自动放行」。
    // 一旦有人把它「顺手并进去」，全权模式下每次提问都会被静默批准成「已通过」，
    // 模型收到的是假答案——比没有这个工具更糟
    assert.equal(READONLY_TOOLS.has(ASK_USER_TOOL_NAME), false);
  });
});
