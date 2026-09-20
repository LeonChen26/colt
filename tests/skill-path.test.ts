/**
 * 技能文件路径的**形状判定**（`shared/skill-path.ts`）测试。
 *
 * 这个纯函数被两处共用，而两处判错的代价不同、方向相反：
 * - `main/ipc` 的 `skills.reveal`：判错 → 把文件管理器掀到别的位置去；
 * - `main/approval` 的审批摘要：判错 → 审批卡上多一句假话（「这是技能」），或该标的不标。
 *
 * 所以钉三件事：① 只认 `.agents/skills/<名字>/SKILL.md` 这个形状；② 分隔符不影响判断
 * （Windows 的反斜杠与正斜杠是同一个文件）；③ 技能目录里的**其它**文件不算——那只是引用文件。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isSkillFilePath } from "../src/shared/skill-path.ts";

describe("isSkillFilePath", () => {
  test("认标准形状：<...>/.agents/skills/<名字>/SKILL.md", () => {
    assert.equal(isSkillFilePath("/home/u/.agents/skills/pdf/SKILL.md"), true);
    assert.equal(isSkillFilePath("E:/proj/.agents/skills/pdf/SKILL.md"), true);
  });

  test("反斜杠分隔符照认（Windows 下同一个文件不能判成两个）", () => {
    assert.equal(isSkillFilePath("E:\\proj\\.agents\\skills\\pdf\\SKILL.md"), true);
  });

  test("技能目录里的**其它**文件不算（引用文件不是技能本体）", () => {
    assert.equal(isSkillFilePath("/home/u/.agents/skills/pdf/references/api.md"), false);
    assert.equal(isSkillFilePath("/home/u/.agents/skills/pdf/reference.md"), false);
  });

  test("层级不对就不认（少一层名字、或换了目录名）", () => {
    // 少了「名字」那层，直接放在 skills 下
    assert.equal(isSkillFilePath("/home/u/.agents/skills/SKILL.md"), false);
    // 目录名换了 —— 那些位置本产品**不读**（见 docs/SECURITY.md §技能）
    assert.equal(isSkillFilePath("/home/u/.claude/skills/pdf/SKILL.md"), false);
    assert.equal(isSkillFilePath("/home/u/.openclaw/workspace/skills/pdf/SKILL.md"), false);
    // .agents 那一层没了
    assert.equal(isSkillFilePath("/home/u/skills/pdf/SKILL.md"), false);
    // 名字那层顶掉了 .agents
    assert.equal(isSkillFilePath("/home/u/.agents/pdf/SKILL.md"), false);
  });

  test("无关文件与畸形输入都不认", () => {
    assert.equal(isSkillFilePath("E:/proj/src/a.ts"), false);
    assert.equal(isSkillFilePath("SKILL.md"), false);
    assert.equal(isSkillFilePath(""), false);
  });
});
