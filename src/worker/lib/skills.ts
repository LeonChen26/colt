/**
 * 技能（Agent Skills）的发现与装载——格式与目录都走开放标准 agentskills.io，
 * 这样社区技能包可以**直接丢进来**用。
 *
 * 递归遍历、ignore 文件（`.gitignore` / `.ignore` / `.fdignore`）、frontmatter 校验
 * 全部由内核的 `loadSkills` 负责；我们只决定**取哪几个目录**和**同名怎么取舍**。
 *
 * 目录：项目级 `<cwd>/.agents/skills` 在前、用户级 `~/.agents/skills` 在后，
 * 同名时**项目级胜出**（标准里的优先级就是这么定的），被遮蔽的名字如实报出来。
 */
import { join } from "node:path";
import { loadSkills, type Context, type ExecutionEnv, type Skill, type SkillDiagnostic } from "@earendil-works/pi-agent-core";

/** 技能目录（**项目级在前**，同名时它胜出） */
export function skillDirs(cwd: string, home: string): string[] {
  return [join(cwd, ".agents", "skills"), join(home, ".agents", "skills")];
}

export interface LoadedSkills {
  skills: Skill[];
  /** 被项目级同名技能遮蔽掉的用户级技能名（如实告知，别让用户以为它在生效） */
  shadowed: string[];
  /** 装载过程中的告警（内核诊断 + 我们自己合成的失败项） */
  diagnostics: SkillDiagnostic[];
  /** 每个来源目录装到的技能数，与传进去的目录一一对应 */
  counts: number[];
}

/**
 * 同名只留第一个（各来源按优先级传入 → 先到的胜出），后面的名字如实收集。
 *
 * 不做去重的话同一个技能名会出现两条、模型看到重复项，而**用户级那份到底有没有生效
 * 全看内核的遍历顺序**——属于界面上看不出来、也没人会去查的那类错。
 */
export function dedupeByName(groups: Skill[][]): { skills: Skill[]; shadowed: string[] } {
  const skills: Skill[] = [];
  const shadowed: string[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const skill of group) {
      if (seen.has(skill.name)) {
        shadowed.push(skill.name);
        continue;
      }
      seen.add(skill.name);
      skills.push(skill);
    }
  }
  return { skills, shadowed };
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
  dirs: string[],
  context: Context,
): Promise<LoadedSkills> {
  const groups: Skill[][] = [];
  const diagnostics: SkillDiagnostic[] = [];
  for (const dir of dirs) {
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
  const { skills, shadowed } = dedupeByName(groups);
  return { skills, shadowed, diagnostics, counts: groups.map((group) => group.length) };
}

/** 告警最多列几条——列满屏就不是提示了，超出部分只报个数 */
export const MAX_NOTICE_DIAGNOSTICS = 3;

/**
 * 组装一条如实的提示；**没什么可说时返回 null**，不制造噪音。
 *
 * 提示的存在理由是「隐式信任要可见」：技能来自磁盘、会进系统提示词，
 * 用户有权知道装了什么、跳过了什么。见 `docs/SECURITY.md`。
 */
export function describeSkills(loaded: LoadedSkills): string | null {
  const parts: string[] = [];
  const project = loaded.counts[0] ?? 0;
  const elsewhere = loaded.skills.length - project;
  if (loaded.skills.length > 0) {
    parts.push(`已加载 ${loaded.skills.length} 个技能（项目级 ${project} · 用户级 ${elsewhere}）`);
  }
  if (loaded.shadowed.length > 0) {
    parts.push(`项目级覆盖了同名用户级技能：${loaded.shadowed.join("、")}`);
  }
  if (loaded.diagnostics.length > 0) {
    const shown = loaded.diagnostics.slice(0, MAX_NOTICE_DIAGNOSTICS).map(describeDiagnostic);
    const rest = loaded.diagnostics.length - shown.length;
    parts.push(
      `技能告警 ${loaded.diagnostics.length} 条：${shown.join("；")}${rest > 0 ? `（另有 ${rest} 条）` : ""}`,
    );
  }
  return parts.length > 0 ? parts.join("；") : null;
}
