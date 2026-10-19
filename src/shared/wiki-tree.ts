// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * `module_tree.json` → 导航树，**布局规则只此一份**。
 *
 * 为什么要抽出来：主进程的 `wiki.status` 与 worker 的提示词注入都要回答同一个问题
 * ——「这个模块对应哪个页面文件」。两处各写一遍，CodeWiki 的两种布局（hierarchical /
 * flat）迟早会在其中一处漏掉，症状是「面板点得开、注入里给错路径」，而且不报错。
 *
 * 本模块**不碰磁盘**：文件存在与否由调用方以 `exists` 注入（主进程用 `existsSync`，
 * worker 用同一套，测试里用 Map）。这样它既能在 hook 里跑，也能被单测直接覆盖。
 */
import type { WikiTreeNode } from "./protocol";
import { WIKI_DIR } from "./wiki";

/** `module_tree.json` 的一个节点：`children` 与 `components` 是我们认的，其余键忽略 */
interface RawNode {
  children?: unknown;
  components?: unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 拆一条 CodeWiki 的组件引用：`src/main/session-manager.ts::SessionManager.abort`。
 *
 * `::` 后面是符号名（CodeWiki 只给到类 / 方法，**没有行号**），也可能没有——
 * 旧版产物或纯文件引用就只有路径。返回的 `path` 已把 `\` 归一成 `/`，
 * 否则 Windows 产物在渲染层拼出来的路径在别处会对不上。
 *
 * 空串 / 只有 `::` 这类残渣返回 null，由调用方跳过（不画一个点了报错的死条目）。
 */
export function parseWikiComponent(
  raw: string,
): { path: string; symbol: string | null } | null {
  const text = raw.trim().split("\\").join("/");
  if (text === "") return null;
  const split = text.indexOf("::");
  const path = (split === -1 ? text : text.slice(0, split)).trim();
  if (path === "") return null;
  const symbol = split === -1 ? "" : text.slice(split + 2).trim();
  return { path, symbol: symbol === "" ? null : symbol };
}

/** 读一个节点的 components：只认非空字符串，归一分隔符，按原序去重 */
function readComponents(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const text = item.trim().split("\\").join("/");
    if (text !== "") seen.add(text);
  }
  return [...seen];
}

/**
 * 一个模块可能的页面路径（**相对 wiki 目录**），按优先级排列。
 *
 * 照抄 CodeWiki `doc_layout` 的两条规则：
 *   - hierarchical：`<父模块…>/<本模块>.md`
 *   - flat：`<本模块>.md`（小仓库用 `--flat`，所有页都摊在根）
 * 先 hierarchical 再 flat：两种布局并存时优先信息更全的那个。
 */
export function pageCandidates(names: readonly string[]): string[] {
  const name = names[names.length - 1] ?? "";
  if (name === "") return [];
  return [`${names.join("/")}.md`, `${name}.md`];
}

/**
 * 建树。`exists(rel)` 收的是**相对 wiki 目录**的路径，返回该页是否存在。
 *
 * 页面不存在的节点仍然保留（挂在树上、`page: null`）：它可能是纯分组节点，
 * 也可能只是生成时被跳过了——两种情况的界面上都该看得见，而不是整枝消失。
 */
export function buildWikiTree(
  raw: Record<string, unknown>,
  exists: (relativeToWiki: string) => boolean,
): WikiTreeNode[] {
  const walk = (level: Record<string, unknown>, parents: readonly string[]): WikiTreeNode[] => {
    const nodes: WikiTreeNode[] = [];
    for (const [title, value] of Object.entries(level)) {
      const names = [...parents, title];
      const raw = isRecord(value) ? (value as RawNode) : undefined;
      const childrenRaw = raw?.children;
      const children = isRecord(childrenRaw) ? walk(childrenRaw, names) : [];
      const found = pageCandidates(names).find((rel) => exists(rel)) ?? null;
      nodes.push({
        title,
        components: readComponents(raw?.components),
        page: found === null ? null : `${WIKI_DIR}/${found}`,
        children,
      });
    }
    return nodes;
  };
  return walk(raw, []);
}

/**
 * 某一页对应哪个模块的组件清单；概览页（不在树里）返回空数组。
 *
 * **命中即停**：`pageCandidates` 的 flat 兜底可能让不同父节点下的同名叶子解析到
 * 同一个页面——此时返回**树序第一个**命中者的清单，哪怕它是空数组。不能用
 * 「清单非空才认命中」判断：那会让「命中但没组件」继续搜到撞页兄弟的非空清单，
 * 结果取决于遍历顺序。
 */
function findComponents(
  nodes: readonly WikiTreeNode[],
  page: string,
): string[] | null {
  for (const node of nodes) {
    if (node.page === page) return node.components;
    const found = findComponents(node.children, page);
    if (found !== null) return found;
  }
  return null;
}

export function componentsForPage(
  nodes: readonly WikiTreeNode[],
  page: string,
): string[] {
  return findComponents(nodes, page) ?? [];
}

/** 摊平成「有页面的模块」清单，保持树序（父在子前），供注入块按预算裁剪 */
export function flattenWikiPages(
  tree: readonly WikiTreeNode[],
  parents: readonly string[] = [],
): { path: string; title: string }[] {
  const out: { path: string; title: string }[] = [];
  for (const node of tree) {
    const names = [...parents, node.title];
    if (node.page !== null) out.push({ path: node.page, title: names.join(" / ") });
    out.push(...flattenWikiPages(node.children, names));
  }
  return out;
}
