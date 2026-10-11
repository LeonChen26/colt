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
import { IgnoreFilter, SKIP_DIRS } from "./search-ignore";
import { MAX_RG_STDOUT_BYTES, buildRgArgs, runRipgrep, type RgRunResult } from "./search-rg";

/** 工具名即只读白名单的键（`shared/readonly-tools.ts`），改名会脱白名单 */
export const GREP_TOOL_NAME = "grep";
export const GLOB_TOOL_NAME = "glob";

// SKIP_DIRS 现在住在 search-ignore.ts：**两个引擎都要用**（JS 在遍历里判、rg 翻译成 -g '!name'）

export const MAX_GREP_MATCHES = 200;
/**
 * JS 那侧**保留**多少条命中（只为排序）。
 *
 * 为什么需要一个「保留数」而不是直接用 `MAX_GREP_MATCHES`：两个引擎要给出同一份
 * 「前 200 条」，前提是**两边都先握住全部命中再排序**。rg 那侧天然如此（stdout 一次读完，
 * 上限 `MAX_RG_STDOUT_BYTES`）；JS 那侧原本是「按遍历顺序取前 200 再排序」——那与
 * 「排序后取前 200」是**不同的 200 条**（实测：578 条匹配时两边各差几十行）。
 *
 * 取 5000：覆盖住绝大多数的截断场景（本仓最宽的查询是 6597 条，差一点点；
 * 常规查询都在几百条），内存代价是一个小对象数组。超过它时两边仍可能有差异，
 * 但**总数一致**（模型据此缩小范围的那条依据不受影响），这一点在测试里单独钉住。
 */
export const MAX_GREP_KEPT_HITS = 5000;
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

/**
 * 检索工具的装配参数。
 *
 * `rgPath` 由**主进程**算好传进来（它才知道 dev 与打包两种形态下二进制各在哪），
 * 与 `toolOutputDir` 同一个分工。`undefined` = 没带 ripgrep（开发机没拉取、或包里没有），
 * 那就走纯 JS 实现——**那是受支持的形态，不是错误**。
 */
export interface SearchToolOptions {
  /** 只为可测：生产中走默认上限 */
  maxScannedFiles?: number;
  /** ripgrep 可执行文件绝对路径；缺省 = 不用它 */
  rgPath?: string;
}

/** 遍历预算：`scanned` 是本轮已访问的文件数，`exhausted` 表示撞上了上限 */
interface WalkBudget {
  scanned: number;
  limit: number;
  exhausted: boolean;
  /** 被 gitignore 挡掉、因而**没有扫**的条目数（如实报给模型，别静默少给结果） */
  ignoredFiles: number;
  ignoredDirs: number;
}

/** 读一个文本文件（ignore 文件用）；读不到返回空串，调用方按「没有这个文件」处理 */
async function readTextFile(path: string): Promise<string> {
  return readFile(path, "utf8");
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
 *
 * `filter` 为 `undefined` 时**不做 gitignore 过滤**（`includeIgnored`），只保留写死的跳过名单。
 */
async function walkFiles(
  startAbs: string,
  startRel: string,
  budget: WalkBudget,
  filter: IgnoreFilter | undefined,
  includeIgnored: boolean,
  visit: (abs: string, rel: string) => Promise<void> | void,
): Promise<void> {
  const stack: { abs: string; rel: string }[] = [{ abs: startAbs, rel: startRel }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    // 每进一层，就把该层的 ignore 文件装进来：规则是**逐层累积**的，
    // 于是任何文件被判定时，其祖先链上的规则都已经在里面。装完再 readdir，
    // 这样本层就能立刻用上本层的规则。
    if (filter !== undefined) await filter.loadDirectory(current.abs, current.rel, readTextFile);
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
      // **点文件/点目录一律跳过**（`includeIgnored` 时除外）——这是与 ripgrep 的默认行为对齐：
      // rg 快路径不看它们，JS 回落也得不看，否则「装没装 rg」会给出不同结果。
      // 注意只判**子项**：模型显式把 path 指到 `.github` 时，那个目录本身不是子项，照搜。
      if (!includeIgnored && entry.name.startsWith(".")) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      const childRel = current.rel === "" ? entry.name : `${current.rel}/${entry.name}`;
      const childAbs = join(current.abs, entry.name);
      if (entry.isDirectory()) {
        // 被 gitignore 的目录**不下沉**：这是过滤能省下大头时间的地方
        // （`node_modules/`、`release/` 这类规则命中后，整棵子树一次都不会被 readdir）
        if (filter?.ignoresDir(childRel) === true) {
          budget.ignoredDirs += 1;
          continue;
        }
        subdirs.push({ abs: childAbs, rel: childRel });
        continue;
      }
      if (!entry.isFile()) continue;
      if (filter?.ignoresFile(childRel) === true) {
        budget.ignoredFiles += 1;
        continue;
      }
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

/** 一条命中的三个字段（排序用，渲染成 `路径:行号:内容` 是最后一步） */
interface GrepHit {
  rel: string;
  lineNumber: number;
  text: string;
}

/** 一次 grep 的累计状态（截断与跳过都要如实统计，别静默丢） */
interface GrepTally {
  hits: GrepHit[];
  /** 匹配总数（**不受保留上限影响**，故它才是「共 N 条」的真值） */
  total: number;
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
    // 总数**始终**照数（截断提示里的「共 N 条」必须是真的总数）；
    // 保留则封顶——排序需要握住全部命中，而那是有界的内存代价（见 MAX_GREP_KEPT_HITS）。
    tally.total += 1;
    if (tally.hits.length < MAX_GREP_KEPT_HITS) {
      tally.hits.push({ rel, lineNumber: index + 1, text: line });
    }
  }
}

/** rg 在这个进程里已被判定不可用（latch 住，避免每条查询都重试一次注定失败的 spawn） */
let rgUnavailable = false;

/**
 * 命中的**全局排序**：按相对路径、再按行号。
 *
 * 为什么非排不可：两个引擎的**遍历顺序天然不同**（rg 多线程；JS 是按目录名排序的深度优先），
 * 不排的话同一份查询会给出不同的行序——实测 `-g '*.ts'` 那个用例就是这么红的。
 * 排序把「展示顺序」这件事从引擎手里拿回来，非截断的结果因此**逐字一致**。
 * （截断时选中的是哪 200 条仍可能不同——那需要两边都持有全部命中，见 search-rg.ts 的说明。）
 */
function compareHits(left: { rel: string; lineNumber: number }, right: { rel: string; lineNumber: number }): number {
  return left.rel === right.rel ? left.lineNumber - right.lineNumber : left.rel.localeCompare(right.rel);
}

/**
 * 「排序 → 按条数与字节上限取前若干条」——**两个引擎共用**，保证选出的是同一批。
 *
 * 顺序不能反：先取后排会按**遍历顺序**挑，而两个引擎的遍历顺序不同（rg 多线程、
 * JS 目录序 DFS），于是同一查询给出不同的 200 条。实测踩到过。
 */
function capHits(hits: readonly GrepHit[]): GrepHit[] {
  const sorted = [...hits].sort(compareHits);
  let bytes = 0;
  const shown: GrepHit[] = [];
  for (const hit of sorted) {
    if (shown.length >= MAX_GREP_MATCHES) break;
    const size = Buffer.byteLength(`${hit.rel}:${hit.lineNumber}:${hit.text}`, "utf8") + 1;
    if (bytes + size > MAX_GREP_BYTES) break;
    bytes += size;
    shown.push(hit);
  }
  return shown;
}

/** 命中 → `路径:行号:内容` 文本（两个引擎共用同一份渲染，别再各写一遍） */
function renderHits(hits: readonly GrepHit[]): string {
  return [...hits]
    .sort(compareHits)
    .map((hit) => `${hit.rel}:${hit.lineNumber}:${hit.text}`)
    .join("\n");
}

/**
 * 「过滤过」这件事的说明，两个引擎**共用一个常量的前半句**。
 *
 * 出现条件刻意收窄成「结果为空 或 被截断」：那才是模型会误读的时刻——
 * 一份空结果到底是「项目里没有」还是「被过滤了」，指向完全不同的下一步。
 * 每次检索都挂一句样板反而会被忽略。
 *
 * rg 那侧拿不到「跳过了多少项」，故它的说明**少一个数目**（JS 有）。这点差异是有意的：
 * 让「有没有说明」两边一致，比让「数目有没有」一致重要得多——前者会误导模型，后者只是精度。
 */
const FILTER_NOTE = "已按 .gitignore 等忽略文件过滤；要找被忽略的文件请传 includeIgnored: true";

/**
 * 把 rg 的结果收口成与 JS 那侧**同形**的文本。
 *
 * 三件事必须与 JS 路径一致，否则「装没装 rg」会让模型看到不同的东西：
 *   ① 路径格式：`相对项目根、正斜杠`（rg 给的是它自己的路径写法，Windows 上是反斜杠）；
 *   ② 上限：200 条 / 64KB，且**截断时给出的总数口径**要与 JS 对齐
 *      （读完 stdout 就是真总数；stdout 撞上限则降级成「至少 N 条」）；
 *   ③ 越界兜底：rg 返回的路径必须仍落在项目根内（正常情况下必然如此，但别把
 *      「工具自己守边界」这条唯一防线托付给另一个程序的行为）。
 */
function formatRgResult(
  root: string,
  result: RgRunResult,
  pattern: string,
  scopeRel: string,
): string {
  // **先排序、再截断**：与 JS 那侧同一顺序（见 compareHits）。
  // 顺序反了的话「前 200 条」会是 rg 的遍历顺序决定的——那正是两引擎结果不同的由来。
  const hits: GrepHit[] = [];
  for (const match of result.matches) {
    const abs = resolve(match.path);
    const rel = toPosix(relative(root, abs));
    // 越界兜底：别把「工具自己守边界」这条唯一防线托付给另一个程序的行为
    if (rel.startsWith("..") || isAbsolute(rel)) continue;
    hits.push({ rel, lineNumber: match.lineNumber, text: match.text });
  }
  hits.sort(compareHits);

  const total = hits.length;
  // 与 JS 那侧**同一个函数**（排序 → 取前若干条），否则两条路会各自漂移
  const shown = capHits(hits);
  const cappedByCount = shown.length < total;

  const notes: string[] = [];
  if (result.truncatedByBytes) {
    // stdout 都没读完 → 连总数都只是下限，措辞必须与 JS 的「扫不完」同一档诚实度
    notes.push(
      `结果不完整：输出过大（超过 ${MAX_RG_STDOUT_BYTES / 1024 / 1024}MB），已提前停止读取` +
        `——至少 ${total} 条匹配，仅显示前 ${shown.length} 条。请用更具体的 path / glob 缩小范围后重搜`,
    );
  } else if (cappedByCount) {
    notes.push(`已截断：共 ${total} 条匹配，仅显示前 ${shown.length} 条`);
  }
  // 过滤说明：与 JS 那侧**在同样的条件下**出现（结果为空 / 被截断），措辞少一个数目。
  //
  // 为什么 rg 给不出那个数目：它不会告诉调用方「我忽略了多少个文件」，
  // 而那正是 JS 那侧唯一多出来的东西。让它变成「有没有说明」的差别（那会误导模型），
  // 比让它变成「数目有没有」的差别（只是精度不同）糟得多——所以保留说明、放弃数目。
  if (total === 0 || result.truncatedByBytes || cappedByCount) {
    notes.push(FILTER_NOTE);
  }
  if (total === 0) {
    const scope = scopeRel === "" ? "." : scopeRel;
    const suffix = notes.length === 0 ? "" : `\n\n(${notes.join("；")})`;
    return `没有匹配：${pattern}（范围：${scope}）${suffix}`;
  }
  const body = renderHits(shown);
  return notes.length === 0 ? body : `${body}\n\n(${notes.join("；")})`;
}

async function runGrep(
  root: string,
  params: {
    pattern: string;
    path?: string;
    glob?: string;
    ignoreCase?: boolean;
    includeIgnored?: boolean;
  },
  limit: number,
  rgPath: string | undefined,
): Promise<string> {
  const window = resolveInRoot(root, params.path);
  if (!window.ok) return `错误：${window.error}`;
  const includeIgnored = params.includeIgnored === true;

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

  // 快路径：交给 ripgrep（只在**默认那条**路上——见 search-rg.ts 对「引擎一致性」的说明：
  // 单文件检索 JS 本来就快，`includeIgnored` 那串参数只会把两边拉远）。
  // 正则合法性已经在上面用 JS 的 RegExp 校过一遍——rg 用的是 Rust 正则，语法**不完全相同**
  // （如 `(?P<name>)` vs `(?<name>)`），所以两边都过一遍能挡掉最明显的错法；
  // 真遇到 rg 独有的语法差异，rg 会以退出码 2 报错，下面的 catch 会回落 JS 并留痕。
  if (rgPath !== undefined && !includeIgnored && !startIsFile && !rgUnavailable) {
    try {
      const result = await runRipgrep(
        rgPath,
        buildRgArgs({
          pattern: params.pattern,
          absolutePath: window.abs,
          glob: rawGlob === "" ? undefined : rawGlob,
          ignoreCase: params.ignoreCase,
        }),
        root,
      );
      return formatRgResult(root, result, params.pattern, window.rel);
    } catch (error) {
      // 回落不是错误（两条路结果一致），但**降级本身要留痕一次**：
      // 静默降级会让「某台机器上一直慢着」永远查不出原因。latch 住，只报一次。
      rgUnavailable = true;
      console.error(
        `[search] ripgrep 不可用（${error instanceof Error ? error.message : String(error)}），` +
          `已改用内置实现（本次会话内不再尝试）`,
      );
    }
  }

  const budget: WalkBudget = {
    scanned: 0,
    limit,
    exhausted: false,
    ignoredFiles: 0,
    ignoredDirs: 0,
  };
  // 过滤器只在「遍历一个目录」时才需要；单文件检索不过滤（模型点名要看的文件就该看到）。
  const filter = startIsFile || includeIgnored ? undefined : new IgnoreFilter();
  const tally: GrepTally = {
    hits: [],
    total: 0,
    binarySkipped: 0,
    largeSkipped: 0,
    budget,
  };
  if (startIsFile) {
    // 单文件检索与「扫了多少文件」是两回事：预算是给遍历用的，这里记 1 以免注释说谎
    budget.scanned = 1;
    if (allowed(window.rel)) await scanFile(window.abs, window.rel, regex, tally);
  } else {
    await walkFiles(window.abs, window.rel, budget, filter, includeIgnored, async (abs, rel) => {
      if (!allowed(rel)) return;
      await scanFile(abs, rel, regex, tally);
    });
  }

  // 排序 → 按上限取（与 rg 那侧同一个函数、同一批结果；见 capHits 的注释）。
  // 截断与否由**总数 vs 展示数**决定，而不是由 capHits 的返回值——总数才是「有没有被截」
  // 的真值（保留上限可能先于展示上限生效）。
  const shown = capHits(tally.hits);
  const truncated = tally.total > shown.length;

  const notes: string[] = [];
  // 「扫到一半停了」与「匹配条数超了」是**两件事**，都要说，且不能混成一句：
  // 前者意味着总数只是下限（有文件根本没看），后者意味着总数是准的、只是没全列出来。
  if (budget.exhausted) {
    notes.push(
      `结果不完整：仓库文件过多，只扫描了前 ${budget.scanned} 个文件（上限 ${limit}）` +
        `——至少 ${tally.total} 条匹配，仅显示前 ${shown.length} 条。` +
        `请用更具体的 path / glob 缩小范围后重搜`,
    );
  } else if (truncated) {
    notes.push(`已截断：共 ${tally.total} 条匹配，仅显示前 ${shown.length} 条`);
  }
  if (tally.binarySkipped > 0) notes.push(`已跳过 ${tally.binarySkipped} 个二进制文件`);
  if (tally.largeSkipped > 0) {
    notes.push(`已跳过 ${tally.largeSkipped} 个超过 ${MAX_FILE_BYTES / 1024 / 1024}MB 的文件`);
  }
  // 「被 gitignore 挡掉」必须说出来：否则模型看到一份空结果时，**分不清是「项目里没有」
  // 还是「被过滤了」**——那两种结论指向完全不同的下一步（一个换思路，一个换搜索方式）。
  // 条件与 rg 那侧**刻意保持一致**（结果为空 / 被截断），差别只在「有没有数目」：
  // rg 给不出被忽略的条数，JS 能。让说明本身两边都有，比让数目两边都有重要（见 FILTER_NOTE）。
  const ignored = budget.ignoredFiles + budget.ignoredDirs;
  if ((tally.total === 0 || budget.exhausted || truncated) && filter !== undefined) {
    notes.push(
      ignored > 0
        ? `已按 .gitignore 等忽略文件跳过 ${ignored} 项（其中目录 ${budget.ignoredDirs} 个）；` +
          `要找被忽略的文件请传 includeIgnored: true`
        : FILTER_NOTE,
    );
  }
  if (tally.total === 0) {
    const scope = window.rel === "" ? "." : window.rel;
    const suffix = notes.length === 0 ? "" : `\n\n(${notes.join("；")})`;
    return `没有匹配：${params.pattern}（范围：${scope}）${suffix}`;
  }
  const body = renderHits(shown);
  return notes.length === 0 ? body : `${body}\n\n(${notes.join("；")})`;
}

async function runGlob(
  root: string,
  params: { pattern: string; path?: string; includeIgnored?: boolean },
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
  const includeIgnored = params.includeIgnored === true;

  const matcher = globToRegExp(pattern);
  const hits: string[] = [];
  let startIsFile = false;
  try {
    startIsFile = (await stat(window.abs)).isFile();
  } catch {
    return `错误：路径不存在：${window.rel === "" ? "." : window.rel}`;
  }
  const budget: WalkBudget = {
    scanned: 0,
    limit,
    exhausted: false,
    ignoredFiles: 0,
    ignoredDirs: 0,
  };
  const filter = startIsFile || includeIgnored ? undefined : new IgnoreFilter();
  if (startIsFile) {
    budget.scanned = 1;
    if (matcher.test(window.rel)) hits.push(window.rel);
  } else {
    await walkFiles(window.abs, window.rel, budget, filter, includeIgnored, (_abs, rel) => {
      if (matcher.test(rel)) hits.push(rel);
    });
  }
  if (budget.exhausted) {
    return (
      `错误：仓库文件过多，只在扫描了前 ${budget.scanned} 个文件（上限 ${limit}）后停止，` +
      `结果不可信。请用更具体的 path 或模式缩小范围，例如把模式收窄到某个子目录。`
    );
  }

  // 与 grep 同一口径：**结果为空 或 清单被截断**时才说明「过滤过」——那是模型会误读的时刻
  // （空结果到底是「没有」还是「被过滤了」）。顺带把被跳过的条数给出来（rg 那侧给不出）。
  const ignored = budget.ignoredFiles + budget.ignoredDirs;
  const hitLimit = hits.length > MAX_GLOB_RESULTS;
  const ignoredNote =
    filter !== undefined && (hits.length === 0 || hitLimit)
      ? ignored > 0
        ? `已按 .gitignore 等忽略文件跳过 ${ignored} 项（其中目录 ${budget.ignoredDirs} 个）；` +
          `要找被忽略的文件请传 includeIgnored: true`
        : FILTER_NOTE
      : "";
  if (hits.length === 0) {
    const suffix = ignoredNote === "" ? "" : `\n\n(${ignoredNote})`;
    return `没有匹配的文件：${pattern}${suffix}`;
  }
  // 排序后再截断：否则「前 500 个」是遍历顺序决定的，同一份仓库两次结果可能不同
  hits.sort((left, right) => left.localeCompare(right));
  const shown = hits.slice(0, MAX_GLOB_RESULTS);
  const truncation =
    hits.length <= shown.length
      ? ""
      : `已截断：共 ${hits.length} 个文件，仅显示前 ${MAX_GLOB_RESULTS} 个`;
  const notes = [truncation, ignoredNote].filter((note) => note !== "");
  const body = shown.join("\n");
  return notes.length === 0 ? body : `${body}\n\n(${notes.join("；")})`;
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
  includeIgnored: Type.Optional(
    Type.Boolean({
      description:
        "连被 .gitignore 忽略的文件一起搜（缺省 false）。默认会跳过被忽略的文件；" +
        "结果里若提示「已按 .gitignore 跳过 N 项」而你要找的正是那些文件，就传 true",
    }),
  ),
});

const globSchema = Type.Object({
  pattern: Type.String({
    description: "glob 模式，如 `**/*.ts`、`src/*.tsx`、`*.{json,md}`。** 跨目录、* 单段",
  }),
  path: Type.Optional(
    Type.String({ description: "起始目录（项目内相对路径，缺省=项目根）；不支持绝对路径与 .." }),
  ),
  includeIgnored: Type.Optional(
    Type.Boolean({ description: "连被 .gitignore 忽略的文件一起列（缺省 false），语义同 grep" }),
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
      "ignoreCase 忽略大小写；includeIgnored 连被忽略的文件一起搜。",
      "**默认跳过 .gitignore / .ignore / .rgignore 里被忽略的文件与目录**（构建产物、依赖、日志、",
      "本地配置等），外加 .git node_modules out dist .next 与二进制文件；跳过了多少会在末尾如实标注",
      "——看到「已按 .gitignore 跳过 N 项」而你要找的正是那些文件，就加 includeIgnored: true。",
      "结果最多 200 条、64KB，",
      `超出会在末尾标注「已截断」并给出匹配总数；一次最多扫 ${limit} 个文件，超出会标注「结果不完整」`,
      "（那时总数只是下限）——看到任何标注就请缩小 path 或 glob 再搜一次。",
      "没有匹配不是错误，会如实回一句「没有匹配」。",
    ].join("\n"),
    parameters: grepSchema,
    async execute(_toolCallId, params) {
      const text = await runGrep(projectRoot, params, limit, options.rgPath);
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
      "默认跳过 .gitignore 等忽略文件里的条目与 .git node_modules out dist .next（跳过多少会标注；",
      "要找被忽略的文件就加 includeIgnored: true）。结果最多 500 条，超出会在末尾标注。",
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
