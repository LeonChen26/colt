/**
 * 把「本次改动过的文件」折成一棵**目录树**（A3-4 范围 A）。
 *
 * 为什么只收**项目内相对路径**：`toRelative` 在文件位于 cwd 之外时会把**原始路径原样返回**
 * （可能是绝对路径，也可能本身就是 `../…`）。这类文件 `file.read` 是取不到的（约束 ⑦-4 只允许
 * 项目内），放进树里就是**点了没反应的死条目**——宁可整条不显示
 * （同「+」菜单只列真有的视图那条纪律，见 `AGENTS.md` §3.6）。
 *
 * 纯函数、不碰 electron / DOM，故 `tests/file-tree.test.ts` 可直接覆盖。
 */
import type { ViewFileChange } from "@shared/worker-protocol";

export interface FileTreeNode {
  /** 节点名（文件或目录的最后一段） */
  name: string;
  /** 项目内相对路径（目录不带尾斜杠） */
  path: string;
  /** 叶子节点才有：对应的改动记录；目录为 undefined（也是「是不是目录」的判据） */
  change?: ViewFileChange;
  children: FileTreeNode[];
}

/** Windows 盘符（`C:\` / `C:/`）、POSIX 根（`/`）、UNC（`\\server`）——都不是「项目内相对路径」 */
const ABSOLUTE_PATH = /^([a-zA-Z]:[\\/]|\/|\\\\)/;

/**
 * 这个路径能不能当「项目内文件」用（能不能预览）。
 *
 * 绝对路径与含 `..` 的逃逸路径都返回 false——它们与根外文件是一回事，
 * 预览必然失败，因此不该出现在任何可点入口里。
 */
export function isProjectRelative(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  if (normalized.trim() === "") return false;
  if (ABSOLUTE_PATH.test(normalized)) return false;
  return !normalized.split("/").some((part) => part === "..");
}

/**
 * 折树。同一路径重复出现时**保留最新的一条**（改动记录会随多次编辑追加）。
 * 排序：目录在前、文件在后，各自按名字升序（与文件管理器一致）。
 */
export function buildFileTree(changes: ViewFileChange[]): FileTreeNode[] {
  const newest = new Map<string, ViewFileChange>();
  for (const change of changes) {
    const previous = newest.get(change.path);
    if (previous === undefined || change.timestamp >= previous.timestamp) {
      newest.set(change.path, change);
    }
  }

  const roots: FileTreeNode[] = [];
  const dirs = new Map<string, FileTreeNode>();

  /** 逐段建出目录链，返回「该目录的 children 数组」以便挂文件 */
  const walkDirs = (segments: string[]): FileTreeNode[] => {
    let siblings = roots;
    let prefix = "";
    for (const segment of segments) {
      prefix = prefix === "" ? segment : `${prefix}/${segment}`;
      let dir = dirs.get(prefix);
      if (dir === undefined) {
        dir = { name: segment, path: prefix, children: [] };
        dirs.set(prefix, dir);
        siblings.push(dir);
      }
      siblings = dir.children;
    }
    return siblings;
  };

  for (const change of newest.values()) {
    if (!isProjectRelative(change.path)) continue;
    const segments = change.path
      .replaceAll("\\", "/")
      .split("/")
      .filter((part) => part !== "" && part !== ".");
    if (segments.length === 0) continue;
    const name = segments[segments.length - 1] as string;
    walkDirs(segments.slice(0, -1)).push({
      name,
      path: segments.join("/"),
      change,
      children: [],
    });
  }

  sortNodes(roots);
  return roots;
}

/** 目录优先、同级按名字升序；递归处理子层 */
function sortNodes(nodes: FileTreeNode[]): void {
  nodes.sort((a, b) => {
    const aIsDir = a.change === undefined;
    const bIsDir = b.change === undefined;
    if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const node of nodes) sortNodes(node.children);
}

/** 树里一共有多少个可预览的文件（给标题上的计数用） */
export function countTreeFiles(nodes: FileTreeNode[]): number {
  let total = 0;
  for (const node of nodes) {
    total += node.change === undefined ? countTreeFiles(node.children) : 1;
  }
  return total;
}
