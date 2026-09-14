/**
 * 「改动清单」的纯逻辑（规则 ⑦-G：清单是「正在处理」的**下钻**，不另立视图）。
 *
 * 它取代了原先的 `file-tree.ts`（嵌套树）。差别在**分组粒度**：清单是**一层目录标签**
 * （概念稿里就是一条整目录路径 + 若干文件卡），不是「点开目录才见文件」的可折叠树——
 * 后者多消耗一次点击，而清单的读者要的恰恰是「这次都动了哪些文件」这个总览。
 *
 * 三件事都在这里定死：
 *   ① 分组与排序（按**最近改动**倒排，最新干过的活在最上面）
 *   ② 同一文件多次编辑**折成一条** `×N`（历史倒序随 `history` 带出，供展开看 `#3 #2 #1`）
 *   ③ 项目外路径过滤（`isProjectRelative`）——放进来就是点了没反应的死条目
 *
 * 纯函数、不碰 electron / DOM，故 `tests/lib.test.ts` 直接覆盖。
 */
import type { ViewFileChange } from "@shared/worker-protocol";

/** Windows 盘符（`C:\` / `C:/`）、POSIX 根（`/`）、UNC（`\\server`）——都不是「项目内相对路径」 */
const ABSOLUTE_PATH = /^([a-zA-Z]:[\\/]|\/|\\\\)/;

/**
 * 这个路径能不能当「项目内文件」用（能不能预览）。
 *
 * 绝对路径与含 `..` 的逃逸路径都返回 false——它们与根外文件是一回事，
 * 预览必然失败，因此不该出现在任何可点入口里（约束 ⑦-4）。
 */
export function isProjectRelative(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  if (normalized.trim() === "") return false;
  if (ABSOLUTE_PATH.test(normalized)) return false;
  return !normalized.split("/").some((part) => part === "..");
}

export interface ChangeFile {
  /** 项目内相对路径（反斜杠已归一） */
  path: string;
  /** 最后一段，清单里显示的名字 */
  name: string;
  /** **最新一次**的 kind，决定 `M` / `A` 标记 */
  kind: "write" | "edit";
  /** 该文件的全部改动，**倒序**（最新在前）——`×N` 展开后的历史列表直接用 */
  history: ViewFileChange[];
  /** 该文件所有历史的合计（概念稿里 `×3` 的卡片写 `+46 −12`，正是三行历史之和） */
  addedLines: number;
  removedLines: number;
  /** 最后一次改动的时间（排序用） */
  latestAt: number;
}

export interface ChangeGroup {
  /** 整条目录路径；根目录下的文件归到 `""` */
  dir: string;
  files: ChangeFile[];
  addedLines: number;
  removedLines: number;
  latestAt: number;
}

export interface ChangeList {
  groups: ChangeGroup[];
  /** 项目内的改动**条数**——总账里的「处」 */
  places: number;
  /** 项目内**去重后**的文件数——总账里的「文件」 */
  fileCount: number;
  addedLines: number;
  removedLines: number;
  /** 被丢掉的项目外文件数（按路径去重）——清单底部要如实说明「隐藏了几个」 */
  hidden: number;
}

export function buildChangeList(changes: ViewFileChange[]): ChangeList {
  const byPath = new Map<string, ChangeFile>();
  const hiddenPaths = new Set<string>();

  for (const change of changes) {
    const normalized = change.path.replaceAll("\\", "/");
    // 归一之后可能是空串（如 "./"），与越界同等处理
    const segments = normalized.split("/").filter((part) => part !== "" && part !== ".");
    if (!isProjectRelative(normalized) || segments.length === 0) {
      hiddenPaths.add(change.path);
      continue;
    }

    const path = segments.join("/");
    const file = byPath.get(path) ?? {
      path,
      name: segments[segments.length - 1] as string,
      kind: change.kind,
      history: [],
      addedLines: 0,
      removedLines: 0,
      latestAt: 0,
    };
    file.history.push(change);
    file.addedLines += change.addedLines;
    file.removedLines += change.removedLines;
    if (change.timestamp >= file.latestAt) {
      file.latestAt = change.timestamp;
      file.kind = change.kind;
    }
    byPath.set(path, file);
  }

  const groups = new Map<string, ChangeGroup>();
  let places = 0;
  let addedLines = 0;
  let removedLines = 0;

  for (const file of byPath.values()) {
    // 历史倒序（同一毫秒内按输入顺序，`Array.sort` 是稳定排序）——最新在前
    file.history.sort((a, b) => b.timestamp - a.timestamp);
    places += file.history.length;
    addedLines += file.addedLines;
    removedLines += file.removedLines;

    const dir = file.path.includes("/")
      ? file.path.slice(0, file.path.lastIndexOf("/"))
      : "";
    const group = groups.get(dir) ?? { dir, files: [], addedLines: 0, removedLines: 0, latestAt: 0 };
    group.files.push(file);
    group.addedLines += file.addedLines;
    group.removedLines += file.removedLines;
    group.latestAt = Math.max(group.latestAt, file.latestAt);
    groups.set(dir, group);
  }

  const list = [...groups.values()];
  for (const group of list) {
    group.files.sort((a, b) => b.latestAt - a.latestAt || a.path.localeCompare(b.path));
  }
  // 组与组之间也按「最近动过」排：刚干完的活在顶上，不用往下翻
  list.sort((a, b) => b.latestAt - a.latestAt || a.dir.localeCompare(b.dir));

  return {
    groups: list,
    places,
    fileCount: byPath.size,
    addedLines,
    removedLines,
    hidden: hiddenPaths.size,
  };
}
