// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * Agent Skills 的**本地装载器**：遍历目录、读 `SKILL.md`、校验 frontmatter、遵守 ignore 文件。
 *
 * 为什么自己实现而不是继续用旧内核的 `loadSkills`：切到 pi-durable 后内核不再提供技能装载
 * （那是旧 harness 的附属能力），而技能是 Colt 的产品能力，不能跟着内核一起消失。
 * 行为与 agentskills.io 的既有实现保持一致：递归、`SKILL.md` 优先、根目录带 frontmatter 的
 * `.md` 也算技能、同名由调用方按目录优先级去重。
 *
 * 与旧实现的差别只有一处：不再经过抽象的 `ExecutionEnv`，直接用 `node:fs`。技能只存在于
 * 本机磁盘（项目级 / 用户级 / 随包内置），没有远程文件系统这一层，抽象在这里只增加间接。
 *
 * ⚠️ 错误一律变成 `SkillDiagnostic`，不 throw：某个技能目录坏掉不该让会话打不开。
 * 但 `read_failed` / `parse_failed` 要如实报出——静默跳过会让用户以为「技能装了」。
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import ignore from "ignore";
import { parse } from "yaml";

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

/** 技能本体（字段与 agentskills.io 的既有实现一致） */
export interface Skill {
  /** 稳定名字：查找与模型可见清单都用它 */
  name: string;
  /** 给模型看的一句话「何时用」 */
  description: string;
  /** 完整正文（`SKILL.md` 去掉 frontmatter 之后的部分） */
  content: string;
  /** 技能文件的绝对路径：模型据此解析正文里的相对引用 */
  filePath: string;
  /** 不在模型可见清单里出现，但应用仍可按名显式调用 */
  disableModelInvocation?: boolean;
}

export type SkillDiagnosticCode =
  | "file_info_failed"
  | "list_failed"
  | "read_failed"
  | "parse_failed"
  | "invalid_metadata";

/** 装载期告警。目前只有 warning，但保留 type 字段与旧实现同形 */
export interface SkillDiagnostic {
  type: "warning";
  code: SkillDiagnosticCode;
  message: string;
  path: string;
}

export interface LoadSkillsResult {
  skills: Skill[];
  diagnostics: SkillDiagnostic[];
}

interface Frontmatter {
  name?: unknown;
  description?: unknown;
  "disable-model-invocation"?: unknown;
}

/**
 * 从一组目录装载技能。目录不存在时**静默跳过**（「没装技能」是正常状态）；
 * 其它读盘错误变成告警。
 */
export async function loadSkills(dirs: string | string[]): Promise<LoadSkillsResult> {
  const skills: Skill[] = [];
  const diagnostics: SkillDiagnostic[] = [];
  for (const dir of Array.isArray(dirs) ? dirs : [dirs]) {
    let rootInfo;
    try {
      rootInfo = await stat(dir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        diagnostics.push({
          type: "warning",
          code: "file_info_failed",
          message: messageOf(error),
          path: dir,
        });
      }
      continue;
    }
    if (!rootInfo.isDirectory()) continue;
    const result = await walk(dir, dir, true, ignore(), diagnostics);
    skills.push(...result);
  }
  return { skills, diagnostics };
}

/**
 * 递归一个目录。`SKILL.md` 优先：找到它就不再往下走（一个技能目录只产出一个技能）。
 * 根目录另外接受带 frontmatter 的 `.md`（技能包常把说明放在根上）。
 */
async function walk(
  dir: string,
  rootDir: string,
  includeRootFiles: boolean,
  matcher: ReturnType<typeof ignore>,
  diagnostics: SkillDiagnostic[],
): Promise<Skill[]> {
  await addIgnoreRules(dir, rootDir, matcher, diagnostics);

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    diagnostics.push({
      type: "warning",
      code: "list_failed",
      message: messageOf(error),
      path: dir,
    });
    return [];
  }

  const skills: Skill[] = [];
  for (const entry of entries) {
    if (entry.name !== "SKILL.md") continue;
    const fullPath = join(dir, entry.name);
    const kind = await resolveKind(fullPath, diagnostics);
    if (kind !== "file") continue;
    if (matcher.ignores(relativePath(rootDir, fullPath))) continue;
    const result = await loadSkillFromFile(fullPath, diagnostics);
    if (result !== null) skills.push(result);
    return skills;
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const fullPath = join(dir, entry.name);
    const kind = await resolveKind(fullPath, diagnostics);
    if (kind === undefined) continue;
    const relPath = relativePath(rootDir, fullPath);
    const ignorePath = kind === "directory" ? `${relPath}/` : relPath;
    if (matcher.ignores(ignorePath)) continue;
    if (kind === "directory") {
      skills.push(...(await walk(fullPath, rootDir, false, matcher, diagnostics)));
      continue;
    }
    if (!includeRootFiles || !entry.name.endsWith(".md")) continue;
    const result = await loadSkillFromFile(fullPath, diagnostics);
    if (result !== null) skills.push(result);
  }
  return skills;
}

async function addIgnoreRules(
  dir: string,
  rootDir: string,
  matcher: ReturnType<typeof ignore>,
  diagnostics: SkillDiagnostic[],
): Promise<void> {
  const relativeDir = relativePath(rootDir, dir);
  const prefix = relativeDir === "" ? "" : `${relativeDir}/`;
  for (const filename of IGNORE_FILE_NAMES) {
    const ignorePath = join(dir, filename);
    const kind = await resolveKind(ignorePath, diagnostics);
    if (kind !== "file") continue;
    let content: string;
    try {
      content = await readFile(ignorePath, "utf8");
    } catch (error) {
      diagnostics.push({
        type: "warning",
        code: "read_failed",
        message: messageOf(error),
        path: ignorePath,
      });
      continue;
    }
    const patterns = content
      .split(/\r?\n/)
      .map((line) => prefixIgnorePattern(line, prefix))
      .filter((line): line is string => line !== null);
    if (patterns.length > 0) matcher.add(patterns);
  }
}

/** ignore 文件里的模式要按「相对技能根」重写，否则子目录里的规则会错位 */
function prefixIgnorePattern(line: string, prefix: string): string | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;
  let pattern = line;
  let negated = false;
  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
  } else if (pattern.startsWith("\\!")) {
    pattern = pattern.slice(1);
  }
  if (pattern.startsWith("/")) pattern = pattern.slice(1);
  const prefixed = prefix === "" ? pattern : `${prefix}${pattern}`;
  return negated ? `!${prefixed}` : prefixed;
}

async function loadSkillFromFile(
  filePath: string,
  diagnostics: SkillDiagnostic[],
): Promise<Skill | null> {
  const isDeclaredSkill = filePath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() === "SKILL.md";
  // 父目录**名**（不是完整路径）：缺省 name 取它，`validateName` 也拿它做对比口径。
  // 由本函数自己算而不是交给调用方传：传错一次（比如传 `dirname(filePath)`）就会让
  // 「没写 name 的技能」拿到绝对路径当名字，而且每个合规技能都会被误报「与目录不一致」。
  const parentDirName = basename(dirname(filePath));
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    diagnostics.push({
      type: "warning",
      code: "read_failed",
      message: messageOf(error),
      path: filePath,
    });
    return null;
  }

  const parsed = parseFrontmatter(raw);
  if (!parsed.ok) {
    // 根目录的普通 .md 没有 frontmatter 是正常的；只有声明式 SKILL.md 才值得告警
    if (isDeclaredSkill) {
      diagnostics.push({
        type: "warning",
        code: "parse_failed",
        message: parsed.error,
        path: filePath,
      });
    }
    return null;
  }

  const { frontmatter, body } = parsed.value;
  const description =
    typeof frontmatter.description === "string" ? frontmatter.description : undefined;
  if (!isDeclaredSkill && (description === undefined || description.trim() === "")) return null;
  for (const message of validateDescription(description)) {
    diagnostics.push({ type: "warning", code: "invalid_metadata", message, path: filePath });
  }

  const declaredName = typeof frontmatter.name === "string" ? frontmatter.name : undefined;
  const name = declaredName !== undefined && declaredName !== "" ? declaredName : parentDirName;
  for (const message of validateName(name, parentDirName)) {
    diagnostics.push({ type: "warning", code: "invalid_metadata", message, path: filePath });
  }
  if (description === undefined || description.trim() === "") return null;

  return {
    name,
    description,
    content: body,
    filePath,
    disableModelInvocation: frontmatter["disable-model-invocation"] === true,
  };
}

function validateName(name: string, parentDirName: string): string[] {
  const errors: string[] = [];
  if (name !== parentDirName) {
    errors.push(`name "${name}" does not match parent directory "${parentDirName}"`);
  }
  if (name.length > MAX_NAME_LENGTH) {
    errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
  }
  if (!/^[a-z0-9-]+$/.test(name)) {
    errors.push("name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)");
  }
  if (name.startsWith("-") || name.endsWith("-")) errors.push("name must not start or end with a hyphen");
  if (name.includes("--")) errors.push("name must not contain consecutive hyphens");
  return errors;
}

function validateDescription(description: string | undefined): string[] {
  if (description === undefined || description.trim() === "") return ["description is required"];
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return [
      `description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`,
    ];
  }
  return [];
}

function parseFrontmatter(
  content: string,
): { ok: true; value: { frontmatter: Frontmatter; body: string } } | { ok: false; error: string } {
  try {
    const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (!normalized.startsWith("---")) return { ok: true, value: { frontmatter: {}, body: normalized } };
    const endIndex = normalized.indexOf("\n---", 3);
    if (endIndex === -1) return { ok: true, value: { frontmatter: {}, body: normalized } };
    const yamlString = normalized.slice(4, endIndex);
    const body = normalized.slice(endIndex + 4).trim();
    const parsed = parse(yamlString);
    const frontmatter =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Frontmatter)
        : {};
    return { ok: true, value: { frontmatter, body } };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

/** 符号链接跟随一次：`stat` 不认识链接类型，直接按目标判 file / directory */
async function resolveKind(
  path: string,
  diagnostics: SkillDiagnostic[],
): Promise<"file" | "directory" | undefined> {
  try {
    const info = await stat(path);
    if (info.isFile()) return "file";
    if (info.isDirectory()) return "directory";
    return undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      diagnostics.push({
        type: "warning",
        code: "file_info_failed",
        message: messageOf(error),
        path,
      });
    }
    return undefined;
  }
}

function relativePath(root: string, path: string): string {
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedPath = path.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalizedPath === normalizedRoot) return "";
  return normalizedPath.startsWith(`${normalizedRoot}/`)
    ? normalizedPath.slice(normalizedRoot.length + 1)
    : normalizedPath.replace(/^\/+/, "");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 生成 agentskills.io 约定的 `<available_skills>` 块；没有可见技能时返回空串 */
export function formatSkillsForSystemPrompt(skills: readonly Skill[]): string {
  const visible = skills.filter((skill) => skill.disableModelInvocation !== true);
  if (visible.length === 0) return "";
  const lines = [
    "The following skills provide specialized instructions for specific tasks.",
    "Read the full skill file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
  ];
  for (const skill of visible) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

/** 显式调用：把技能正文包成一条消息体（与旧内核逐字一致，历史里已有这种形态） */
export function formatSkillInvocation(skill: Skill, additionalInstructions?: string): string {
  const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${dirname(skill.filePath)}.\n\n${skill.content}\n</skill>`;
  return additionalInstructions === undefined || additionalInstructions === ""
    ? block
    : `${block}\n\n${additionalInstructions}`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
