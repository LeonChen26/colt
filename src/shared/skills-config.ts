// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 技能**使用者偏好**的纯解析层：哪些技能被禁用（`P6` 生命周期里需要「写」的那半）。
 *
 * 为什么不是「技能目录里再放一个文件」：技能目录是 agentskills.io 的标准（`SKILL.md`），
 * 往里塞我方私有文件会污染标准；`.colt/` 才是本产品自己的配置位（`mcp.json` 就在那儿），
 * 且 `.colt/` **已被 gitignore**——「我不想让这个仓库带来的技能生效」是**本地决定**，
 * 不该跟着提交进别人的仓库。
 *
 * **两级**，与 MCP / 记忆同一条心智：
 * - 用户级 `<home>/.colt/skills.json`——对全部项目生效（手工编辑，见 `skillsUserHome`）；
 * - 项目级 `<cwd>/.colt/skills.json`——设置页的开关**只写这一份**（设置页本就是按项目展示的）。
 *
 * ⚠️ 语义与 MCP 的「同名覆盖」**不同：禁用是并集**（任一层列了就算禁用）。理由：`disabled`
 * 是否定清单，除了「没列出」没有别的表达；若照抄覆盖，项目级写个空数组就等于把用户级的
 * 全局禁用**解开**了——那不是「覆盖」，是意外提权。代价是「用户在某个项目里打不开一个
 * 用户级禁用的技能」，所以设置页必须**说清是哪一层禁的**（`ViewSkillDetail.disabledByUser`），
 * 否则那个开关就退化成「点了没反应」。
 *
 * 按**名字**而非路径：路径随机器 / 克隆位置而变，名字才是用户看到、`/skill` 用的标识。
 * 名字允许**先禁用、后安装**——名单里保留未安装的名字，我们不清理（那是用户写的）。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** `.colt/skills.json` 的形态（只认识 `disabled`，其余顶层键原样保留） */
interface SkillsConfigFile {
  disabled?: unknown;
}

export interface SkillsConfig {
  /** **有效**禁用名单：两层并集、去重 */
  disabled: string[];
  /** 上面这份里来自**用户级**的那部分（设置页据此把开关置灰并说明） */
  fromUser: string[];
  /** 读配置时的告警（坏 JSON / 类型不对；带文件名，说清是哪个文件） */
  diagnostics: string[];
}

/** `<cwd>/.colt/skills.json` 的路径（读写共用同一处口径） */
export function skillsConfigPath(cwd: string): string {
  return join(cwd, ".colt", "skills.json");
}

/** 用户级配置 `<home>/.colt/skills.json` 的路径——与 MCP / 记忆共用同一个 `.colt` 目录 */
export function userSkillsConfigPath(home: string): string {
  return join(home, ".colt", "skills.json");
}

/**
 * 用户级配置所在的「家目录」。默认 `os.homedir()`；`COLT_MCP_HOME` 可覆盖它。
 *
 * 刻意**复用 MCP 那个环境变量、不另起 `COLT_SKILL_HOME`**：用户级的东西都挂在这一个 home 下
 * ——`.colt/mcp.json`、`.colt/skills.json`，以及**技能目录** `.agents/skills`（这一份不在 `.colt`
 * 下，所以冒烟那个隔离口是**整个 home 先删后建**，不是只清 `.colt`：见 `dev/smoke/context.ts`
 * 的 `isolateUserHome`）。两个变量指向同一个目录却可能被设成不同值，正是我们要避免的那种
 * 「看起来一致、实际各说各话」。
 */
export function skillsUserHome(): string {
  return process.env.COLT_MCP_HOME ?? homedir();
}

/** 读单个配置文件；`label` 是给用户看的路径（诊断里点名是哪个文件出的问题） */
async function readConfigFile(
  path: string,
  label: string,
): Promise<{ names: string[]; diagnostics: string[] }> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { names: [], diagnostics: [] }; // 没配就是没配，不是错误
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      names: [],
      diagnostics: [`${label}：不是合法 JSON：${error instanceof Error ? error.message : String(error)}`],
    };
  }
  // 顶层必须是对象：内容是 `null` 时下面读 `parsed.disabled` 会抛 TypeError，而这条读路径在
  // **装载链**上（`loadSkillsConfig` ← `loadSkillsForSessionWithConfig` ← `init`），抛出去就是
  // 会话打不开（`init` 失败被标成 fatal）。标量 / 数组同理拒绝——与写路径 `setSkillDisabled`
  // 的顶层校验同一口径（那里也判了 `null` 与数组），两条路径不能一个稳一个崩。
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      names: [],
      diagnostics: [`${label}：顶层必须是一个对象（如 {"disabled": []}）`],
    };
  }
  const disabled = (parsed as SkillsConfigFile).disabled;
  if (disabled === undefined) return { names: [], diagnostics: [] };
  if (!Array.isArray(disabled) || disabled.some((item) => typeof item !== "string")) {
    return { names: [], diagnostics: [`${label}：disabled 必须是技能名字符串数组`] };
  }
  const names = (disabled as string[]).map((item) => item.trim()).filter((item) => item !== "");
  return { names, diagnostics: [] };
}

/**
 * 读技能偏好：**用户级 + 项目级**两份，按**并集**合并（见文件头为什么不是覆盖）。
 *
 * `home` 省略时**不读用户级**：单测默认走这条，于是结论只取决于自己造的夹具目录，
 * 不随开发者的 `~/.colt/skills.json` 漂移（生产调用方一律传 `skillsUserHome()`）。
 */
export async function loadSkillsConfig(cwd: string, home?: string): Promise<SkillsConfig> {
  const project = await readConfigFile(skillsConfigPath(cwd), ".colt/skills.json");
  const user =
    home === undefined
      ? { names: [] as string[], diagnostics: [] as string[] }
      : await readConfigFile(userSkillsConfigPath(home), "~/.colt/skills.json");
  return {
    disabled: [...new Set([...user.names, ...project.names])],
    fromUser: [...new Set(user.names)],
    diagnostics: [...project.diagnostics, ...user.diagnostics],
  };
}

/**
 * 改一个技能的禁用状态，落到**项目级** `<cwd>/.colt/skills.json`。
 *
 * 三条规矩：
 * ① **读-改-写**，只动这一个名字，其余顶层键与名单项原样保留（用户可能手工写了别的）；
 * ② **坏文件拒绝写入**：文件存在但结构不对时**报错、不覆盖**——覆盖一份手写配置是**不可逆**的，
 *    而报错只需用户改一处；这条与「MCP 配置语法错要在界面上说清」同一个取向；
 * ③ 只负责**落盘**，不负责重载——调用方随后重新装载，于是「改完当轮生效」。
 */
export async function setSkillDisabled(cwd: string, name: string, disabled: boolean): Promise<void> {
  const path = skillsConfigPath(cwd);
  let document: Record<string, unknown> = {};
  let raw: string | undefined;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    // 读不到只有「还没有这个文件」是可接受的；其它 IO 失败一律拒绝——别在未知状态下写
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (raw !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `.colt/skills.json 不是合法 JSON（${error instanceof Error ? error.message : String(error)}），` +
          "为避免覆盖你手写的内容，本次没有写入。",
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(".colt/skills.json 的顶层必须是一个对象，为避免覆盖你手写的内容，本次没有写入。");
    }
    document = parsed as Record<string, unknown>;
  }
  const current = document.disabled;
  if (current !== undefined && (!Array.isArray(current) || current.some((item) => typeof item !== "string"))) {
    throw new Error(".colt/skills.json 的 disabled 必须是技能名字符串数组，为避免覆盖你手写的内容，本次没有写入。");
  }
  const names = (current ?? []) as string[];
  const next = disabled ? [...new Set([...names, name])] : names.filter((item) => item !== name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ ...document, disabled: next }, null, 2)}\n`, "utf8");
}
