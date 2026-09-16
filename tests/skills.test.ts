/**
 * 技能装载测试。
 *
 * 覆盖四件容易错的事：① 目录是否取了 agentskills.io 的标准约定；
 * ② 同名时项目级是否真的胜出；③ **工作区外的目录是否读得到**——
 * 用户级技能在 `~` 下，若被环境边界拦住就永远装不上，而且会每次报告警；
 * ④ **技能清单有没有真的拼进系统提示词**——内核只给函数、不替应用调用，
 * 漏了这步装载/告警/计数全正常，只有模型不知道，是彻头彻尾的静默失败。
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { BACKGROUND_CONTEXT, type Skill } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  composeSystemPrompt,
  dedupeByName,
  describeDiagnostic,
  describeSkills,
  loadSkillsForSession,
  skillDirs,
  MAX_NOTICE_SKILL_NAMES,
  type LoadedSkills,
} from "../src/worker/lib/skills.ts";

const skill = (name: string): Skill => ({
  name,
  description: `${name} 的说明`,
  content: "正文",
  filePath: `${name}/SKILL.md`,
});

describe("skillDirs", () => {
  test("取标准约定 .agents/skills，且项目级在前（同名时它胜出）", () => {
    assert.deepEqual(skillDirs("/proj", "/home/u"), [
      join("/proj", ".agents", "skills"),
      join("/home/u", ".agents", "skills"),
    ]);
  });
});

describe("dedupeByName", () => {
  test("同名只留先到的那份（项目级），被遮蔽的名字如实收集", () => {
    const { skills, shadowed } = dedupeByName([
      [skill("a"), skill("b")],
      [skill("b"), skill("c")],
    ]);
    assert.deepEqual(skills.map((item) => item.name), ["a", "b", "c"]);
    assert.equal(skills.find((item) => item.name === "b")?.filePath, "b/SKILL.md");
    assert.deepEqual(shadowed, ["b"]);
  });

  test("没有重名时既不丢也不误报", () => {
    const { skills, shadowed } = dedupeByName([[skill("a")], [skill("b")]]);
    assert.deepEqual(skills.map((item) => item.name), ["a", "b"]);
    assert.deepEqual(shadowed, []);
  });
});

describe("describeDiagnostic", () => {
  test("中文类目 + 路径末两段 + 保留内核原文", () => {
    assert.equal(
      describeDiagnostic({
        type: "warning",
        code: "invalid_metadata",
        message: "description is required",
        path: join("root", "pdf-processing", "SKILL.md"),
      }),
      "pdf-processing/SKILL.md：元数据不合法（description is required）",
    );
  });
});

describe("describeSkills", () => {
  const empty: LoadedSkills = { skills: [], shadowed: [], diagnostics: [], counts: [0, 0] };

  test("什么都没有时返回 null（不制造噪音）", () => {
    assert.equal(describeSkills(empty), null);
  });

  test("给出计数、覆盖与被覆盖者", () => {
    const loaded: LoadedSkills = {
      skills: [skill("a"), skill("b"), skill("c")],
      shadowed: ["b"],
      diagnostics: [],
      counts: [2, 1],
    };
    const notice = describeSkills(loaded);
    assert.ok(notice?.includes("已加载 3 个技能（项目级 2 · 用户级 1）"), notice ?? "");
    assert.ok(notice?.includes("项目级覆盖了同名用户级技能：b"), notice ?? "");
  });

  test("告警列到上限就只报个数（列满屏就不是提示了）", () => {
    const loaded: LoadedSkills = {
      skills: [],
      shadowed: [],
      counts: [0, 0],
      diagnostics: Array.from({ length: 5 }, (_, index) => ({
        type: "warning" as const,
        code: "parse_failed" as const,
        message: `m${index}`,
        path: `s${index}/SKILL.md`,
      })),
    };
    const notice = describeSkills(loaded);
    assert.ok(notice?.includes("技能告警 5 条"), notice ?? "");
    assert.ok(notice?.includes("s2/SKILL.md"), notice ?? "");
    assert.ok(!notice?.includes("s3/SKILL.md"), notice ?? "");
    assert.ok(notice?.includes("（另有 2 条）"), notice ?? "");
  });
  test("报出技能名与用法——/skill 没有界面入口，这里是用户唯一能知道「有哪些名字」的地方", () => {
    const loaded: LoadedSkills = {
      skills: [skill("pdf"), skill("code-review")],
      shadowed: [],
      diagnostics: [],
      counts: [1, 1],
    };
    const notice = describeSkills(loaded);
    assert.ok(notice?.includes("pdf、code-review"), notice ?? "");
    assert.ok(notice?.includes("用 /skill <名字> 调用"), notice ?? "");
  });

  test("技能名太多时只说个数，不把通知撑成一屏", () => {
    const loaded: LoadedSkills = {
      skills: Array.from({ length: MAX_NOTICE_SKILL_NAMES + 3 }, (_, index) => skill(`s${index}`)),
      shadowed: [],
      diagnostics: [],
      counts: [11, 0],
    };
    const notice = describeSkills(loaded);
    assert.ok(notice?.includes(`已加载 ${MAX_NOTICE_SKILL_NAMES + 3} 个技能`), notice ?? "");
    assert.ok(notice?.includes(`s${MAX_NOTICE_SKILL_NAMES - 1} 等`), notice ?? "");
    assert.ok(!notice?.includes(`s${MAX_NOTICE_SKILL_NAMES}`), "超出上限的名字不该出现");
  });

  test("标了 disableModelInvocation 的技能要说清「不是坏了、是不让模型自选」", () => {
    const loaded: LoadedSkills = {
      skills: [{ ...skill("a"), disableModelInvocation: true }, skill("b")],
      shadowed: [],
      diagnostics: [],
      counts: [1, 1],
    };
    const notice = describeSkills(loaded);
    assert.ok(notice?.includes("已加载 2 个技能"), notice ?? "");
    assert.ok(notice?.includes("其中 1 个不对模型公开"), notice ?? "");
    // 加 `/skill` 之前这句写的是「等于不生效」——现在它**能**被显式调用了，必须改掉，
    // 否则用户会以为这个技能永远用不上（陈旧文案比没有文案更坑）。
    assert.ok(!notice?.includes("不生效"), notice ?? "");
    assert.ok(notice?.includes("需 /skill <名字> 显式调用"), notice ?? "");
  });

  test("没有这种技能时不提这句", () => {
    const loaded: LoadedSkills = { skills: [skill("a")], shadowed: [], diagnostics: [], counts: [1, 0] };
    assert.equal(describeSkills(loaded)?.includes("disable-model-invocation"), false);
  });
});

describe("composeSystemPrompt", () => {
  const base = "你是 Colt 桌面工作台中的编码助手。";

  test("没有可公开的技能时原样返回——不追加空块、不动基础提示词", () => {
    assert.equal(composeSystemPrompt(base, []), base);
    // 全标了 disableModelInvocation 时内核过滤后也是空块（显式调用仍可用，只是不列给模型）
    assert.equal(composeSystemPrompt(base, [{ ...skill("x"), disableModelInvocation: true }]), base);
  });

  test("有技能时追加标准块：名字 / 说明 / 位置俱全，且排在基础提示词之后", () => {
    const prompt = composeSystemPrompt(base, [
      { ...skill("pdf"), filePath: "/home/u/.agents/skills/pdf/SKILL.md" },
    ]);
    assert.ok(prompt.startsWith(base), "基础提示词必须原样在前面");
    for (const fragment of [
      "<available_skills>",
      "<name>pdf</name>",
      "<description>pdf 的说明</description>",
      "<location>/home/u/.agents/skills/pdf/SKILL.md</location>",
      "</available_skills>",
    ]) {
      assert.ok(prompt.includes(fragment), `缺 ${fragment}：${prompt}`);
    }
  });

  test("正文不进提示词——模型按位置自己去读（渐进披露）", () => {
    const prompt = composeSystemPrompt(base, [{ ...skill("pdf"), content: "技能的绝密正文" }]);
    assert.ok(!prompt.includes("技能的绝密正文"), "正文应留在文件里，不进系统提示词");
  });
});

describe("真装载（内核 loader + 真目录）", () => {
  let base = "";
  let outside = "";

  const writeSkill = async (root: string, name: string, frontmatter: string): Promise<void> => {
    const dir = join(root, ".agents", "skills", name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n技能的正文\n`, "utf8");
  };

  before(async () => {
    base = await mkdtemp(join(tmpdir(), "colt-skills-"));
    outside = await mkdtemp(join(tmpdir(), "colt-skills-out-"));
    await writeSkill(base, "processing-pdfs", "name: processing-pdfs\ndescription: 处理 PDF。Use when the user mentions PDFs.");
    await writeSkill(outside, "user-level", "name: user-level\ndescription: 用户级技能。");
    await writeSkill(base, "broken-skill", "name: broken-skill");
  });

  after(async () => {
    await rm(base, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  test("标准目录里的 SKILL.md 装得出来；工作区外的用户级目录同样读得到", async () => {
    const env = new NodeExecutionEnv({ cwd: base });
    const loaded = await loadSkillsForSession(
      env,
      [join(base, ".agents", "skills"), join(outside, ".agents", "skills")],
      BACKGROUND_CONTEXT,
    );
    assert.deepEqual(loaded.skills.map((item) => item.name).sort(), ["processing-pdfs", "user-level"]);
    assert.deepEqual(loaded.counts, [1, 1]);
    const pdf = loaded.skills.find((item) => item.name === "processing-pdfs");
    assert.equal(pdf?.description, "处理 PDF。Use when the user mentions PDFs.");
    assert.equal(pdf?.content, "技能的正文");
    assert.ok(pdf?.filePath.endsWith(join("processing-pdfs", "SKILL.md")), pdf?.filePath ?? "");
  });

  test("真装载的技能进了系统提示词，且给模型的位置是**绝对路径**（否则用户级技能读不到）", async () => {
    const env = new NodeExecutionEnv({ cwd: base });
    const loaded = await loadSkillsForSession(env, [join(base, ".agents", "skills")], BACKGROUND_CONTEXT);
    const prompt = composeSystemPrompt("基础提示词", loaded.skills);
    assert.ok(prompt.includes("<name>processing-pdfs</name>"), prompt);
    // 块里那句「读技能文件」要求模型直接 read 这个路径；相对路径会被解析到 cwd 下，
    // 而用户级技能在 ~ 里——那时技能就是「列得出、读不到」的死条目。
    const filePath = loaded.skills[0]?.filePath ?? "";
    assert.ok(isAbsolute(filePath), `位置必须是绝对路径：${filePath}`);
    assert.ok(prompt.includes(filePath), prompt);
  });

  test("缺 description 的技能被内核丢掉，并留下可读告警", async () => {
    const env = new NodeExecutionEnv({ cwd: base });
    const loaded = await loadSkillsForSession(env, [join(base, ".agents", "skills")], BACKGROUND_CONTEXT);
    assert.deepEqual(loaded.skills.map((item) => item.name), ["processing-pdfs"]);
    assert.ok(loaded.diagnostics.some((item) => item.code === "invalid_metadata"));
    assert.ok(describeSkills(loaded)?.includes("元数据不合法"));
  });

  test("目录不存在时静默跳过（不报错、不产生噪音）", async () => {
    const env = new NodeExecutionEnv({ cwd: base });
    const loaded = await loadSkillsForSession(env, [join(base, "nope", "skills")], BACKGROUND_CONTEXT);
    assert.deepEqual(loaded.skills, []);
    assert.deepEqual(loaded.diagnostics, []);
    assert.equal(describeSkills(loaded), null);
  });
});
