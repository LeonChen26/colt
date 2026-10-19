/**
 * 技能自查文案（`unknownSkillMessage` / `disabledSkillMessage`）。
 *
 * 模块住在 `src/shared/`：渲染层的本地拦截与 worker 的兜底必须说**同一句话**。
 *
 * 切到 pi-durable 后不再有内核 `Result.err` 那一层（投递由应用直接 `conversation.submit`），
 * 于是「可用名」这件事全靠这里的两句文案——它是用户打错名字时唯一的指路牌。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  disabledSkillMessage,
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

describe("disabledSkillMessage", () => {
  test("说「被你禁用」并指回设置页，而不是「不存在」", () => {
    const message = disabledSkillMessage("pdf");
    assert.ok(message.includes("已被你在设置里禁用"), message);
    assert.ok(message.includes("设置 → 技能"), message);
    // 「不存在」会让人去翻拼写——而这个名字是他自己刚关掉的
    assert.ok(!message.includes("不存在"), message);
  });
});
