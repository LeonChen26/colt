// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 仓库 Wiki 的读取与注入（`transform_context` 里每请求拼一次）。
 *
 * 产物是 `docs/wiki/`：`module_tree.json`（模块树）+ `metadata.json`（生成信息）+ 每模块一页 `.md`。
 * 这里只负责「读出来 + 算新鲜度 + 交给 `@shared/wiki-map` 渲染」，
 * 布局规则与文案都在纯函数那边（`@shared/wiki-tree` / `@shared/wiki-map`）。
 *
 * ## 三条刻意的取舍
 *
 * 1. **每请求重读，但按 mtime 短路**。产物可能在会话中途被重新生成或被人手改，
 *    缓存整块的代价是「模型拿着上一版地图指路」。用两个文件（树 + 元信息）的
 *    `mtime:size` 当键，命中时连 JSON 都不解析。
 * 2. **git 新鲜度有 TTL（5 分钟）**。`rev-list --count` 在正常仓库是毫秒级，但它是
 *    一次 spawn，放在每请求路径上不合适；而产物落后与否不会在 5 分钟里改变决策。
 *    失败（非仓库 / 没装 git / 生成时的提交已被 rebase 掉）一律是 **null = 不知道**。
 * 3. **没有产物就一个字都不注入**。`docs/wiki/` 不存在是常态（绝大多数仓库没有），
 *    此时给一段「（无 wiki）」只会白占每轮的上下文。
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { WIKI_DIR } from "@shared/wiki";
import { renderWikiMap, type WikiMapEntry, type WikiMapInput } from "@shared/wiki-map";
import { buildWikiTree, flattenWikiPages, isRecord } from "@shared/wiki-tree";

const TREE_FILE = "module_tree.json";
/** 2.0 早期版本写的是这个名字（与 `main/wiki/read.ts` 同口径：只影响导航，不影响页面读取） */
const TREE_FILE_FALLBACK = "first_module_tree.json";
const META_FILE = "metadata.json";
const OVERVIEW_FILE = "overview.md";

/** git 新鲜度的缓存时长：够久到不进每请求的热路径，够短到「刚 rebase 完」不会被误导 */
const GIT_TTL_MS = 5 * 60 * 1000;
/** 只读 git 调用的超时：慢仓库不该拖住模型请求（宁可报「不知道」） */
const GIT_TIMEOUT_MS = 3000;

export interface WikiMapInjector {
  /** 每次模型请求前重算并拼到 base 后面；没有产物时原样返回 base */
  systemPromptFor(base: string): Promise<string>;
}

interface Snapshot {
  /** 缓存键：两个文件的 `mtime:size` 拼起来。变了就重算 */
  key: string;
  /** 产物快照；没有可用产物时为 null */
  input: WikiMapInput | null;
  /** `metadata.json` 记录的生成提交；用于算落后多少（算不出来就是 null） */
  commit: string | null;
}

function fileSignature(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    // 不存在与读不到在缓存键上是同一件事：都表示「这轮没有它」。真正的失败由 JSON 解析报
    return "absent";
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

/**
 * 读一份产物快照；没有任何可用产物时 `input` 为 null。
 *
 * `broken` 只用于上报（交给 `onError`），不影响返回值——树坏了仍然可以注入概览页，
 * 让模型至少知道 wiki 有内容、只是导航缺失。
 */
function readSnapshot(
  cwd: string,
  treeAbs: string | null,
  metaAbs: string | null,
  broken: string[],
): { input: WikiMapInput | null; commit: string | null } {
  const dirAbs = join(cwd, WIKI_DIR);
  const overview = existsSync(join(dirAbs, OVERVIEW_FILE)) ? `${WIKI_DIR}/${OVERVIEW_FILE}` : null;

  const entries: WikiMapEntry[] = [];
  if (treeAbs !== null) {
    try {
      const raw = readJson(treeAbs);
      if (isRecord(raw)) {
        const tree = buildWikiTree(raw, (rel) => existsSync(join(dirAbs, rel)));
        entries.push(...flattenWikiPages(tree));
      } else {
        broken.push(`${TREE_FILE} 的结构不是对象，模块导航无法注入`);
      }
    } catch (error) {
      broken.push(
        `${treeAbs.split(/[\\/]/).pop() ?? TREE_FILE} 读取失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  let generatedAt: string | null = null;
  let commit: string | null = null;
  if (metaAbs !== null) {
    try {
      const raw = readJson(metaAbs);
      const info = isRecord(raw) && isRecord(raw.generation_info) ? raw.generation_info : null;
      if (info !== null) {
        if (typeof info.timestamp === "string") generatedAt = info.timestamp;
        if (typeof info.commit_id === "string" && info.commit_id.trim() !== "") {
          commit = info.commit_id.trim();
        }
      }
    } catch (error) {
      broken.push(
        `${META_FILE} 读取失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (overview === null && entries.length === 0) return { input: null, commit };
  // `behind` 先占位：它要 spawn 一次 git，按 TTL 在调用方算，避免进每请求的热路径
  return { input: { overview, entries, generatedAt, behind: null }, commit };
}

/** 落后多少个提交。`null` = 不知道（非仓库 / 没 git / 生成时的提交已不在历史里） */
function gitBehind(cwd: string, commit: string): Promise<number | null> {
  return new Promise((resolvePromise) => {
    execFile(
      "git",
      ["rev-list", "--count", `${commit}..HEAD`],
      { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        if (error !== null) return resolvePromise(null);
        const parsed = Number.parseInt(stdout.trim(), 10);
        resolvePromise(Number.isFinite(parsed) ? parsed : null);
      },
    );
  });
}

/**
 * 每请求注入器。`onError` 只在该说的说一次（同一句不重复报），
 * 因为这段代码跑在**每次模型请求**上，重复上报会把通知区刷满。
 */
export function createWikiMapInjector(
  cwd: string,
  onError?: (message: string) => void,
): WikiMapInjector {
  const dirAbs = join(cwd, WIKI_DIR);
  const treeAbs = [TREE_FILE, TREE_FILE_FALLBACK]
    .map((name) => join(dirAbs, name))
    .find((path) => existsSync(path)) ?? null;
  const metaAbs = existsSync(join(dirAbs, META_FILE)) ? join(dirAbs, META_FILE) : null;

  let cache: Snapshot | null = null;
  let gitCache: { commit: string; at: number; behind: number | null } | null = null;
  const reported = new Set<string>();

  const report = (message: string): void => {
    if (onError === undefined || reported.has(message)) return;
    reported.add(message);
    onError(message);
  };

  return {
    async systemPromptFor(base: string): Promise<string> {
      // `docs/wiki/` 都不存在：常态，直接返回，连 stat 都省了
      if (treeAbs === null && metaAbs === null && !existsSync(join(dirAbs, OVERVIEW_FILE))) {
        return base;
      }

      const key = `${fileSignature(treeAbs ?? "")}|${fileSignature(metaAbs ?? "")}`;
      if (cache === null || cache.key !== key) {
        const broken: string[] = [];
        const snapshot = readSnapshot(cwd, treeAbs, metaAbs, broken);
        for (const message of broken) report(`仓库 wiki：${message}`);
        cache = { key, input: snapshot.input, commit: snapshot.commit };
      }
      const input = cache.input;
      if (input === null) return base;

      // 新鲜度：只用 metadata 里的生成提交去比 HEAD；没有提交记录就保持 null（不知道）
      const commit = cache.commit;
      let behind: number | null = null;
      if (commit !== null) {
        const now = Date.now();
        if (gitCache === null || gitCache.commit !== commit || now - gitCache.at > GIT_TTL_MS) {
          gitCache = { commit, at: now, behind: await gitBehind(cwd, commit) };
        }
        behind = gitCache.behind;
      }

      const block = renderWikiMap({ ...input, behind });
      return block === "" ? base : `${base}\n\n${block}`;
    },
  };
}
