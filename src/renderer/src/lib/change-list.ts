// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 「改动清单」的纯逻辑（规则 ⑦-G：清单是「任务摘要」的**下钻**，不另立视图）。
 *
 * 它取代了原先的 `file-tree.ts`（嵌套树）。差别在**分组粒度**：清单是**一层目录标签**
 * （概念稿里就是一条整目录路径 + 若干文件卡），不是「点开目录才见文件」的可折叠树——
 * 后者多消耗一次点击，而清单的读者要的恰恰是「这次都动了哪些文件」这个总览。
 *
 * 四件事都在这里定死：
 *   ① 分组与排序（按**最近改动**倒排，最新干过的活在最上面）
 *   ② 同一文件多次编辑**折成一条** `×N`（历史倒序随 `history` 带出，供展开看 `#3 #2 #1`）
 *   ③ 项目外路径过滤（`isProjectRelative`）——放进来就是点了没反应的死条目
 *   ④ 卡片上的 `+a −b` 是这一文件的**净值**（基线 → 现在），**不是**多次改动的逐次相加。
 *      逐次相加会把「改了又退回去」读成实打实的改动（`+10 −10`），而文件其实没变；
 *      净值来自主进程在改动落库时算好的结果（`ViewFileChange.netAddedLines`）。
 *      逐次的那对数字仍然给出来——在展开的历史行里，它们才是对的。
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
  /**
   * 该文件在本次会话里的**净值**（基线 → 现在），取自**最新那条**改动——
   * 主进程在每次改动落库时重算，故最新那条的数就是它此刻的净变化。
   *
   * 与 `history[i].addedLines`（**单次**改动的增删）是两回事：改完又退回原样时，
   * 逐次相加是 `+10 −10`，而净值是 `0`。卡片只显示净值，逐次数留给展开的历史行。
   * null = 没有基线，算不出（界面据此**不下结论**，而不是显示 0）。
   */
  netAddedLines: number | null;
  netRemovedLines: number | null;
  /** 最后一次改动的时间（排序用） */
  latestAt: number;
}

export interface ChangeGroup {
  /** 整条目录路径；根目录下的文件归到 `""` */
  dir: string;
  files: ChangeFile[];
  /** 组内**净值**合计（算不出的文件不计入） */
  netAddedLines: number;
  netRemovedLines: number;
  latestAt: number;
}

export interface ChangeList {
  groups: ChangeGroup[];
  /** 项目内的改动**条数**——总账里的「处」 */
  places: number;
  /** 项目内**去重后**的文件数——总账里的「文件」 */
  fileCount: number;
  /**
   * 项目内文件的**净值**合计——总账与清单头部的 `+a −b`。
   * 口径与卡片、与「累计」diff 一致：**结果**，不是「干了多少下」。
   */
  netAddedLines: number;
  netRemovedLines: number;
  /** 净值算不出的文件数（没有基线）——底部要如实说明，不让它们静默消失 */
  netUnknown: number;
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
      netAddedLines: null,
      netRemovedLines: null,
      latestAt: 0,
    };
    file.history.push(change);
    if (change.timestamp >= file.latestAt) {
      file.latestAt = change.timestamp;
      file.kind = change.kind;
      // 净值跟着最新那条走；更早的行只是历史记录，不代表文件此刻的样子
      file.netAddedLines = change.netAddedLines;
      file.netRemovedLines = change.netRemovedLines;
    }
    byPath.set(path, file);
  }

  const groups = new Map<string, ChangeGroup>();
  let places = 0;
  let netAddedLines = 0;
  let netRemovedLines = 0;
  let netUnknown = 0;

  for (const file of byPath.values()) {
    // 历史倒序（同一毫秒内按输入顺序，`Array.sort` 是稳定排序）——最新在前
    file.history.sort((a, b) => b.timestamp - a.timestamp);
    places += file.history.length;
    if (file.netAddedLines === null || file.netRemovedLines === null) {
      netUnknown += 1;
    } else {
      netAddedLines += file.netAddedLines;
      netRemovedLines += file.netRemovedLines;
    }

    const dir = file.path.includes("/")
      ? file.path.slice(0, file.path.lastIndexOf("/"))
      : "";
    const group = groups.get(dir) ?? {
      dir,
      files: [],
      netAddedLines: 0,
      netRemovedLines: 0,
      latestAt: 0,
    };
    group.files.push(file);
    group.netAddedLines += file.netAddedLines ?? 0;
    group.netRemovedLines += file.netRemovedLines ?? 0;
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
    netAddedLines,
    netRemovedLines,
    netUnknown,
    hidden: hiddenPaths.size,
  };
}
