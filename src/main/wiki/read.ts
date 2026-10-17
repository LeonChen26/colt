// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 读**仓库文档产物**（CodeWiki 生成的 `docs/wiki/`）。
 *
 * ## 这一层为什么独立成模块
 *
 * 产物是三方共用的**契约**：面板读它、模型读它、（将来的）生成器写它。
 * 若面板自己在渲染层拼路径、自己解析 `module_tree.json`，就会长出第二套
 * 「哪个模块对应哪个文件」的规则——而 CodeWiki 的布局有 hierarchical 与 flat
 * 两种，两套规则早晚分叉，症状是「树上点得开、树外打不开」。
 *
 * 所以：**目录布局的知识只在这里**，对外只暴露 `wiki.status` / `wiki.page` 两个形状。
 *
 * ## 安全边界（与 `file-read.ts` 同一条不变量）
 *
 * 入参 `path` 来自渲染层，而渲染层渲染的是 agent 生成的 Markdown——不可信。
 * 根由主进程按 `sessionId → 项目` 反查，这里再做三重校验：
 *   1. 归一后必须仍在**项目根**内；
 *   2. `realpath` 之后必须仍在**wiki 目录**内（挡「根内软链接指向根外」）；
 *   3. 只收 `.md`、拒 `temp/`、有大小上限。
 *
 * 纯 Node（不 import electron），故可被 `tests/wiki-read.test.ts` 直接覆盖。
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { isWithinRoot } from "../lib/path-guard";
import { WIKI_DIR } from "@shared/wiki";
import type { WikiPage, WikiStatus, WikiTreeNode } from "@shared/protocol";

/** 产物目录（相对项目根）由 `@shared/wiki` 定义——渲染层做页内链接时用的是同一个值 */
export { WIKI_DIR };

const TREE_FILE = "module_tree.json";
/**
 * 2.0 早期版本写的是 `first_module_tree.json`（本仓试跑时两个都在）。
 * 读不到主文件时退到它——**只影响导航树**，页面本身照常能读。
 */
const TREE_FILE_FALLBACK = "first_module_tree.json";
const META_FILE = "metadata.json";
const OVERVIEW_FILE = "overview.md";

/** 单页上限：wiki 页是给人读的，2MB 已经远超正常页面（正常 5~20KB） */
export const WIKI_PAGE_LIMIT = 2 * 1024 * 1024;

/** 递归计数时跳过的目录：`temp/` 是依赖图缓存（本仓实测占产物 99% 的体积） */
const SKIP_DIRS = new Set(["temp"]);

function toPosix(path: string): string {
  return path.split("\\").join("/");
}

/** 空快照：`present: false` 时用它，保证每个字段都有确定值（不留 undefined 让渲染层猜） */
function emptyStatus(): WikiStatus {
  return {
    present: false,
    dir: WIKI_DIR,
    overview: null,
    generatedAt: null,
    commit: null,
    head: null,
    behind: null,
    pages: 0,
    tree: [],
    error: null,
  };
}

function readJsonFile(path: string): { value: unknown; error: string | null } {
  try {
    return { value: JSON.parse(readFileSync(path, "utf8")) as unknown, error: null };
  } catch (error) {
    return {
      value: null,
      error: `${path.split(/[\\/]/).pop() ?? path} 不是合法 JSON：${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/**
 * 找一个模块节点对应的页面文件。
 *
 * 候选顺序照抄 CodeWiki `doc_layout` 的两条规则（`page_path`）：
 *   - hierarchical：`<父模块…>/<本模块>.md`
 *   - flat：`<本模块>.md`（小仓库用 `--flat`，所有页都在根）
 * 先 hierarchical 再 flat：两种布局并存时优先信息更全的那个。
 */
function pageFor(dirAbs: string, names: string[]): string | null {
  const name = names[names.length - 1] ?? "";
  if (name === "") return null;
  const candidates = [`${names.join("/")}.md`, `${name}.md`];
  for (const rel of candidates) {
    if (existsSync(join(dirAbs, rel))) return `${WIKI_DIR}/${rel}`;
  }
  return null;
}

/** `module_tree.json` 的一个节点：`{ path, components, children }`（其它键一律忽略） */
interface RawNode {
  children?: unknown;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildNodes(dirAbs: string, raw: Record<string, unknown>, parents: string[]): WikiTreeNode[] {
  const nodes: WikiTreeNode[] = [];
  for (const [title, value] of Object.entries(raw)) {
    const names = [...parents, title];
    const childrenRaw = isRecord(value) ? (value as RawNode).children : undefined;
    const children = isRecord(childrenRaw) ? buildNodes(dirAbs, childrenRaw, names) : [];
    nodes.push({ title, page: pageFor(dirAbs, names), children });
  }
  return nodes;
}

/** 递归数 `*.md`（跳过 `temp/` 与隐藏目录） */
function countPages(dirAbs: string): number {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      total += countPages(join(dirAbs, entry.name));
    } else if (entry.name.toLowerCase().endsWith(".md")) {
      total += 1;
    }
  }
  return total;
}

/** git 的只读调用参数：与 `main/git.ts` 同一口径（超时即杀，不给慢仓库拖住 IPC） */
const GIT_SPAWN_OPTIONS = { timeout: 10_000, windowsHide: true, maxBuffer: 1024 * 1024 } as const;

/** 跑一条只读 git 命令；失败一律返回 null（「不知道」，不是「没有」） */
function runGit(args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolvePromise) => {
    execFile("git", args, { ...GIT_SPAWN_OPTIONS, cwd }, (error, stdout) => {
      resolvePromise(error === null ? stdout.trim() : null);
    });
  });
}

/**
 * 产物与当前 HEAD 的关系。
 *
 * 三个结果必须分开：`null` = 比较不了（非仓库 / 生成时的提交已不在历史里，比如被 rebase 掉了），
 * `0` = 一致，`>0` = 落后几个提交。把「不知道」显示成「最新」是这个面板最容易撒的谎。
 */
async function staleness(
  rootAbs: string,
  commit: string | null,
): Promise<{ head: string | null; behind: number | null }> {
  const head = await runGit(["rev-parse", "HEAD"], rootAbs);
  if (head === null) return { head: null, behind: null };
  if (commit === null) return { head, behind: null };
  if (commit === head) return { head, behind: 0 };
  const count = await runGit(["rev-list", "--count", `${commit}..HEAD`], rootAbs);
  if (count === null) return { head, behind: null };
  const parsed = Number.parseInt(count, 10);
  return { head, behind: Number.isFinite(parsed) ? parsed : null };
}

/**
 * 读一份现状快照（`wiki.status` 的唯一实现）。
 *
 * 没有 `docs/wiki/` 是**正常状态**（绝大多数仓库没有），返回 `present: false` 而不抛错——
 * 界面据此显示「未生成 + 怎么生成」，那不是错误。
 */
export async function readWikiStatus(root: string): Promise<WikiStatus> {
  const rootAbs = resolve(root);
  const dirAbs = join(rootAbs, WIKI_DIR);
  if (!existsSync(rootAbs) || !existsSync(dirAbs)) return emptyStatus();

  const status: WikiStatus = {
    ...emptyStatus(),
    present: true,
    overview: existsSync(join(dirAbs, OVERVIEW_FILE)) ? `${WIKI_DIR}/${OVERVIEW_FILE}` : null,
    pages: countPages(dirAbs),
  };

  // metadata：生成时间与提交。手工产物 / 旧版可能没有这个文件，那不是错误。
  if (existsSync(join(dirAbs, META_FILE))) {
    const { value, error } = readJsonFile(join(dirAbs, META_FILE));
    if (error !== null) status.error = error;
    const info = isRecord(value) && isRecord(value.generation_info) ? value.generation_info : null;
    if (info !== null) {
      if (typeof info.timestamp === "string") status.generatedAt = info.timestamp;
      if (typeof info.commit_id === "string" && info.commit_id.trim() !== "") {
        status.commit = info.commit_id.trim();
      }
    }
  }

  // 导航树：两种文件名都试；都没有就只留概览（不让整页变成空白）
  const treeAbs = [TREE_FILE, TREE_FILE_FALLBACK]
    .map((name) => join(dirAbs, name))
    .find((path) => existsSync(path));
  if (treeAbs === undefined) {
    status.error = status.error ?? `缺少 ${TREE_FILE}：只能看到概览，没有模块导航`;
  } else {
    const { value, error } = readJsonFile(treeAbs);
    if (error !== null) status.error = status.error ?? error;
    else if (!isRecord(value)) status.error = status.error ?? `${TREE_FILE} 的结构不是对象`;
    else status.tree = buildNodes(dirAbs, value, []);
  }

  Object.assign(status, await staleness(rootAbs, status.commit));
  return status;
}

/**
 * 读一页正文。
 *
 * `requested` 只应来自 `wiki.status` 给出的路径，但**不信任**它：越界、非 md、
 * `temp/` 全部在**任何 fs 访问之前**拒绝（先判字符串，再碰磁盘——`file-read.ts` 同款顺序，
 * 否则「存在与否」本身就成了可探测的信息）。
 */
export function readWikiPage(root: string, requested: string): WikiPage {
  const path = requested.trim();
  if (path === "") throw new Error("路径为空");
  if (!path.toLowerCase().endsWith(".md")) throw new Error("只能读取 wiki 的 .md 页面");

  const rootReal = realpathSync(resolve(root));
  const absolute = resolve(rootReal, path);
  if (!isWithinRoot(rootReal, absolute)) throw new Error("路径越界：只能读取项目内的文件");

  const wikiReal = realpathSync(join(rootReal, WIKI_DIR));
  const targetReal = realpathSync(absolute);
  if (!isWithinRoot(wikiReal, targetReal)) throw new Error("路径越界：只能读取 wiki 目录内的页面");

  const relToWiki = toPosix(targetReal.slice(wikiReal.length + 1));
  if (relToWiki === "" || relToWiki.split("/")[0] === "temp") {
    throw new Error("temp/ 里是生成过程的中间产物，不是 wiki 页面");
  }

  const stat = statSync(targetReal);
  if (!stat.isFile()) throw new Error("目标不是文件");
  if (stat.size > WIKI_PAGE_LIMIT) {
    throw new Error(`页面过大（${stat.size} 字节，上限 ${WIKI_PAGE_LIMIT}）`);
  }
  return {
    path: `${WIKI_DIR}/${relToWiki}`,
    text: readFileSync(targetReal, "utf8"),
    size: stat.size,
  };
}
