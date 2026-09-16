/**
 * 技能调用失败原因的翻译（`describeSkillError` / `unknownSkillMessage`）。
 *
 * 内核的技能调用失败走 `Result.err` 而不是抛异常，错误类不在本仓类型面里，
 * 只能按 `_tag` 判别。**每一种形态都必须给出可读说明**——否则用户敲了 `/skill xxx`
 * 就是「敲了没反应」，而技能调用最常见的失败（名字不存在）恰恰只走这条路。
 *
 * 模块住在 `src/shared/`：渲染层的本地拦截与 worker 的兜底必须说**同一句话**。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  describeSkillError,
  unknownSkillMessage,
} from "../src/shared/skill-error.ts";

describe("unknownSkillMessage", () => {
  test("列全可用名——用户打错名字时，这是唯一能告诉他正确写法的地方", () => {
    assert.equal(
      unknownSkillMessage("pdf", ["processing-pdfs", "code-review"]),
      "技能「pdf」不存在。可用：processing-pdfs、code-review",
    );
  });

  test("一个技能都没有时说清技能该放哪，而不是只说「不存在」", () => {
    const message = unknownSkillMessage("pdf", []);
    assert.ok(message.includes("技能「pdf」不存在"), message);
    assert.ok(message.includes(".agents/skills"), message);
  });
});

describe("describeSkillError", () => {
  test("按 _tag 给出可读说明", () => {
    assert.equal(
      describeSkillError({ _tag: "LaneBusy", message: "busy" }),
      "当前有正在进行的任务，无法调用技能：请等它结束，或先停止当前任务。",
    );
    assert.equal(describeSkillError({ _tag: "Closed", message: "closed" }), "会话已关闭，无法调用技能。");
    assert.equal(
      describeSkillError({ _tag: "InvalidMessage", message: "bad" }),
      "技能的正文无法构成一条有效消息（技能文件内容异常）。",
    );
  });

  test("UnknownSkill 只说不存在，不断言「没装载任何技能」（那时技能其实装着，只是名字不对）", () => {
    assert.equal(describeSkillError({ _tag: "UnknownSkill", name: "pdf" }), "技能「pdf」不存在。");
    assert.equal(describeSkillError({ _tag: "UnknownSkill" }), "技能不存在。");
    assert.ok(!describeSkillError({ _tag: "UnknownSkill", name: "pdf" }).includes("没有装载"));
  });

  test("未知形态（含非 Error 值）也不抛，原样带出", () => {
    assert.equal(describeSkillError("boom"), "调用技能失败：boom");
    assert.equal(describeSkillError(undefined), "调用技能失败：undefined");
  });
});
