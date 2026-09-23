// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 技能（Agent Skills）的发现与装载——格式与目录都走开放标准 agentskills.io，
 * 这样社区技能包可以**直接丢进来**用。
 *
 * 递归遍历、ignore 文件（`.gitignore` / `.ignore` / `.fdignore`）、frontmatter 校验
 * 全部由内核的 `loadSkills` 负责；我们只决定**取哪几个目录**和**同名怎么取舍**。
 *
 * 目录（**顺序即优先级，先到者胜出**）：
 * 1. 项目级 `<cwd>/.agents/skills`——随仓库分发；
 * 2. 用户级 `~/.agents/skills`——用户自己的、跨项目；
 * 3. 内置 `worker/lib/builtin-skills/`——随应用分发，**优先级最低**（磁盘上的同名技能可盖它）。
 * 被遮蔽的名字如实报出来。
 *
 * 内核的机制是**两套、缺一不可**：
 * 1. 让模型**看见**——`formatSkillsForSystemPrompt` 生成 `<available_skills>` 块，
 *    **内核只提供这个函数、不会自己调用**，得由应用拼进自己的系统提示词（见 `composeSystemPrompt`）；
 * 2. 让应用**按名调用**——把 skills 放进 `resources.skills`，内核在 `lane.skill(name, …)`
 *    时按名取出整份正文。只做第 2 条的话模型不知道技能存在，整个接入是空转。
 */
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  formatSkillsForSystemPrompt,
  loadSkills,
  type Context,
  type ExecutionEnv,
  type Skill,
  type SkillDiagnostic,
} from "@earendil-works/pi-agent-core";
import type { ViewSkill, ViewSkillDetail, ViewSkillInvocation } from "@shared/worker-protocol";
import { loadSkillsConfig, skillsConfigPath } from "@shared/skills-config";

/** 一个技能目录，以及它在界面上的**来源层级** */
export interface SkillDir {
  dir: string;
  source: ViewSkill["source"];
}

/**
 * 内置技能目录——随应用分发的技能（`worker/lib/builtin-skills/`，构建时复制到 `out/main/`）。
 *
 * 与用户目录的区别：它**不在用户的磁盘管辖范围**内（删不掉、也改不了，安装包里那份是产物），
 * 所以它只是**兜底**：优先级最低，磁盘上的同名技能可以盖它（与内置子代理同一个口径，
 * 见 `lib/agent-defs.ts` 里 `builtinAgentDefs()` 排在最后）。
 *
 * `COLT_BUILTIN_SKILLS_DIR` 可覆盖它：测试与冒烟靠这个口把内置技能指到受控目录
 * （与 `skillsUserHome` 同一套路）。不给这个口，任何断言「装了几个技能」的用例都会被
 * 随包技能污染——而那种污染只在**换机器或加内置技能时**才发作。
 */
export function builtinSkillsDir(): string {
  const override = process.env.COLT_BUILTIN_SKILLS_DIR;
  if (override !== undefined && override !== "") return override;
  // 相对**本模块所在目录**定位：构建后它在 `out/main/worker.js`，与 `builtin-skills/` 同级。
  // 但这有个隐含前提——**这个模块自己待在 worker.js 里，没被 vite 拆进 chunk**。真被拆进
  // `out/main/chunks/` 时 dirname 就成了 `chunks/`，同级那份根本不存在，而症状是**装了几个
  // 技能静默少一个**（内核扫不到目录不报错，只交回空清单），正是本项目反复踩的那类失败。
  // 所以两个布局都认一下，退回上一级。
  const beside = join(import.meta.dirname, "builtin-skills");
  return existsSync(beside) ? beside : join(import.meta.dirname, "..", "builtin-skills");
}

/**
 * 装载时要扫的全部技能目录——**顺序即优先级，先到者胜出**。
 *
 * 内置排最后是刻意的：项目级（随仓库走）要能盖掉它，用户级（用户自己的）也要能盖掉它。
 */
export function skillDirSources(cwd: string, home: string): SkillDir[] {
  return [
    { dir: join(cwd, ".agents", "skills"), source: "project" },
    { dir: join(home, ".agents", "skills"), source: "user" },
    { dir: builtinSkillsDir(), source: "builtin" },
  ];
}

/**
 * 被遮蔽的一份技能：谁遮了谁。
 *
 * 为什么必须带上来源下标：重名有两种、说法完全不同——**跨来源**（项目级盖用户级）与
 * **同目录内重名**（内核不去重：`name ≠ 目录名` 只告警、不丢弃，见内核
 * `loadSkillsFromDirInternal` / `validateName`）。只记名字的话，第二种会被报成
 * 「项目级覆盖了同名用户级技能」——**一句假话**，而这个模块存在的全部意义就是如实告知。
 */
export interface ShadowedSkill {
  name: string;
  /** 被遮蔽者所在的来源目录下标（`dirs` 的顺序） */
  from: number;
  /** 生效者所在的来源目录下标；`from === by` 即「同名重复出现在**同一个**目录里」 */
  by: number;
}

export interface LoadedSkills {
  skills: Skill[];
  shadowed: ShadowedSkill[];
  /** 装载过程中的告警（内核诊断 + 我们自己合成的失败项） */
  diagnostics: SkillDiagnostic[];
  /**
   * 去重**后**各来源目录贡献的技能数，与传进去的目录一一对应。
   * **求和恒等于 `skills.length`**——按来源归因才是对的，否则「用户级 = 总数 − 项目级」
   * 在同目录重名时会算出负数。
   */
  counts: number[];
  /**
   * 与 `skills` **一一对应**的来源目录下标（`dirs` 的顺序）。
   * 视图要回答「这个技能是项目级还是用户级」，仅凭 `counts` 是推不出来的。
   */
  sources: number[];
  /**
   * 与 `counts` 一一对应的**目录来源标签**（下标 → 层级）。`sources` 给的是下标，
   * 而视图要的是「项目级 / 用户级 / 内置」这三个字，故在这里把映射固定下来——
   * 别在渲染层去猜「路径像不像项目目录」（内置加进来之后，那种猜法必然错）。
   */
  dirSources: ViewSkill["source"][];
  /**
   * **使用者禁用**的技能名（`.colt/skills.json` 与 `~/.colt/skills.json` 的并集，
   * 见 `@shared/skills-config`）。禁用 = **完全不装载**：不进提示词、模型看不见、
   * 显式调用被拒。名字可以**不在** `skills` 里（先禁用、后安装）——故它独立保存。
   */
  disabled: string[];
  /** `disabled` 里来自**用户级**配置的那部分（设置页据此把开关置灰并说明） */
  disabledByUser: string[];
}

/** 来源层级的中文说法（告警文案用）。缺一档 TS 会当场报错——别写成三元链 */
const SOURCE_TEXT: Record<ViewSkill["source"], string> = {
  project: "项目级",
  user: "用户级",
  builtin: "内置",
};

/**
 * 来源下标 → 层级。**不猜「路径像不像项目目录」**——内置加进来之后，那种猜法必然错
 * （`dirSources` 就是装载时按目录顺序定下来的那份映射）。
 *
 * 越界时**抛**、不兜底：两者不同源只可能是装载与投影脱了钩（`dirSources` 少给了一项），
 * 而兜底值会给出一个看着合理、其实**必然为真**的假标签，界面上再没人会对它起疑——
 * 比一条红断言贵得多（`AGENTS.md` §四）。代价要说清：这条路径在 `init` 上，抛出去会变成
 * **会话打不开**（`worker/entry.ts` 把 `init` 的失败标成 fatal）。这是**有意**的取舍：
 * 宁可打不开、也不给假标签；`tests/skills.test.ts` 有一条用例把这个行为钉住。
 */
function sourceOf(loaded: LoadedSkills, index: number | undefined): ViewSkill["source"] {
  const label = index === undefined ? undefined : loaded.dirSources[index];
  if (label === undefined) {
    throw new Error(
      `技能来源下标越界（${String(index)}）：装载结果的 dirSources 有 ${loaded.dirSources.length} 项、` +
        `sources 有 ${loaded.sources.length} 项，两者不同源`,
    );
  }
  return label;
}

/** 同上，直接给中文（告警文案用） */
function sourceText(loaded: LoadedSkills, index: number | undefined): string {
  return SOURCE_TEXT[sourceOf(loaded, index)];
}

/**
 * 可交给模型的技能（滤掉被禁用的）：`resources.skills` 与系统提示词的**共同输入**。
 * 两者必须同源——只滤一处会出现「提示词里没有、却能按名调用」或者反过来的错位。
 */
export function enabledSkills(loaded: LoadedSkills): Skill[] {
  if (loaded.disabled.length === 0) return loaded.skills;
  const off = new Set(loaded.disabled);
  return loaded.skills.filter((skill) => !off.has(skill.name));
}

/** 给模型的最终副本：先滤掉被禁用的，再对超长正文截断 + 指回文件（P7） */
export function modelSkills(loaded: LoadedSkills): Skill[] {
  return capSkillBodies(enabledSkills(loaded));
}

/**
 * 同名只留第一个（各来源按优先级传入 → 先到的胜出），后面的**连来源一起**如实收集。
 *
 * 不做去重的话同一个技能名会出现两条、模型看到重复项，而**用户级那份到底有没有生效
 * 全看内核的遍历顺序**——属于界面上看不出来、也没人会去查的那类错。
 *
 * 同时按来源累计**去重后**的贡献数（`counts`）并给出每个技能的来源下标（`sources`）：
 * `counts` 求和恒等于 `skills` 的长度，故「非项目级」的算法不会再算出负数；
 * `sources` 则让视图能回答「这份技能来自哪一层」（见 `ShadowedSkill` 的说明）。
 */
export function dedupeByName(groups: Skill[][]): {
  skills: Skill[];
  shadowed: ShadowedSkill[];
  sources: number[];
  counts: number[];
} {
  const skills: Skill[] = [];
  const shadowed: ShadowedSkill[] = [];
  const sources: number[] = [];
  const counts = groups.map(() => 0);
  // 别叫 `sourceOf`——模块级那个同名函数干的是「下标 → 层级」，这里记的是「名字 → 谁先占的」，
  // 遮蔽之后函数里再调 `sourceOf(...)` 会命中这个 Map，抛一个与现场无关的 TypeError
  const claimedBy = new Map<string, number>();
  groups.forEach((group, index) => {
    for (const skill of group) {
      const by = claimedBy.get(skill.name);
      if (by !== undefined) {
        shadowed.push({ name: skill.name, from: index, by });
        continue;
      }
      claimedBy.set(skill.name, index);
      skills.push(skill);
      sources.push(index);
      counts[index] += 1;
    }
  });
  return { skills, shadowed, sources, counts };
}

/** 路径末两段（`pdf-processing/SKILL.md`）——比绝对路径短，又足够定位 */
function tail2(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/).filter((part) => part !== "");
  return parts.slice(-2).join("/");
}

const DIAGNOSTIC_LABELS: Record<SkillDiagnostic["code"], string> = {
  file_info_failed: "读不到文件信息",
  list_failed: "目录列举失败",
  read_failed: "读文件失败",
  parse_failed: "frontmatter 解析失败",
  invalid_metadata: "元数据不合法",
};

/** 一条告警讲人话：`<技能目录>/<文件>：<中文类目>（内核原文）`——原文保留，便于对照标准排错 */
export function describeDiagnostic(diagnostic: SkillDiagnostic): string {
  const label = DIAGNOSTIC_LABELS[diagnostic.code];
  const head = tail2(diagnostic.path);
  return head === "" ? `${label}（${diagnostic.message}）` : `${head}：${label}（${diagnostic.message}）`;
}

/** 装载指定的各个目录；某个目录炸了也算一条告警，不打断会话（会话能用比技能重要） */
export async function loadSkillsForSession(
  env: ExecutionEnv,
  dirs: SkillDir[],
  context: Context,
  disabled: string[] = [],
  disabledByUser: string[] = [],
): Promise<LoadedSkills> {
  const groups: Skill[][] = [];
  const diagnostics: SkillDiagnostic[] = [];
  for (const { dir } of dirs) {
    try {
      const result = await loadSkills(env, dir, context);
      groups.push(result.skills);
      diagnostics.push(...result.diagnostics);
    } catch (error) {
      groups.push([]);
      diagnostics.push({
        type: "warning",
        code: "read_failed",
        message: error instanceof Error ? error.message : String(error),
        path: dir,
      });
    }
  }
  const { skills, shadowed, sources, counts } = dedupeByName(groups);
  return {
    skills,
    shadowed,
    sources,
    diagnostics,
    counts,
    dirSources: dirs.map((item) => item.source),
    disabled,
    disabledByUser,
  };
}

/**
 * **装载的真身**：读两层偏好（`.colt/skills.json` + `~/.colt/skills.json`）再装载。
 *
 * 为什么把「读配置」和「装载」绑成一步：`reload` 有**两个**调用点（会话启动、重新扫描），
 * 若各处自己读配置，就会出现「重扫时不读偏好、于是被禁用的技能又冒出来」这类只在
 * 一条路径上发作的错。绑在一起，两条路径拿到的必然是同一份口径。
 */
export async function loadSkillsForSessionWithConfig(
  env: ExecutionEnv,
  cwd: string,
  home: string,
  context: Context,
): Promise<LoadedSkills> {
  const config = await loadSkillsConfig(cwd, home);
  const loaded = await loadSkillsForSession(
    env,
    skillDirSources(cwd, home),
    context,
    config.disabled,
    config.fromUser,
  );
  // 配置本身坏掉（坏 JSON / 类型不对）也要如实报——否则用户只见「禁用没生效」，
  // 找不到原因（与 MCP 配置语法错要在界面上说清同一个取向）。
  return {
    ...loaded,
    diagnostics: [
      ...config.diagnostics.map((message) => ({
        type: "warning" as const,
        code: "read_failed" as const,
        message,
        path: skillsConfigPath(cwd),
      })),
      ...loaded.diagnostics,
    ],
  };
}

/**
 * 把技能的 `<available_skills>` 块拼到基础提示词后面。
 *
 * **这一步不能省**：内核只提供 `formatSkillsForSystemPrompt`，自己**从不调用**它
 * （`resources.skills` 在内核里只被「按名显式调用」用到）。不拼的话模型收不到技能清单，
 * 技能就等于没装——而且**失败是静默的**：装载、告警、计数全都正常，只有模型不知道。
 *
 * 块里**不含** `disableModelInvocation` 的技能（内核过滤），所以「已加载」不等于「模型看得见」。
 */
export function composeSystemPrompt(base: string, skills: Skill[]): string {
  const block = formatSkillsForSystemPrompt(skills);
  return block.length === 0 ? base : `${base}\n\n${block}`;
}

/**
 * 技能正文的字符上限（P7）。
 *
 * 技能正文是**整段**进上下文的一条 user 消息（内核 `formatSkillInvocation` 不截断，本仓也
 * 一直没有 cap），于是一个几百行的 `SKILL.md` 被调一次，账单与上下文占用都是隐形的。上限比
 * 记忆块（`MAX_MEMORY_CHARS` 6000）略宽——技能是「怎么做事」的操作说明，需要更多余量。
 */
export const MAX_SKILL_BODY_CHARS = 8000;

/**
 * 给**模型**的那份技能副本：正文超限则截断，并在尾部**指回文件**（照记忆块的口径，
 * 见 `worker/lib/memory.ts`）——被裁掉的尾部仍可达（模型能 `read` 完整文件）。
 *
 * 为什么截的是**副本**、而不是装载结果本身：设置页「查看正文」要给用户看**全文**，
 * 而模型只该收到有界的那份。混用同一份内容会让「用户看到 A、模型收到 B」说不清。
 * 同时也别把这条 cap 加在系统提示词那一步——技能清单（`formatSkillsForSystemPrompt`）
 * 本来就不含正文，加在那里是给一件不发的事设防。
 */
export function capSkillBodies(skills: readonly Skill[]): Skill[] {
  return skills.map((skill) =>
    skill.content.length <= MAX_SKILL_BODY_CHARS
      ? skill
      : {
          ...skill,
          content:
            skill.content.slice(0, MAX_SKILL_BODY_CHARS) +
            `\n\n……（正文过长已截断，完整内容见 ${skill.filePath}，需要时用 read 工具读取）`,
        },
  );
}

/** 告警最多列几条——列满屏就不是提示了，超出部分只报个数 */
export const MAX_NOTICE_DIAGNOSTICS = 3;

/**
 * 组装一条如实的**告警**；没什么可说时返回 null，不制造噪音。
 *
 * 只报**事件**（重名遮蔽、解析失败、以及「不对模型公开」这个会让人误解的配置），
 * **不报状态**（装了几个、都叫什么）。状态由 `ConversationView.skills` 承载、渲染层自己展示；
 * 把它当事件播报的后果是每次 worker 启动都往「事件」页签写一条例行信息
 * （`session_events` 只对 5 分钟内的同内容去重），于是真正需要长期可见的清单反而没地方放、
 * 事件表被灌满。
 *
 * 「不对模型公开」这条保留的理由：它解释的是「装是装了、怎么都不触发」这个体验盲区，
 * 而本轮还没有技能面板可以展示 `ViewSkill.modelInvocable`，不留就等于让用户自己猜。
 *
 * 提示的存在理由是「隐式信任要可见」：技能来自磁盘、会进系统提示词，
 * 用户有权知道跳过了什么、覆盖了什么。见 `docs/SECURITY.md`。
 */
export function describeSkillWarnings(loaded: LoadedSkills): string | null {
  const parts = skillWarningParts(loaded);
  return parts.length > 0 ? parts.join("；") : null;
}

/**
 * `describeSkillWarnings` 的**分条**版本：一段话一个元素，没什么可说时返回空数组。
 *
 * 为什么要把「拼一句话」拆开：设置页「技能」分区要**逐条**列出告警（命中事件页签同一口径），
 * 而不是把一整句带分号的话塞进一个段落。两条路径共用同一份 `parts`，就不会出现
 * 「事件页签说 A、设置页说 B」——文案分头写必然漂。
 */
export function skillWarningParts(loaded: LoadedSkills): string[] {
  const parts: string[] = [];
  // `disableModelInvocation` 的技能**不进**给模型看的清单（内核过滤）——它**不是坏了**，
  // 只是不让模型自己挑，得用户用 `/skill <名字>` 显式调。必须说清是哪一种，
  // 否则用户看到技能装上了却怎么都不触发，会以为技能是坏的。
  const hidden = loaded.skills.filter((skill) => skill.disableModelInvocation === true).length;
  if (hidden > 0) {
    parts.push(
      `有 ${hidden} 个技能不对模型公开（disable-model-invocation）：模型不会自己用，需 /skill <名字> 显式调用`,
    );
  }
  // 正文超限是会改变「模型到底收到什么」的一件事：截断后它只能看到前半部分。
  // 用户有权知道**这个技能的正文没被完整交给模型**（同记忆块的「截断不静默」口径）。
  const truncated = loaded.skills.filter((skill) => skill.content.length > MAX_SKILL_BODY_CHARS);
  if (truncated.length > 0) {
    parts.push(
      `有 ${truncated.length} 个技能正文超过 ${MAX_SKILL_BODY_CHARS} 字符，模型只会收到截断后的正文（完整内容在文件里，模型可按需读取）：${truncated
        .map((skill) => skill.name)
        .join("、")}`,
    );
  }
  if (loaded.shadowed.length > 0) {
    // 重名有两种，**不能共用一句话**（见 `dedupeByName` / `ShadowedSkill`）：
    // 跨来源是「谁盖了谁」——三层之后这句也得**按实际层级说**。内置被项目级同名盖掉时
    // 说成「项目级覆盖了同名用户级技能」是一句假话，而这里正是用户唯一能看到「谁被遮蔽了」
    // 的地方；同目录内重名则与层级毫无关系，另一句话。
    const same = loaded.shadowed.filter((item) => item.from === item.by).map((item) => item.name);
    // 按「谁盖谁」这一对分组：不同层级组合混进一句里，就分不清哪份是真的生效了
    const cross = new Map<string, { by: number; from: number; names: string[] }>();
    for (const item of loaded.shadowed) {
      if (item.from === item.by) continue;
      const key = `${item.by}<${item.from}`;
      const group = cross.get(key) ?? { by: item.by, from: item.from, names: [] };
      group.names.push(item.name);
      cross.set(key, group);
    }
    for (const { by, from, names } of cross.values()) {
      parts.push(
        `${sourceText(loaded, by)}覆盖了同名${sourceText(loaded, from)}技能：${names.join("、")}`,
      );
    }
    if (same.length > 0) {
      parts.push(`同一目录下有同名技能，只保留了先读到的那份：${same.join("、")}`);
    }
  }
  if (loaded.diagnostics.length > 0) {
    const shown = loaded.diagnostics.slice(0, MAX_NOTICE_DIAGNOSTICS).map(describeDiagnostic);
    const rest = loaded.diagnostics.length - shown.length;
    parts.push(
      `技能告警 ${loaded.diagnostics.length} 条：${shown.join("；")}${rest > 0 ? `（另有 ${rest} 条）` : ""}`,
    );
  }
  return parts;
}

/**
 * 装载结果 → 随视图下发的技能清单（`ConversationView.skills`）。
 *
 * 为什么要有这一步：**装载状态该由视图承载**，而不是靠一条 `notice` 播报（见
 * `describeSkillWarnings`）。渲染层拿 `name` 做本地核对，其余字段（来源 / 是否对模型公开 /
 * 路径）是「技能」面板与出处展示的底子。
 *
 * `sources` 与 `skills` **一一对应**（来源目录下标），目录表则由 `dirSources` 给出——
 * 「下标 → 项目级 / 用户级 / 内置」这个映射就在那里，别在这里重排一遍。
 */
export function toViewSkills(loaded: LoadedSkills): ViewSkill[] {
  const off = new Set(loaded.disabled);
  return loaded.skills.map((skill, index) => ({
    name: skill.name,
    description: skill.description,
    // 下标 → 层级标签；越界的处置见 `sourceOf`（抛，不兜底）
    source: sourceOf(loaded, loaded.sources[index]),
    modelInvocable: skill.disableModelInvocation !== true,
    filePath: skill.filePath,
    // 被禁用的**仍然列出来**：设置页要靠它把开关画出来、改回去（不列就没处改）
    disabled: off.has(skill.name),
  }));
}

/**
 * 装载结果 → 设置页「技能」分区的详情（`ViewSkill` + **正文全文**）。
 *
 * 全文来自 `loaded.skills[].content`——那是**没被 `capSkillBodies` 动过**的原样（装载结果
 * 本身不截断，截的只是给模型的那份副本）。所以用户在这里看到的就是文件里那样。
 */
export function toSkillDetails(loaded: LoadedSkills): ViewSkillDetail[] {
  const byUser = new Set(loaded.disabledByUser);
  return toViewSkills(loaded).map((view, index) => ({
    ...view,
    content: loaded.skills[index]?.content ?? "",
    disabledByUser: byUser.has(view.name),
  }));
}

/**
 * 内核 `formatSkillInvocation` 生成的技能调用消息，**开头**长这样：
 *
 * ```
 * <skill name="<名字>" location="<路径>">
 * References are relative to <目录>.
 *
 * <正文>…
 * </skill>
 * ```
 *
 * 只锚**开头这两行**，因为它们是内核生成的固定文案、**不可能来自技能正文**（正文排在它们之后）。
 */
const SKILL_INVOCATION_HEAD =
  /^<skill name="([^"]+)" location="([^"]+)">\nReferences are relative to /;

/** 技能块的收尾（额外指示排在它之后） */
const SKILL_INVOCATION_TAIL = "\n</skill>";

/**
 * 这条 user 消息是**内核替我们发的技能调用**吗？是的话把归属信息取出来。
 *
 * 为什么得靠认模板：内核把技能正文包成一条普通的 `role: "user"` 消息，**没有任何结构化标记**
 * （`acceptRun` 的 `case "skill"`）。不认它，会话流就会把一大段原始 XML 画成「你」说的话，
 * 目录与分支树的标签也会变成 `<skill name="…" location="…">`。
 *
 * 两处刻意的取舍：
 * - **只锚开头，不锚结尾**：技能正文里完全可能出现 `</skill>`（教 XML 的技能就有），
 *   去匹配结尾会认错；开头那两行则不可能来自正文。
 * - 取额外指示用 `lastIndexOf`：正文里出现 `</skill>` 时它仍落在真正的收尾之后，
 *   代价只是「额外指示里恰好写了 `</skill>`」时会截短一点——比把半篇正文当成熟用户的额外指示好。
 */
export function parseSkillInvocation(text: string): ViewSkillInvocation | null {
  const head = SKILL_INVOCATION_HEAD.exec(text);
  if (head === null) return null;
  const name = head[1] ?? "";
  if (name === "") return null;
  const end = text.lastIndexOf(SKILL_INVOCATION_TAIL);
  const instructions = end < 0 ? "" : text.slice(end + SKILL_INVOCATION_TAIL.length).trim();
  return instructions === "" ? { name } : { name, instructions };
}

/** 路径比对用的规范形态：统一分隔符、去尾斜杠；Windows 上再做大小写归一 */
function canonicalPath(path: string): string {
  const unified = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return process.platform === "win32" ? unified.toLowerCase() : unified;
}

/**
 * 造一个「这个路径是不是本会话某个已装载技能的文件」的判定函数（P3 的工具卡标记）。
 *
 * 模型侧用技能的唯一途径是**读文件**（内核没有 skill 工具，见报告 A4），所以「一次 `read`
 * 命中了某个 `SKILL.md`」就是「模型因为技能而改变了行为」的最强信号——没有它，界面上
 * 只剩一张普通 `read` 卡，看不出这次读文件是被技能驱动的。
 *
 * 为什么按**绝对路径**比对：系统提示词里给模型的 `<location>` 就是 `skill.filePath`（内核
 * 保证是绝对路径），模型照抄时命中；但它也可能自己写成相对路径，故先按 `cwd` 解析再比。
 * 目录内其它文件（技能引用的 references 等）**不算**——那些不是「读到了技能本体」。
 */
export function skillPathMatcher(
  skills: readonly ViewSkill[],
  cwd: string,
): (path: string) => string | undefined {
  const index = new Map<string, string>();
  for (const skill of skills) index.set(canonicalPath(skill.filePath), skill.name);
  if (index.size === 0) return () => undefined;
  return (path) => index.get(canonicalPath(isAbsolute(path) ? path : join(cwd, path)));
}
