// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * `grep` / `glob`：两个**纯只读**的检索工具，让模型不必再走 bash 检索代码。
 *
 * 为什么放在 worker 进程内、不走 HostBridge：纯 fs、无原生依赖、不需要窗口权限。
 * 「能力在主进程」的唯一理由是**持有窗口与 OS 权限**（浏览器/桌面），检索两头都不沾，
 * 走宿主通道只会多一次 IPC 往返——与 `memory_search` 等 worker 内工具同一取舍。
 *
 * ⚠️ **路径边界由本文件自己守**：`read` 工具的越界防护在主进程
 * （`main/lib/path-guard.ts` 的 `isWithinRoot`），而只读白名单放行时**不看路径**
 * （`shared/readonly-tools.ts` 的判据是「有没有路径」而不是「路径在哪」）。所以这里
 * 一旦接受绝对路径或 `..`，模型就能读到项目外的文件，**绕过 read 的边界**。
 * 办法是入口只收相对路径，且统一过 `resolveInRoot`（拼接 → resolve → 前缀校验）。
 *
 * ⚠️ 输出**必须封顶**（`MAX_GREP_MATCHES` / `MAX_GREP_BYTES`）：视图与上下文都是按
 * 「全量快照」处理的，一次不封顶的检索能瞬间吃掉整个上下文预算。
 *
 * ⚠️ 工作量**同样要封顶**（`MAX_SCANNED_FILES`）：为了给出真实的匹配总数，超量之后仍需
 * 扫完整个目录树——那是**没有上界**的 I/O，而工具没有取消信号，lane 只能干等。
 * 上限到了就如实说「结果不完整、总数是下限」，绝不假装扫完了。
 *
 * ⚠️ 工具名**必须**就叫 `grep` / `glob`：`shared/readonly-tools.ts` 的白名单已经预留了
 * 这两个名字，改个名就会脱白名单——每次检索都弹审批卡（`AGENTS.md` §一「名字即契约」）。
 *
 * 错误一律当成**结果**返回给模型（不 throw）：路径越界、正则不合法、目录不存在，
 * 模型看到一句能照着改的说明比看到一次 `isError` 更有用（同 `ask_user` 的校验通道）。
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Type } from "typebox";
import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core";

/** 工具名即只读白名单的键（`shared/readonly-tools.ts`），改名会脱白名单 */
export const GREP_TOOL_NAME = "grep";
export const GLOB_TOOL_NAME = "glob";

/** 永远跳过的目录：检索噪声与体积都不该算进来 */
const SKIP_DIRS: ReadonlySet<string> = new Set([".git", "node_modules", "out", "dist", ".next"]);

export const MAX_GREP_MATCHES = 200;
/** 单次 grep 的正文字节上限（按 UTF-8 计），超出即截断并如实标注 */
export const MAX_GREP_BYTES = 64 * 1024;
export const MAX_GLOB_RESULTS = 500;
/** 单个文件的读取上限：超过就跳过并计数（读一个几百 MB 的产物会把 worker 卡住） */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
/**
 * 一次检索最多扫描多少个文件。
 *
 * 为什么必须有这条：为了给出**真实**的匹配总数，「超出 200 条」之后仍需继续扫完整个目录树
 * ——那是一次**没有上界**的工作量。在 node_modules 被跳过之后，正常仓库远达不到两万；
 * 可真撞上一个几万文件的单仓，检索会一直跑下去（工具没有取消信号，lane 只能干等）。
 * 上限到了就**如实说**「只扫了前 N 个文件、总数是下限」，而不是假装扫完了
 * （`docs/ERRORS.md` 的诚实口径：宁可报「不确定」，不可报一个像确定值的错数）。
 */
export const MAX_SCANNED_FILES = 20_000;

/** 检索可调参数（只为可测：生产中一律用默认值） */
export interface SearchToolOptions {
  maxScannedFiles?: number;
}

/** 遍历预算：`scanned` 是本轮已访问的文件数，`exhausted` 表示撞上了上限 */
interface WalkBudget {
  scanned: number;
  limit: number;
  exhausted: boolean;
}

/** Windows 的文件名比较不区分大小写；检索结果按同一口径匹配（路径本身仍原样返回） */
const CASE_INSENSITIVE_FS = process.platform === "win32";

/** 反斜杠统一成 `/`：对内一切比较、匹配、返回都用正斜杠（Windows 上尤其要紧） */
function toPosix(value: string): string {
  return value.split("\\").join("/");
}

type InRoot =
  | { ok: true; abs: string; rel: string }
  | { ok: false; error: string };

/**
 * 把「项目内相对路径」落到绝对路径，并守住边界。
 *
 * 三道闸，任何一道不过都返回结构化错误：① 显式拒绝绝对路径与含 `:` 的写法
 * （Windows 的盘符 / NTFS 数据流都靠它挡住）；② 拒绝任何一段是 `..`；
 * ③ `resolve` 之后仍必须落在 `root` 之内（兜底，防拼接出意料之外的路径）。
 */
export function resolveInRoot(root: string, rel: string | undefined): InRoot {
  const raw = (rel ?? "").trim();
  if (raw !== "") {
    if (isAbsolute(raw) || /^[a-zA-Z]:/.test(raw) || raw.startsWith("\\\\") || raw.includes(":")) {
      return { ok: false, error: `path 只接受项目内相对路径，收到的是绝对路径或含非法字符：${raw}` };
    }
    if (toPosix(raw).split("/").includes("..")) {
      return { ok: false, error: `path 不能包含 ..（会越出项目根）：${raw}` };
    }
  }
  const abs = resolve(root, toPosix(raw));
  const relOut = relative(root, abs);
  if (relOut.startsWith("..") || isAbsolute(relOut)) {
    return { ok: false, error: `path 越出项目根，已拒绝：${raw}` };
  }
  return { ok: true, abs, rel: toPosix(relOut) };
}

/** 正则特殊字符转义（单字符用） */
function escapeRegExp(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * glob 转换器：只实现最小集——`**`（跨目录）、`*`（单段内任意）、`?`（单段内一个字符）、
 * `{a,b}`（分支）。**不引依赖**：运行环境里没有 ripgrep，为一行的模式语言拉一个包
 * 也不划算，而这里 40 行就能覆盖模型真正会用到的写法。
 *
 * 语义要点：`*` 与 `?` 都不吃 `/`（`src/*.ts` 不会命中 `src/a/b.ts`）；
 * 而 `**` 加成一段后**可以匹配零层目录**——`**` 后面直接跟斜杠时，那一段整体是可选的，
 * 于是「递归找 ts」能命中根目录下的 `a.ts`，不必再写第二种模式。
 */
export function globToRegExp(glob: string): RegExp {
  const pattern = toPosix(glob.trim()).replace(/^\.\//, "");
  let out = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
        continue;
      }
      out += "[^/]*";
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      continue;
    }
    if (char === "{") {
      const end = pattern.indexOf("}", index);
      if (end !== -1) {
        const alternatives = pattern
          .slice(index + 1, end)
          .split(",")
          .map((item) => item.split("").map(escapeRegExp).join(""));
        out += `(?:${alternatives.join("|")})`;
        index = end;
        continue;
      }
    }
    out += escapeRegExp(char);
  }
  return new RegExp(`^${out}$`, CASE_INSENSITIVE_FS ? "i" : "");
}

/** 二进制判定：前 8KB 里出现 NUL 字节即当二进制（文本文件不会有） */
function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8192).includes(0);
}

/**
 * 深度优先遍历目录树，逐个文件回调。
 *
 * 只走 `isDirectory()` 的分支、只把 `isFile()` 当文件——**符号链接因此既不被跟随、
 * 也不被当成文件**：跟随会绕开 `resolveInRoot` 的边界（链接可以指向项目外），
 * 而这是只读工具唯一的越界口子。
 *
 * `budget` 到顶即**停**（见 `MAX_SCANNED_FILES`）：遍历顺序确定（每层按名排序、文件先于子目录），
 * 所以「前 N 个文件」在两次调用之间是同一批——截断才是可复现的。
 */
async function walkFiles(
  startAbs: string,
  startRel: string,
  budget: WalkBudget,
  visit: (abs: string, rel: string) => Promise<void> | void,
): Promise<void> {
  const stack: { abs: string; rel: string }[] = [{ abs: startAbs, rel: startRel }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current.abs, { withFileTypes: true });
    } catch {
      // 读不了就跳过这一层（权限、竞态删除），不打断整次检索
      continue;
    }
    // 排序：结果顺序不随读盘顺序漂移（同一份仓库两次检索应给出同一份输出）
    entries.sort((left, right) => left.name.localeCompare(right.name));
    const subdirs: { abs: string; rel: string }[] = [];
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const childRel = current.rel === "" ? entry.name : `${current.rel}/${entry.name}`;
      const childAbs = join(current.abs, entry.name);
      if (entry.isDirectory()) {
        subdirs.push({ abs: childAbs, rel: childRel });
        continue;
      }
      if (!entry.isFile()) continue;
      if (budget.scanned >= budget.limit) {
        budget.exhausted = true;
        return;
      }
      budget.scanned += 1;
      await visit(childAbs, childRel);
    }
    for (let index = subdirs.length - 1; index >= 0; index -= 1) stack.push(subdirs[index]!);
  }
}

/** 一次 grep 的累计状态（截断与跳过都要如实统计，别静默丢） */
interface GrepTally {
  lines: string[];
  total: number;
  bytes: number;
  truncated: boolean;
  binarySkipped: number;
  largeSkipped: number;
  budget: WalkBudget;
}

async function scanFile(
  abs: string,
  rel: string,
  regex: RegExp,
  tally: GrepTally,
): Promise<void> {
  // **先问大小，再读内容**：`readFile` 会把整份文件读进内存，而「太大就跳过」只需要一个
  // `stat`。顺序反了就是「白读一遍再丢掉」——实测本仓 `release/` 下有 2.1GB 的大二进制，
  // 全仓检索因此要 2～3 秒，而其中绝大部分时间花在把注定要丢掉的字节读进内存。
  let size: number;
  try {
    size = (await stat(abs)).size;
  } catch {
    // 取不到大小（权限 / 竞态删除）只跳过该文件，不打断整次检索
    return;
  }
  if (size > MAX_FILE_BYTES) {
    tally.largeSkipped += 1;
    return;
  }

  let buffer: Buffer;
  try {
    buffer = await readFile(abs);
  } catch {
    // 读失败（权限 / 编码 / 竞态删除）只跳过该文件，不打断整次检索
    return;
  }
  // stat 与 read 之间文件可能被换掉（构建产物目录里很常见），再判一次：
  // 这一次是「已经读进来了才发现太大」，只能丢，但至少不让它进扫描循环。
  if (buffer.byteLength > MAX_FILE_BYTES) {
    tally.largeSkipped += 1;
    return;
  }
  if (looksBinary(buffer)) {
    tally.binarySkipped += 1;
    return;
  }
  const lines = buffer.toString("utf8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!regex.test(line)) continue;
    tally.total += 1;
    // 超预算后**继续扫**：截断提示里的「共 N 条」必须是真的总数
    if (tally.truncated || tally.lines.length >= MAX_GREP_MATCHES) {
      tally.truncated = true;
      continue;
    }
    const rendered = `${rel}:${index + 1}:${line}`;
    const size = Buffer.byteLength(rendered, "utf8") + 1;
    if (tally.bytes + size > MAX_GREP_BYTES) {
      tally.truncated = true;
      continue;
    }
    tally.bytes += size;
    tally.lines.push(rendered);
  }
}

async function runGrep(
  root: string,
  params: { pattern: string; path?: string; glob?: string; ignoreCase?: boolean },
  limit: number,
): Promise<string> {
  const window = resolveInRoot(root, params.path);
  if (!window.ok) return `错误：${window.error}`;

  let regex: RegExp;
  try {
    regex = new RegExp(params.pattern, params.ignoreCase === true ? "i" : "");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `错误：正则不合法：${message}。pattern 用 JS 正则语法，例如 setActive\\w+`;
  }

  const rawGlob = (params.glob ?? "").trim();
  const globRegex = rawGlob === "" ? undefined : globToRegExp(rawGlob);
  // 含 `/` 的模式比整条相对路径，否则只比文件名——`*.ts` 是「所有 ts 文件」的常识写法，
  // 只比整条路径的话它退化成「根目录下的 ts」，模型每次都得写 `**/*.ts` 才对。
  const globOnBasename = globRegex !== undefined && !toPosix(rawGlob).includes("/");
  const allowed = (rel: string): boolean => {
    if (globRegex === undefined) return true;
    const target = globOnBasename ? rel.slice(rel.lastIndexOf("/") + 1) : rel;
    return globRegex.test(target);
  };

  let startIsFile = false;
  try {
    startIsFile = (await stat(window.abs)).isFile();
  } catch {
    return `错误：路径不存在：${window.rel === "" ? "." : window.rel}`;
  }

  const budget: WalkBudget = { scanned: 0, limit, exhausted: false };
  const tally: GrepTally = {
    lines: [],
    total: 0,
    bytes: 0,
    truncated: false,
    binarySkipped: 0,
    largeSkipped: 0,
    budget,
  };
  if (startIsFile) {
    // 单文件检索与「扫了多少文件」是两回事：预算是给遍历用的，这里记 1 以免注释说谎
    budget.scanned = 1;
    if (allowed(window.rel)) await scanFile(window.abs, window.rel, regex, tally);
  } else {
    await walkFiles(window.abs, window.rel, budget, async (abs, rel) => {
      if (!allowed(rel)) return;
      await scanFile(abs, rel, regex, tally);
    });
  }

  const notes: string[] = [];
  // 「扫到一半停了」与「匹配条数超了」是**两件事**，都要说，且不能混成一句：
  // 前者意味着总数只是下限（有文件根本没看），后者意味着总数是准的、只是没全列出来。
  if (budget.exhausted) {
    notes.push(
      `结果不完整：仓库文件过多，只扫描了前 ${budget.scanned} 个文件（上限 ${limit}）` +
        `——至少 ${tally.total} 条匹配，仅显示前 ${tally.lines.length} 条。` +
        `请用更具体的 path / glob 缩小范围后重搜`,
    );
  } else if (tally.truncated) {
    notes.push(`已截断：共 ${tally.total} 条匹配，仅显示前 ${tally.lines.length} 条`);
  }
  if (tally.binarySkipped > 0) notes.push(`已跳过 ${tally.binarySkipped} 个二进制文件`);
  if (tally.largeSkipped > 0) {
    notes.push(`已跳过 ${tally.largeSkipped} 个超过 ${MAX_FILE_BYTES / 1024 / 1024}MB 的文件`);
  }
  if (tally.total === 0) {
    const scope = window.rel === "" ? "." : window.rel;
    const suffix = notes.length === 0 ? "" : `\n\n(${notes.join("；")})`;
    return `没有匹配：${params.pattern}（范围：${scope}）${suffix}`;
  }
  const body = tally.lines.join("\n");
  return notes.length === 0 ? body : `${body}\n\n(${notes.join("；")})`;
}

async function runGlob(
  root: string,
  params: { pattern: string; path?: string },
  limit: number,
): Promise<string> {
  const pattern = params.pattern.trim();
  if (pattern === "") return "错误：pattern 不能为空，例如 **/*.ts。";
  if (isAbsolute(pattern) || /^[a-zA-Z]:/.test(pattern) || pattern.includes(":")) {
    return `错误：pattern 只接受相对模式，不能用绝对路径：${pattern}`;
  }
  if (toPosix(pattern).split("/").includes("..")) {
    return `错误：pattern 不能包含 ..：${pattern}`;
  }
  const window = resolveInRoot(root, params.path);
  if (!window.ok) return `错误：${window.error}`;

  const matcher = globToRegExp(pattern);
  const hits: string[] = [];
  let startIsFile = false;
  try {
    startIsFile = (await stat(window.abs)).isFile();
  } catch {
    return `错误：路径不存在：${window.rel === "" ? "." : window.rel}`;
  }
  const budget: WalkBudget = { scanned: 0, limit, exhausted: false };
  if (startIsFile) {
    budget.scanned = 1;
    if (matcher.test(window.rel)) hits.push(window.rel);
  } else {
    await walkFiles(window.abs, window.rel, budget, (_abs, rel) => {
      if (matcher.test(rel)) hits.push(rel);
    });
  }
  if (budget.exhausted) {
    return (
      `错误：仓库文件过多，只在扫描了前 ${budget.scanned} 个文件（上限 ${limit}）后停止，` +
      `结果不可信。请用更具体的 path 或模式缩小范围，例如把模式收窄到某个子目录。`
    );
  }

  if (hits.length === 0) return `没有匹配的文件：${pattern}`;
  // 排序后再截断：否则「前 500 个」是遍历顺序决定的，同一份仓库两次结果可能不同
  hits.sort((left, right) => left.localeCompare(right));
  const shown = hits.slice(0, MAX_GLOB_RESULTS);
  if (hits.length <= shown.length) return shown.join("\n");
  return `${shown.join("\n")}\n\n(已截断：共 ${hits.length} 个文件，仅显示前 ${MAX_GLOB_RESULTS} 个)`;
}

const grepSchema = Type.Object({
  pattern: Type.String({ description: "正则表达式（JS 语法），例如 `setActiveTools|healLaneTools`" }),
  path: Type.Optional(
    Type.String({ description: "项目内相对路径（缺省=项目根），可以是目录或单个文件；不支持绝对路径与 .." }),
  ),
  glob: Type.Optional(
    Type.String({
      description: "只看匹配的文件：`*.ts` 比文件名、`src/**/*.tsx` 比相对路径；不填则搜全部文件",
    }),
  ),
  ignoreCase: Type.Optional(Type.Boolean({ description: "忽略大小写（缺省区分大小写）" })),
});

const globSchema = Type.Object({
  pattern: Type.String({
    description: "glob 模式，如 `**/*.ts`、`src/*.tsx`、`*.{json,md}`。** 跨目录、* 单段",
  }),
  path: Type.Optional(
    Type.String({ description: "起始目录（项目内相对路径，缺省=项目根）；不支持绝对路径与 .." }),
  ),
});

/**
 * 造出这两个工具。`projectRoot` 由调用方（worker 的 init）给出，也就是会话的 cwd——
 * 边界判据与 `read` / `write` 落在同一个根上，否则模型会遇到「read 读得到、grep 读不到」
 * 这类自相矛盾的边界。
 */
export function createSearchTools(
  projectRoot: string,
  options: SearchToolOptions = {},
): AgentHarnessTool<ExecutionToolContext>[] {
  // 生产不传 options（走默认上限）；测试用它造「仓库过大」的前提
  const limit = options.maxScannedFiles ?? MAX_SCANNED_FILES;
  const grep: AgentHarnessTool<ExecutionToolContext, typeof grepSchema, undefined> = {
    name: GREP_TOOL_NAME,
    label: "搜索内容",
    description: [
      "在项目文件里按正则搜索内容，返回 `文件路径:行号:行内容`。只读，不修改任何文件。",
      "**检索代码优先用它**，不要用 bash 里的 find / grep / Select-String（那些要走审批，这里是免审批的）。",
      "参数：pattern 必填（JS 正则）；path 为项目内相对路径（缺省=项目根，可为目录或单个文件），",
      "不支持绝对路径与 ..；glob 只看匹配的文件（`*.ts` 比文件名、`src/**/*.tsx` 比相对路径）；",
      "ignoreCase 忽略大小写。",
      "自动跳过 .git / node_modules / out / dist / .next 与二进制文件；结果最多 200 条、64KB，",
      `超出会在末尾标注「已截断」并给出匹配总数；一次最多扫 ${limit} 个文件，超出会标注「结果不完整」`,
      "（那时总数只是下限）——看到任何标注就请缩小 path 或 glob 再搜一次。",
      "没有匹配不是错误，会如实回一句「没有匹配」。",
    ].join("\n"),
    parameters: grepSchema,
    async execute(_toolCallId, params) {
      const text = await runGrep(projectRoot, params, limit);
      return { content: [{ type: "text" as const, text }], details: undefined };
    },
  };

  const glob: AgentHarnessTool<ExecutionToolContext, typeof globSchema, undefined> = {
    name: GLOB_TOOL_NAME,
    label: "按模式找文件",
    description: [
      "按 glob 模式列出项目内的文件路径（相对项目根，用 `/` 分隔）。只读。",
      "**找文件优先用它**，不要用 bash 里的 find / dir（那些要走审批，这里是免审批的）。",
      "模式最小集：`**` 跨目录、`*` 单段内任意、`?` 单段内一个字符、`{a,b}` 分支；",
      "例如 `**/*.ts`、`src/*.tsx`、`*.{json,md}`。path 为起始目录（缺省=项目根）。",
      "自动跳过 .git / node_modules / out / dist / .next；结果最多 500 条，超出会在末尾标注。",
      "仓库过大时可能扫不完，那时会明确报错让你缩小范围，而不是回一份不完整的清单。",
    ].join("\n"),
    parameters: globSchema,
    async execute(_toolCallId, params) {
      const text = await runGlob(projectRoot, params, limit);
      return { content: [{ type: "text" as const, text }], details: undefined };
    },
  };

  return [grep, glob];
}
