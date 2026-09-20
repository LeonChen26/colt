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
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { makeTempDirAsync, removeTempDirAsync } from "./helpers/temp";
import { BACKGROUND_CONTEXT, formatSkillInvocation, type Skill } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  MAX_SKILL_BODY_CHARS,
  builtinSkillsDir,
  capSkillBodies,
  composeSystemPrompt,
  dedupeByName,
  describeDiagnostic,
  describeSkillWarnings,
  enabledSkills,
  loadSkillsForSession,
  modelSkills,
  parseSkillInvocation,
  skillDirSources,
  skillPathMatcher,
  skillWarningParts,
  toSkillDetails,
  toViewSkills,
  type LoadedSkills,
  type SkillDir,
} from "../src/worker/lib/skills.ts";
import type { ViewSkill } from "../src/shared/worker-protocol.ts";
import { systemPrompt } from "../src/worker/lib/system-prompt.ts";

const skill = (name: string): Skill => ({
  name,
  description: `${name} 的说明`,
  content: "正文",
  filePath: `${name}/SKILL.md`,
});

describe("skillDirSources", () => {
  test("两个用户位置项目级在前（同名时它胜出），内置目录排在**最后**", () => {
    const dirs = skillDirSources("/proj", "/home/u").map((item) => item.dir);
    assert.deepEqual(dirs.slice(0, 2), [
      join("/proj", ".agents", "skills"),
      join("/home/u", ".agents", "skills"),
    ]);
    // 内置目录由 `import.meta.dirname` 推出（跑测试时那是源码目录），故只认末段——
    // 写死绝对路径会让这条用例绑死在「测试从哪个目录跑」上
    assert.ok(dirs[2]?.endsWith("builtin-skills"), `内置目录压在最后：${dirs[2] ?? "缺失"}`);
  });

  test("来源标签与目录一一对应，顺序即优先级", () => {
    assert.deepEqual(
      skillDirSources("/proj", "/home/u").map((item) => item.source),
      ["project", "user", "builtin"],
    );
  });
});

describe("dedupeByName", () => {
  test("同名只留先到的那份（项目级），被遮蔽的那份**连来源**如实收集", () => {
    const { skills, shadowed, sources, counts } = dedupeByName([
      [skill("a"), skill("b")],
      [skill("b"), skill("c")],
    ]);
    assert.deepEqual(skills.map((item) => item.name), ["a", "b", "c"]);
    assert.equal(skills.find((item) => item.name === "b")?.filePath, "b/SKILL.md");
    // from=1（用户级）被 by=0（项目级）遮蔽——只说名字的话，同目录重名会被说成这一种
    assert.deepEqual(shadowed, [{ name: "b", from: 1, by: 0 }]);
    // `sources` 与 `skills` 一一对应：视图要回答「这份技能来自哪一层」只能靠它
    assert.deepEqual(sources, [0, 0, 1]);
    // 计数必须是**去重后**的贡献数（求和 = skills.length），才谈得上按来源归因；
    // 否则「用户级 = 总数 − 项目级」会在同目录重名时算出负数
    assert.deepEqual(counts, [2, 1]);
    assert.equal(
      counts.reduce((sum, value) => sum + value, 0),
      skills.length,
    );
  });

  test("没有重名时既不丢也不误报", () => {
    const { skills, shadowed, sources, counts } = dedupeByName([[skill("a")], [skill("b")]]);
    assert.deepEqual(skills.map((item) => item.name), ["a", "b"]);
    assert.deepEqual(shadowed, []);
    assert.deepEqual(sources, [0, 1]);
    assert.deepEqual(counts, [1, 1]);
  });

  test("**同一个目录里**重名也去重，且来源下标相同（那不是「项目级盖用户级」）", () => {
    // 内核不去重（`name ≠ 目录名` 只告警、不丢弃），所以同目录重名是真会发生的
    const { skills, shadowed, sources, counts } = dedupeByName([[skill("x"), skill("x")], []]);
    assert.deepEqual(skills.map((item) => item.name), ["x"]);
    assert.deepEqual(shadowed, [{ name: "x", from: 0, by: 0 }]);
    assert.deepEqual(sources, [0]);
    assert.deepEqual(counts, [1, 0]);
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

describe("describeSkillWarnings", () => {
  const empty: LoadedSkills = {
    skills: [],
    disabled: [],
    disabledByUser: [],
    shadowed: [],
    sources: [],
    diagnostics: [],
    counts: [0, 0],
    dirSources: ["project", "user"],
  };

  test("什么都没有时返回 null（不制造噪音）", () => {
    assert.equal(describeSkillWarnings(empty), null);
  });

  test("**状态不再播报**：装了技能而没有任何告警时，一条通知都不发", () => {
    // 状态（装了几个、都叫什么）由 `ConversationView.skills` 承载、渲染层自己展示。
    // 把它当事件播报的后果：每次 worker 启动都往「事件」页签写一条例行信息，
    // 而 `session_events` 只对 5 分钟内的同内容去重（见报告 P4）。
    const loaded: LoadedSkills = {
      skills: [skill("pdf"), skill("code-review")],
      disabled: [],
      disabledByUser: [],
      shadowed: [],
      sources: [0, 1],
      diagnostics: [],
      counts: [1, 1],
      dirSources: ["project", "user"],
    };
    assert.equal(describeSkillWarnings(loaded), null);
  });

  test("跨来源覆盖：说「项目级覆盖了同名用户级技能」", () => {
    const loaded: LoadedSkills = {
      skills: [skill("a"), skill("b"), skill("c")],
      disabled: [],
      disabledByUser: [],
      shadowed: [{ name: "b", from: 1, by: 0 }],
      sources: [0, 0, 1],
      diagnostics: [],
      counts: [2, 1],
      dirSources: ["project", "user"],
    };
    const notice = describeSkillWarnings(loaded);
    assert.ok(notice?.includes("项目级覆盖了同名用户级技能：b"), notice ?? "");
  });

  test("覆盖内置时如实报「内置」（三层之后不能照抄「用户级」那句）", () => {
    // 这条钉的是一个真实会发生的场景：内置发的是 `skill-creator`，用户在项目里写一个同名技能
    // 就会盖掉它。旧文案对**所有**跨来源覆盖都写「项目级覆盖了同名用户级技能」——这里盖的是内置，
    // 那句话是假的，而告警正是用户唯一能看到「谁被遮蔽了」的地方。
    const byProject: LoadedSkills = {
      skills: [skill("skill-creator")],
      disabled: [],
      disabledByUser: [],
      shadowed: [{ name: "skill-creator", from: 2, by: 0 }],
      sources: [0],
      diagnostics: [],
      counts: [1, 0, 0],
      dirSources: ["project", "user", "builtin"],
    };
    const projectNotice = describeSkillWarnings(byProject);
    assert.ok(
      projectNotice?.includes("项目级覆盖了同名内置技能：skill-creator"),
      projectNotice ?? "",
    );
    assert.ok(!projectNotice?.includes("用户级技能："), "盖的不是用户级，别那么说");

    const byUser: LoadedSkills = {
      ...byProject,
      shadowed: [{ name: "skill-creator", from: 2, by: 1 }],
      counts: [0, 1, 0],
      dirSources: ["project", "user", "builtin"],
    };
    assert.ok(
      describeSkillWarnings(byUser)?.includes("用户级覆盖了同名内置技能：skill-creator"),
      describeSkillWarnings(byUser) ?? "",
    );
  });

  test("同一份装载里两种「谁盖谁」分两句说（混一句就分不清谁生效）", () => {
    const loaded: LoadedSkills = {
      skills: [skill("a"), skill("b")],
      disabled: [],
      disabledByUser: [],
      shadowed: [
        { name: "a", from: 1, by: 0 },
        { name: "b", from: 2, by: 0 },
      ],
      sources: [0, 0],
      diagnostics: [],
      counts: [2, 0, 0],
      dirSources: ["project", "user", "builtin"],
    };
    const parts = skillWarningParts(loaded);
    assert.ok(parts.includes("项目级覆盖了同名用户级技能：a"), parts.join(" | "));
    assert.ok(parts.includes("项目级覆盖了同名内置技能：b"), parts.join(" | "));
  });

  test("同一目录内重名：按「同目录」口径说（不是「项目级盖用户级」）", () => {
    // 内核不去重，所以同一目录里真会产出两条同名技能（`name ≠ 目录名` 只告警）。
    // 照旧文案会写成「项目级覆盖了同名用户级技能」——一句假话，出现在一个**只为
    // 「如实告知」而存在**的模块里。
    const loaded: LoadedSkills = {
      skills: [skill("x")],
      disabled: [],
      disabledByUser: [],
      shadowed: [{ name: "x", from: 0, by: 0 }],
      sources: [0],
      diagnostics: [],
      counts: [1, 0],
      dirSources: ["project", "user"],
    };
    const notice = describeSkillWarnings(loaded);
    assert.ok(notice?.includes("同一目录下有同名技能"), notice ?? "");
    assert.ok(!notice?.includes("项目级覆盖了同名用户级技能"), notice ?? "");
  });

  test("告警列到上限就只报个数（列满屏就不是提示了）", () => {
    const loaded: LoadedSkills = {
      skills: [],
      disabled: [],
      disabledByUser: [],
      shadowed: [],
      sources: [],
      counts: [0, 0],
      dirSources: ["project", "user"],
      diagnostics: Array.from({ length: 5 }, (_, index) => ({
        type: "warning" as const,
        code: "parse_failed" as const,
        message: `m${index}`,
        path: `s${index}/SKILL.md`,
      })),
    };
    const notice = describeSkillWarnings(loaded);
    assert.ok(notice?.includes("技能告警 5 条"), notice ?? "");
    assert.ok(notice?.includes("s2/SKILL.md"), notice ?? "");
    assert.ok(!notice?.includes("s3/SKILL.md"), notice ?? "");
    assert.ok(notice?.includes("（另有 2 条）"), notice ?? "");
  });

  test("标了 disableModelInvocation 的技能要说清「不是坏了、是不让模型自选」", () => {
    const loaded: LoadedSkills = {
      skills: [{ ...skill("a"), disableModelInvocation: true }, skill("b")],
      disabled: [],
      disabledByUser: [],
      shadowed: [],
      sources: [0],
      diagnostics: [],
      counts: [1, 1],
      dirSources: ["project", "user"],
    };
    const notice = describeSkillWarnings(loaded);
    // 状态那句（「已加载 2 个技能」）已经不发了，这条**原因**必须自己站得住
    assert.ok(notice?.includes("有 1 个技能不对模型公开"), notice ?? "");
    assert.ok(!notice?.includes("已加载"), `状态不该再借这条通知播报：${notice ?? ""}`);
    // 加 `/skill` 之前这句写的是「等于不生效」——现在它**能**被显式调用了，必须改掉，
    // 否则用户会以为这个技能永远用不上（陈旧文案比没有文案更坑）。
    assert.ok(!notice?.includes("不生效"), notice ?? "");
    assert.ok(notice?.includes("需 /skill <名字> 显式调用"), notice ?? "");
  });

  test("没有这种技能时不提这句", () => {
    const loaded: LoadedSkills = {
      skills: [skill("a")],
      disabled: [],
      disabledByUser: [],
      shadowed: [],
      sources: [0],
      diagnostics: [],
      counts: [1, 0],
      dirSources: ["project", "user"],
    };
    // 没有 `disableModelInvocation`、也没有别的告警时整条通知都不该存在
    // （状态已改由 `ConversationView.skills` 承载，见上一条用例）
    assert.equal(describeSkillWarnings(loaded), null);
  });
});

describe("toViewSkills", () => {
  test("按来源下标判层级，并把 disableModelInvocation 翻成 modelInvocable", () => {
    const loaded: LoadedSkills = {
      // 顺序即 dedupeByName 的输出：a（项目级）、c（项目级但禁模型自选）、b（用户级）
      skills: [skill("a"), { ...skill("c"), disableModelInvocation: true }, skill("b")],
      disabled: [],
      disabledByUser: [],
      shadowed: [],
      sources: [0, 0, 1],
      diagnostics: [],
      counts: [2, 1],
      dirSources: ["project", "user"],
    };
    assert.deepEqual(toViewSkills(loaded), [
      {
        name: "a",
        description: "a 的说明",
        source: "project",
        modelInvocable: true,
        filePath: "a/SKILL.md",
        disabled: false,
      },
      {
        name: "c",
        description: "c 的说明",
        source: "project",
        modelInvocable: false,
        filePath: "c/SKILL.md",
        disabled: false,
      },
      {
        name: "b",
        description: "b 的说明",
        source: "user",
        modelInvocable: true,
        filePath: "b/SKILL.md",
        disabled: false,
      },
    ]);
    // 不依赖「路径里像不像项目目录」去猜层级——`skill()` 造的路径里根本没有项目根
    assert.equal(loaded.skills[1]?.filePath, "c/SKILL.md");
  });
});

describe("skillPathMatcher（P3：判一次 read 是不是在读技能文件）", () => {
  const cwd = join("/proj");
  const views: ViewSkill[] = [
    {
      name: "pdf",
      description: "处理 PDF",
      source: "project",
      modelInvocable: true,
      filePath: join(cwd, ".agents", "skills", "pdf", "SKILL.md"),
      disabled: false,
    },
    {
      name: "brand",
      description: "品牌规范",
      source: "user",
      modelInvocable: true,
      filePath: join("/home/u", ".agents", "skills", "brand", "SKILL.md"),
      disabled: false,
    },
  ];

  test("绝对路径（模型照抄系统提示词里的 location）命中", () => {
    const match = skillPathMatcher(views, cwd);
    assert.equal(match(views[0]!.filePath), "pdf");
    assert.equal(match(views[1]!.filePath), "brand");
  });

  test("相对路径按 cwd 解析后也命中，反斜杠分隔符不影响", () => {
    const match = skillPathMatcher(views, cwd);
    assert.equal(match(".agents/skills/pdf/SKILL.md"), "pdf");
    assert.equal(match(".agents\\skills\\pdf\\SKILL.md"), "pdf");
  });

  test("技能目录里的**其它**文件不算命中（那是引用文件，不是技能本体）", () => {
    assert.equal(
      skillPathMatcher(views, cwd)(".agents/skills/pdf/references/note.md"),
      undefined,
    );
  });

  test("无关文件与空清单都不命中", () => {
    assert.equal(skillPathMatcher(views, cwd)("src/index.ts"), undefined);
    assert.equal(skillPathMatcher([], cwd)("src/index.ts"), undefined);
  });
});

describe("capSkillBodies（P7：正文超限截断 + 指回文件）", () => {
  /** 正文长度可调的技能；`loadedOf` 只造本模块关心的字段 */
  const big = (length: number): Skill => ({
    name: "big",
    description: "很长的技能",
    content: "x".repeat(length),
    filePath: "/p/.agents/skills/big/SKILL.md",
  });
  const loadedOf = (skills: Skill[], disabled: string[] = []): LoadedSkills => ({
    skills,
    shadowed: [],
    diagnostics: [],
    counts: [skills.length],
    sources: skills.map(() => 0),
    dirSources: ["project"],
    disabled,
    disabledByUser: [],
  });

  test("不超限时**原样**返回（同一个对象，不复制、不加标记）", () => {
    const skill = big(MAX_SKILL_BODY_CHARS);
    assert.equal(capSkillBodies([skill])[0], skill);
  });

  test("超限时截到上限，并在尾部指回文件（被裁掉的尾部仍可 read 到）", () => {
    const skill = big(MAX_SKILL_BODY_CHARS + 500);
    const [capped] = capSkillBodies([skill]);
    assert.ok(capped !== undefined);
    assert.ok(capped.content.length < skill.content.length);
    assert.ok(capped.content.startsWith("x".repeat(MAX_SKILL_BODY_CHARS)));
    assert.match(capped.content, /正文过长已截断/);
    assert.match(capped.content, /big\/SKILL\.md/, "要让模型知道完整内容在哪");
    assert.equal(capped.name, "big");
    assert.equal(capped.filePath, skill.filePath, "只动正文，其余字段原样");
    // 装载结果本身**不被改动**——设置页「查看正文」要看全文
    assert.equal(skill.content.length, MAX_SKILL_BODY_CHARS + 500);
  });

  test("告警如实说「模型只收到截断后的正文」并点名（不静默）", () => {
    const parts = skillWarningParts(loadedOf([big(MAX_SKILL_BODY_CHARS + 1)]));
    assert.equal(parts.length, 1);
    assert.match(parts[0] ?? "", new RegExp(`超过 ${MAX_SKILL_BODY_CHARS} 字符`));
    assert.match(parts[0] ?? "", /big/);
  });

  test("限内一条告警都不发（不制造噪音）", () => {
    assert.deepEqual(skillWarningParts(loadedOf([big(MAX_SKILL_BODY_CHARS)])), []);
  });
});

describe("toSkillDetails（P6：设置页看全文）", () => {
  test("在 ViewSkill 之上带**全文**正文（不是给模型那份截断后的副本）", () => {
    const long = "y".repeat(MAX_SKILL_BODY_CHARS + 100);
    const loaded: LoadedSkills = {
      skills: [
        { name: "big", description: "很长的技能", content: long, filePath: "/p/.agents/skills/big/SKILL.md" },
      ],
      disabled: [],
      disabledByUser: [],
      shadowed: [],
      sources: [0],
      diagnostics: [],
      counts: [1],
      dirSources: ["project"],
    };
    const [detail] = toSkillDetails(loaded);
    assert.ok(detail !== undefined);
    assert.equal(detail.name, "big");
    assert.equal(detail.source, "project");
    assert.equal(detail.modelInvocable, true);
    assert.equal(detail.content, long, "详情给的是全文");
    assert.equal(detail.disabled, false);
    assert.equal(detail.disabledByUser, false);
  });

  test("禁用的技能**仍然列出**（否则设置页没有地方把它开回来），并标出是哪一层禁的", () => {
    const loaded: LoadedSkills = {
      skills: [skill("a"), skill("b")],
      disabled: ["a", "b"],
      disabledByUser: ["b"],
      shadowed: [],
      sources: [0, 0],
      diagnostics: [],
      counts: [2],
      dirSources: ["project"],
    };
    const details = toSkillDetails(loaded);
    assert.deepEqual(
      details.map((item) => [item.name, item.disabled, item.disabledByUser]),
      [
        ["a", true, false],
        ["b", true, true],
      ],
    );
  });
});

describe("enabledSkills / modelSkills（P6：禁用 = 完全不装载）", () => {
  test("被禁用的不进给模型那一份；没禁用时**原样**返回（不复制）", () => {
    const loaded: LoadedSkills = {
      skills: [skill("a"), skill("b")],
      disabled: ["b"],
      disabledByUser: [],
      shadowed: [],
      sources: [0, 0],
      diagnostics: [],
      counts: [2],
      dirSources: ["project"],
    };
    assert.deepEqual(
      enabledSkills(loaded).map((item) => item.name),
      ["a"],
    );
    assert.equal(
      enabledSkills({ ...loaded, disabled: [] }),
      loaded.skills,
      "没有禁用项时不该制造一次无谓的复制",
    );
  });

  test("modelSkills 是「先滤禁用、再截断」——两道关都要过", () => {
    const long = "z".repeat(MAX_SKILL_BODY_CHARS + 10);
    const loaded: LoadedSkills = {
      skills: [skill("a"), { ...skill("big"), content: long }],
      disabled: ["big"],
      disabledByUser: [],
      shadowed: [],
      sources: [0, 0],
      diagnostics: [],
      counts: [2],
      dirSources: ["project"],
    };
    // big 被禁用 → 连截断都不必做（它压根不进模型上下文）
    assert.deepEqual(
      modelSkills(loaded).map((item) => item.name),
      ["a"],
    );
    // 解开禁用后，截断那道关照样生效
    const capped = modelSkills({ ...loaded, disabled: [] }).find((item) => item.name === "big");
    assert.ok(capped !== undefined);
    // ⚠️ 别拿「变短了」当判据：尾部那句「完整内容见 <路径>」也是字数，**刚好超限**的正文
    // 截完反而更长。判据要落在语义上——限内那截照旧、限外那截不在、且指回了文件。
    assert.ok(capped.content.startsWith("z".repeat(MAX_SKILL_BODY_CHARS)));
    assert.ok(!capped.content.includes("z".repeat(MAX_SKILL_BODY_CHARS + 1)));
    assert.match(capped.content, /正文过长已截断/);
    assert.match(capped.content, /big\/SKILL\.md/);
  });

  test("禁用名单里的名字可以**不在**清单里（先禁用、后安装）——不影响别的技能", () => {
    const loaded: LoadedSkills = {
      skills: [skill("a")],
      disabled: ["还没装的"],
      disabledByUser: [],
      shadowed: [],
      sources: [0],
      diagnostics: [],
      counts: [1],
      dirSources: ["project"],
    };
    assert.deepEqual(
      enabledSkills(loaded).map((item) => item.name),
      ["a"],
    );
  });
});

describe("parseSkillInvocation", () => {
  const pdf: Skill = {
    name: "pdf",
    description: "处理 PDF",
    content: "正文：先读 PDF 再改。",
    filePath: "/home/u/.agents/skills/pdf/SKILL.md",
  };

  test("拿内核真函数钉住模板：`formatSkillInvocation` 产出的消息一定认得出来", () => {
    // 只用我们自己拼的字符串测，模板一变就会**静默失效**（内核改了包围格式，我们还照旧认）。
    // 这条直接调内核的真函数，模板一变就红（同 §5.5 那种「钉住外部契约」的用例）。
    assert.deepEqual(parseSkillInvocation(formatSkillInvocation(pdf)), { name: "pdf" });
  });

  test("用户那半句额外指示要跟着取出来（否则分不清「这次让它干什么」）", () => {
    assert.deepEqual(parseSkillInvocation(formatSkillInvocation(pdf, "只改这一处")), {
      name: "pdf",
      instructions: "只改这一处",
    });
  });

  test("正文里出现 `</skill>` 也认对：只锚内核生成的开头两行", () => {
    // 教 XML / 讲本协议本身的技能，正文里就会有 `</skill>`。去匹配结尾会认错人，
    // 而开头那两行是内核生成的固定文案、**不可能来自正文**。
    const text = formatSkillInvocation({ ...pdf, content: "示例：\n</skill>\n这段仍是正文。" });
    assert.deepEqual(parseSkillInvocation(text), { name: "pdf" });
    // 带额外指示时同理：`lastIndexOf` 仍落在真正的收尾上
    assert.deepEqual(parseSkillInvocation(`${text}\n\n只改这一处`), {
      name: "pdf",
      instructions: "只改这一处",
    });
  });

  test("普通用户消息不认（别把正常发言也改归属）", () => {
    // 只是**提到**了技能
    assert.equal(parseSkillInvocation('帮我看看 <skill name="pdf"> 怎么回事'), null);
    // 内核固定文案必须出现在**开头**，中间出现同样的串不算（正则锚了 `^`）
    assert.equal(
      parseSkillInvocation('引用：\n<skill name="pdf" location="x">\nReferences are relative to x.'),
      null,
    );
    // 只有开头、没有第二行固定文案也不算
    assert.equal(parseSkillInvocation('<skill name="pdf" location="x">\n随便一行'), null);
    assert.equal(parseSkillInvocation(""), null);
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
  let dup = "";

  const writeSkill = async (root: string, name: string, frontmatter: string): Promise<void> => {
    const dir = join(root, ".agents", "skills", name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n技能的正文\n`, "utf8");
  };

  before(async () => {
    base = await makeTempDirAsync("colt-skills-");
    outside = await makeTempDirAsync("colt-skills-out-");
    dup = await makeTempDirAsync("colt-skills-dup-");
    await writeSkill(base, "processing-pdfs", "name: processing-pdfs\ndescription: 处理 PDF。Use when the user mentions PDFs.");
    await writeSkill(outside, "user-level", "name: user-level\ndescription: 用户级技能。");
    await writeSkill(base, "broken-skill", "name: broken-skill");
    // 两个**不同目录**里放出**同一个**技能名（frontmatter 的 name 压过目录名）：
    // 内核只对「name ≠ 目录名」告警、不丢弃，于是同一来源里会返回两条同名技能
    await writeSkill(dup, "dup-a", "name: dup-name\ndescription: 甲。");
    await writeSkill(dup, "dup-b", "name: dup-name\ndescription: 乙。");
  });

  after(async () => {
    await removeTempDirAsync(base, outside, dup);
  });

  test("标准目录里的 SKILL.md 装得出来；工作区外的用户级目录同样读得到", async () => {
    const env = new NodeExecutionEnv({ cwd: base });
    const loaded = await loadSkillsForSession(
      env,
      [
        { dir: join(base, ".agents", "skills"), source: "project" },
        { dir: join(outside, ".agents", "skills"), source: "user" },
      ],
      BACKGROUND_CONTEXT,
    );
    assert.deepEqual(loaded.skills.map((item) => item.name).sort(), ["processing-pdfs", "user-level"]);
    assert.deepEqual(loaded.counts, [1, 1]);
    // 来源下标随技能一一对应：项目级目录在前，故 user-level 的 sources 是 1
    assert.equal(loaded.sources[loaded.skills.findIndex((item) => item.name === "user-level")], 1);
    const pdf = loaded.skills.find((item) => item.name === "processing-pdfs");
    assert.equal(pdf?.description, "处理 PDF。Use when the user mentions PDFs.");
    assert.equal(pdf?.content, "技能的正文");
    assert.ok(pdf?.filePath.endsWith(join("processing-pdfs", "SKILL.md")), pdf?.filePath ?? "");
  });

  test("真装载的技能进了系统提示词，且给模型的位置是**绝对路径**（否则用户级技能读不到）", async () => {
    const env = new NodeExecutionEnv({ cwd: base });
    const loaded = await loadSkillsForSession(
      env,
      [{ dir: join(base, ".agents", "skills"), source: "project" }],
      BACKGROUND_CONTEXT,
    );
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
    const loaded = await loadSkillsForSession(
      env,
      [{ dir: join(base, ".agents", "skills"), source: "project" }],
      BACKGROUND_CONTEXT,
    );
    assert.deepEqual(loaded.skills.map((item) => item.name), ["processing-pdfs"]);
    assert.ok(loaded.diagnostics.some((item) => item.code === "invalid_metadata"));
    assert.ok(describeSkillWarnings(loaded)?.includes("元数据不合法"));
  });

  test("目录不存在时静默跳过（不报错、不产生噪音）", async () => {
    const env = new NodeExecutionEnv({ cwd: base });
    const loaded = await loadSkillsForSession(
      env,
      [{ dir: join(base, "nope", "skills"), source: "project" }],
      BACKGROUND_CONTEXT,
    );
    assert.deepEqual(loaded.skills, []);
    assert.deepEqual(loaded.diagnostics, []);
    assert.equal(describeSkillWarnings(loaded), null);
  });

  test("同一来源内重名：内核不去重（返回两条），由我们兜住并**按同目录口径**告知", async () => {
    const env = new NodeExecutionEnv({ cwd: dup });
    const loaded = await loadSkillsForSession(
      env,
      [{ dir: join(dup, ".agents", "skills"), source: "project" }],
      BACKGROUND_CONTEXT,
    );
    // 去重后只剩一条，且被遮蔽的那条 `from === by`（同目录），**不是**「项目级盖用户级」
    assert.deepEqual(loaded.skills.map((item) => item.name), ["dup-name"]);
    assert.deepEqual(loaded.shadowed, [{ name: "dup-name", from: 0, by: 0 }]);
    assert.deepEqual(loaded.sources, [0]);
    assert.deepEqual(loaded.counts, [1]);
    const notice = describeSkillWarnings(loaded);
    assert.ok(notice?.includes("同一目录下有同名技能"), notice ?? "");
    assert.ok(!notice?.includes("项目级覆盖了同名用户级技能"), notice ?? "");
  });
});

describe("基础系统提示词里的技能段", () => {
  // 这一段防的是一件实测发生过的事：第三方安装文档教的目录（`~/.claude/skills`、
  // `~/.openclaw/workspace/skills`、`~/.workbuddy/skills`……）本产品**一律不读**，
  // 照它装完零效果，而人还以为装上了。提示词里给的目录必须与 `skillDirSources` 的真源同源。
  test("给出的目录是 .agents/skills，且不出现本产品不读的那些位置", () => {
    const prompt = systemPrompt("E:/proj");
    assert.ok(prompt.includes(".agents/skills"), "提示词必须给出 .agents/skills");
    for (const wrong of [".claude/skills", ".openclaw", ".workbuddy", ".codex/skills"]) {
      assert.ok(!prompt.includes(wrong), `提示词不该出现本产品不读的目录：${wrong}`);
    }
  });

  test("三件必说的事都在：放进去即装 / 重新扫描生效 / 装前通读的纪律", () => {
    const prompt = systemPrompt("E:/proj");
    assert.ok(prompt.includes("放进去即装"), "要说清装的方式就是一个目录一个 SKILL.md");
    assert.ok(prompt.includes("重新扫描"), "要说清改完在设置页重新扫描即生效");
    // 「装第三方技能前先通读全文」——这次实测里，唯一挡住那个包的就是逐段把它读完了
    assert.ok(prompt.includes("通读"), "必须要求落地前通读 SKILL.md 全文");
    // 没有安装接口这件事也要说出来，否则模型会去找一个不存在的 skills.install
    assert.ok(prompt.includes("没有技能的下载"), "要说明本产品不提供下载 / 安装接口");
  });
});

describe("内置技能（随应用分发）", () => {
  const builtinDir = (): SkillDir => ({ dir: builtinSkillsDir(), source: "builtin" });

  test("内置目录里装得出 skill-creator，来源标成 builtin", async () => {
    const env = new NodeExecutionEnv({ cwd: process.cwd() });
    const loaded = await loadSkillsForSession(env, [builtinDir()], BACKGROUND_CONTEXT);
    const names = loaded.skills.map((item) => item.name);
    assert.ok(
      names.includes("skill-creator"),
      `内置目录应当装出 skill-creator，实得：${names.join("、") || "（空）"}`,
    );
    assert.deepEqual(loaded.dirSources, ["builtin"]);
    assert.deepEqual(
      toViewSkills(loaded).map((item) => item.source),
      ["builtin"],
    );
  });

  test("内置压在最底层：磁盘上的同名技能可以盖掉它（与内置子代理同一口径）", async () => {
    const projectRoot = await makeTempDirAsync("colt-skill-shadow");
    try {
      const dir = join(projectRoot, ".agents", "skills", "skill-creator");
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "SKILL.md"),
        "---\nname: skill-creator\ndescription: 项目自带的同名技能\n---\n\n正文\n",
        "utf8",
      );
      const env = new NodeExecutionEnv({ cwd: projectRoot });
      const loaded = await loadSkillsForSession(
        env,
        [{ dir: join(projectRoot, ".agents", "skills"), source: "project" }, builtinDir()],
        BACKGROUND_CONTEXT,
      );
      const target = toViewSkills(loaded).find((item) => item.name === "skill-creator");
      assert.equal(target?.source, "project", "同名的项目级技能应当胜出");
      assert.equal(target?.description, "项目自带的同名技能");
      // 被遮蔽的那份也要如实报出来：内置被项目级盖掉，用户有权知道——而且**得说对是谁盖的**
      // （这句文案在真实装载链上再钉一次，防止 `skillWarningParts` 里那套按层级生成的说法
      // 只在手工夹具上成立）
      assert.ok(loaded.shadowed.some((item) => item.name === "skill-creator"));
      const notice = describeSkillWarnings(loaded);
      assert.ok(
        notice?.includes("项目级覆盖了同名内置技能：skill-creator"),
        notice ?? "（没有告警）",
      );
    } finally {
      await removeTempDirAsync(projectRoot);
    }
  });

  test("内置技能的正文没超它自己讲的那条上限（否则自相矛盾）", async () => {
    const env = new NodeExecutionEnv({ cwd: process.cwd() });
    const loaded = await loadSkillsForSession(env, [builtinDir()], BACKGROUND_CONTEXT);
    const skill = loaded.skills.find((item) => item.name === "skill-creator");
    assert.ok(skill !== undefined, "先确保装出来了，否则下面这条是假绿");
    assert.ok(
      skill.content.length <= MAX_SKILL_BODY_CHARS,
      `正文 ${skill.content.length} 字符，超过模型侧上限 ${MAX_SKILL_BODY_CHARS}——` +
        "而这个技能自己讲的就是「超了只收到前半」",
    );
    // 上面那条只保证「没超」，不保证「文里说的数字是对的」：正文是散文，写死一个数
    // （「正文超过 8000 字符时…」）而常量改了它不会红——正是这个技能自己讲的那类自相矛盾
    // （同一手法见 `tests/limits.test.ts`：两侧不许各写一份）。
    assert.ok(
      skill.content.includes(String(MAX_SKILL_BODY_CHARS)),
      `SKILL.md 正文里要出现实际上限 ${MAX_SKILL_BODY_CHARS}（改了常量就得改这段散文）`,
    );
  });

  test("装载结果与投影不同源时**当场抛**，不给一个看着合理的假标签", () => {
    // 兜底（如 `?? "user"`）会给出「必然为真」的标签：界面上每条都标成用户级，没人会去查。
    // 抛出去会沿 `init` 变成 fatal（会话打不开）——这是有意的取舍，故在这里钉住行为本身。
    const broken: LoadedSkills = {
      skills: [skill("a")],
      disabled: [],
      disabledByUser: [],
      shadowed: [],
      sources: [2],
      diagnostics: [],
      counts: [1],
      dirSources: ["project"],
    };
    assert.throws(() => toViewSkills(broken), /来源下标越界/);
    assert.throws(() => skillWarningParts({ ...broken, shadowed: [{ name: "a", from: 9, by: 0 }] }), /来源下标越界/);
  });
});
