// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 「任务摘要」的下钻（规则 ⑦-G）：**清单 → diff → 内容**，一个东西的连续下钻。
 *
 * 它取代了原先并列的两个页签（「改动」`ChangesPanel` + 「文件」`FilePanel`）——
 * 用户不需要知道「该去改动页签还是文件页签」，只需要知道「想看得更细」
 * （概念稿的页签行只剩 任务摘要 / 浏览器 / 统计 / 规则）。
 *
 * 层与进入方式：
 *   - `list`（清单层）：总账点进来。按目录一层分组、同文件多次编辑折成 `×N`、
 *     卡片上的 `+a −b` **只在这里出现一次**（且是**净值**，见下）；点文件卡（或它的历史行）→ `diff`
 *   - `diff`：该次改动的 patch，可在历史之间切换，「看文件」→ `content`
 *   - `content`：文件本身（`FilePreview`）。**④ 点文件路径直接落这一层**
 *     （原 A3-2 的入口，行为等价，只是不再切页签）
 *
 * **净值与逐次改动是两件事**（这正是本文件最容易搞错的地方）：
 *   逐次 patch 只说「这一次改了什么」。文件改过三次、最后一次又退回原样时，
 *   三次相加是 `+10 −10`，而文件其实和一开始一模一样——照相加显示，就等于在撒谎。
 *   故：**卡片上的数字是净值**（基线 → 现在，主进程算好写在改动记录上），
 *   逐次的数字只出现在**展开的历史行**里；`diff` 层还多一档「累计」，
 *   直接把「改前 → 现在」的完整差异画出来（那一档要现算，见 `NetDiff`）。
 *
 * 逐层回退有三条出口：面包屑、各层底部那一行「返回」、ESC。
 * **层状态由本组件持有**（容器只管「在不在下钻」，见 `WorkspaceDock`）：
 * 层内跳转不该绕一圈回到容器再下来。
 */
import { useEffect, useMemo, useState } from "react";
import { Bot, ChevronLeft, ChevronRight, FileDiff, FileText, Folder, Undo2 } from "lucide-react";
import { ICON } from "@/lib/icon";
import { buildChangeList, type ChangeFile } from "@/lib/change-list";
import { formatAgo, samePath } from "@/lib/format";
import { cn } from "@/lib/utils";
import { DiffView } from "../../../components/DiffView";
import type { NetChangeResult } from "@shared/protocol";
import type { ViewFileChange, ViewSubagent } from "@shared/worker-protocol";
import { FilePreview } from "./FilePreview";
import { SubagentStream } from "./SubagentStream";

/**
 * 下钻的层。
 *
 * `list / diff / content` 是「本次改动」那条线（清单 → diff → 文件内容）；
 * `subagent` 是**并排的另一种下钻目标**：某个子代理的完整过程流（决策三 D5）。
 * 它不是「改动」这条线的某一层——进入它不经过清单，回退也是直接回「任务摘要」。
 */
export type DrillLayer = "list" | "diff" | "content" | "subagent";

/**
 * 容器发来的「进入下钻 / 换层」**指令**。
 *
 * 它是指令，**不是**「当前在哪一层」——当前层由本组件持有（层内跳转不该绕一圈回到容器）。
 * 所以容器手上那份随时可能滞后，**任何地方都不该读它来判断「现在是什么层」**。
 *
 * `nonce` 不能省：本组件靠它判断「这是一次新请求」，而不是靠对象身份。
 * 对象身份是个隐式依赖——调用方一旦复用或 memo 化同一个对象（`setState` 收到同一个引用时
 * React 还会直接 bail out），下面的 `useEffect` 就不再触发，症状是「点了没反应」，
 * 而代码看上去毫无问题。把「新请求」写成数据，就不必再要求调用方自觉。
 */
export interface DrillRequest {
  /** 单调递增；**同一层连续请求两次也必须是两个不同的值** */
  readonly nonce: number;
  readonly layer: DrillLayer;
  /** 仅 `content` 层有意义 */
  readonly path: string | null;
  /** 仅 `content` / `subagent` 层有意义：重读同一目标（文件内容 / 子代理流）靠它自增 */
  readonly token: number;
  /** 仅 `subagent` 层有意义：要展开的那个子代理（`ViewSubagent.id`） */
  readonly subagentId: string | null;
}

/**
 * 「累计」这一档的记号（`diff` 层的历史切换里与 `#1 #2 #3` 并列的那个）。
 *
 * 它不是一个 revision：`#N` 说的是「第 N 次改动」，而它说的是「这些改动**加起来**的结果」，
 * 故不给它编号——编号会让人以为它也对应某一次记录。
 */
const NET_REVISION = "__net__";

/** 净值算不出（没有基线）时，卡片右侧与「累计」档共用的一句解释 */
const netTitle = (file: ChangeFile): string =>
  file.netAddedLines === null || file.netRemovedLines === null
    ? "未能记录改动前的内容（文件过大 / 二进制 / 读取失败），给不出净变化；展开可看逐次改动"
    : "本次会话的净变化（改动前 → 现在）";

/**
 * 净值的那一小撮数字：`+a −b`；净 0 时明说「已还原」；算不出返回 null。
 * 表格化三种情形是为了**不留第二种说法**——「已还原」与「算不出」在这一层就分开了，
 * 调用方只需决定留白怎么画（卡片留空、累计行写 `—`）。
 */
function NetNumbers({
  added,
  removed,
}: {
  added: number | null;
  removed: number | null;
}): React.JSX.Element | null {
  if (added === null || removed === null) return null;
  if (added === 0 && removed === 0) return <span className="text-text-muted">已还原</span>;
  return (
    <>
      {added > 0 && <span className="text-success-fg">+{added}</span>}
      {removed > 0 && <span className="ml-1 text-danger-fg">−{removed}</span>}
    </>
  );
}


/** 面包屑与底部「返回」行共用的一枚小按钮 */
function CrumbButton({
  marker,
  label,
  onClick,
}: {
  marker: string;
  label: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-drill-crumb={marker}
      onClick={onClick}
      className="flex shrink-0 items-center gap-1 rounded-xs px-1 py-0.5 text-xs text-text-muted transition hover:bg-surface-overlay hover:text-text-primary"
    >
      <ChevronLeft {...ICON.xs} />
      {label}
    </button>
  );
}

/** 各层底部那一行返回：与面包屑同义，但更靠近内容，滚动到底时不必回到顶部 */
function BackRow({
  label,
  hint,
  onClick,
}: {
  label: string;
  hint?: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-drill-back=""
      onClick={onClick}
      className="group flex w-full shrink-0 items-center gap-2 border-t border-line bg-surface px-3 py-2 text-left transition hover:bg-surface-overlay"
    >
      <Undo2 {...ICON.sm} className="shrink-0 text-text-muted" />
      <span className="text-xs text-text-secondary">{label}</span>
      <span className="ml-auto shrink-0 text-xs text-text-muted transition group-hover:text-text-primary">
        {hint ?? "ESC"}
      </span>
    </button>
  );
}

/**
 * 「累计」这一档的内容：该文件**本次会话的净变化**（基线 → 现在）。
 *
 * 与逐次 patch 不同，这一份要**现算**：主进程取库里那份基线，与**此刻盘上**的文件比一次——
 * 故它答的正是「这个文件最终被改成了什么」，哪怕中间有人在编辑器里手工动过。
 * 三种结论都如实画出来：有差异给 patch；无差异 = 已还原；算不出则说清是「没有基线」
 * 还是「文件读不到」——**不拿 0 冒充**，否则「没改过」与「不知道」就分不开了。
 *
 * 已知净值为 0 时不必问主进程：库里那对数就是刚算出来的结论，省一次读盘 + diff。
 */
function NetDiff({
  sessionId,
  path,
  net,
}: {
  sessionId: string;
  path: string;
  net: { added: number; removed: number } | null;
}): React.JSX.Element {
  const [result, setResult] = useState<NetChangeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reverted = net !== null && net.added === 0 && net.removed === 0;

  useEffect(() => {
    if (reverted) return undefined;
    let disposed = false;
    setResult(null);
    setError(null);
    void window.colt
      .invoke("file.netDiff", { sessionId, path })
      .then((next) => {
        if (!disposed) setResult(next);
      })
      .catch((cause: unknown) => {
        if (disposed) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      disposed = true;
    };
  }, [sessionId, path, reverted]);

  if (reverted) {
    return (
      <p className="px-2 py-6 text-center text-xs leading-relaxed text-text-muted">
        本次会话已还原：该文件当前内容与改动前一致。
      </p>
    );
  }
  if (error !== null) {
    return (
      <p className="px-2 py-6 text-center text-xs leading-relaxed text-text-muted">
        无法获取净变化：{error}
      </p>
    );
  }
  if (result === null) {
    return (
      <p className="px-2 py-6 text-center text-xs leading-relaxed text-text-muted">
        正在计算净变化…
      </p>
    );
  }
  if (result.status !== "ok") {
    return (
      <p className="px-2 py-6 text-center text-xs leading-relaxed text-text-muted">
        {result.reason}
      </p>
    );
  }
  if (result.patch === "") {
    return (
      <p className="px-2 py-6 text-center text-xs leading-relaxed text-text-muted">
        本次会话已还原：该文件当前内容与改动前一致。
      </p>
    );
  }
  return <DiffView patch={result.patch} />;
}

export function ChangeDrilldown({
  sessionId,
  changes,
  subagents,
  entry,
  highlightPath,
  menuOpen,
  onExit,
}: {
  sessionId: string;
  changes: ViewFileChange[];
  /** 本次会话的子代理总账——`subagent` 层靠它在面包屑上写出名字 */
  subagents: ViewSubagent[];
  /** 容器发来的进入请求（点总账 = 清单层；点路径 = 内容层；点子代理 = 子代理流层） */
  entry: DrillRequest;
  /** hover ④ 的工具卡时跟随高亮清单里对应的文件行（⑦-A 的现场联动） */
  highlightPath?: string | null;
  /** 「+」菜单开着时不接管 ESC——一次按键只该做一件事 */
  menuOpen: boolean;
  /** 回到「任务摘要」（面包屑第一段 / 清单层底部的返回） */
  onExit: () => void;
}): React.JSX.Element {
  const list = useMemo(() => buildChangeList(changes), [changes]);
  const files = useMemo(
    () => list.groups.flatMap((group) => group.files),
    [list],
  );
  const fileOf = (path: string | null): ChangeFile | undefined =>
    path === null ? undefined : files.find((item) => item.path === path);

  const [layer, setLayer] = useState<DrillLayer>(entry.layer);
  const [path, setPath] = useState<string | null>(entry.layer === "content" ? entry.path : null);
  const [subagentId, setSubagentId] = useState<string | null>(
    entry.layer === "subagent" ? entry.subagentId : null,
  );
  const [revisionId, setRevisionId] = useState<string | null>(null);
  /** `×N` 展开了历史的那几个文件 */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  /** 内容层的重读令牌：换文件时靠 `path` 变，重读同一文件靠它自增 */
  const [token, setToken] = useState(entry.layer === "content" ? entry.token : 0);

  // 容器再次发来请求（④ 又点了一个路径 / 又点了总账 / 又点了一个子代理）→ 按请求重置层。
  // 依赖是 **`nonce`** 而不是 `entry` 对象本身：对象身份会因调用方的实现细节而变或不变，
  // `nonce` 只随「真的有新请求」而变。理由见 `DrillRequest`。
  useEffect(() => {
    setLayer(entry.layer);
    setRevisionId(null);
    if (entry.layer === "content") {
      setPath(entry.path);
      setToken(entry.token);
    }
    if (entry.layer === "subagent") {
      setSubagentId(entry.subagentId);
      // 同一个子代理再点一次也要重拉（它可能又跑了新步骤）：令牌变 → 面板重读
      setToken(entry.token);
    }
    // eslint 式的「依赖不全」在此是有意的：`entry` 的其余字段都随 `nonce` 一起换。
  }, [entry.nonce]);

  const current = fileOf(path);
  const revision: ViewFileChange | null =
    (revisionId === null
      ? current?.history[0]
      : current?.history.find((item) => item.id === revisionId)) ?? current?.history[0] ?? null;
  /** 选中的是「累计」那一档吗——它不是某一次改动，故与 `revision` 互斥 */
  const netSelected = revisionId === NET_REVISION && (current?.history.length ?? 0) > 1;
  /** 当前文件的净值（给「累计」档用）；算不出为 null，那时由主进程回一句可读的原因 */
  const netOfCurrent =
    current !== undefined && current.netAddedLines !== null && current.netRemovedLines !== null
      ? { added: current.netAddedLines, removed: current.netRemovedLines }
      : null;

  const goList = (): void => {
    setLayer("list");
    setRevisionId(null);
  };
  const goDiff = (target: string, revision?: string): void => {
    setPath(target);
    setRevisionId(revision ?? null);
    setLayer("diff");
  };
  const goContent = (target: string): void => {
    setPath(target);
    setLayer("content");
  };
  /**
   * 上一级。**跳过没有内容的层**：④ 点进来的文件若压根没被改过，就没有它的 diff，
   * 「返回」应该直接回「任务摘要」，而不是落在一个空清单上。
   */
  const goUp = (): void => {
    // 子代理流是**并排的另一种目标**，不是改动这条线的某一层：回退直接回「任务摘要」
    if (layer === "subagent") {
      onExit();
      return;
    }
    if (layer === "content" && current !== undefined && current.history.length > 0) {
      goDiff(current.path, current.history[0]?.id);
      return;
    }
    if (layer === "list") {
      onExit();
      return;
    }
    if (current !== undefined) {
      goList();
      return;
    }
    onExit();
  };

  // ESC 逐层回退。三条守卫：不在输入框里（打字时按 ESC 不该把右栏拽走）、
  // 菜单没开（那一枚 ESC 归菜单）、层深 > 清单层由 goUp 自己处理（清单层再退才离开下钻）。
  useEffect(() => {
    if (menuOpen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      goUp();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  });

  const inList = layer === "list";
  const inSubagent = layer === "subagent";
  const subagent =
    inSubagent && subagentId !== null
      ? subagents.find((item) => item.id === subagentId)
      : undefined;
  // 子代理流是另一条线，不显示「本次改动」那一段面包屑
  const showChangeCrumb =
    !inSubagent && (inList || (current !== undefined && current.history.length > 0));

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col" data-drill={layer}>
      {/* 面包屑：只列**真实存在**的层（没被改过的文件没有「本次改动」这一层） */}
      <nav className="flex h-[var(--h-panel-head)] shrink-0 items-center gap-0.5 border-b border-line px-1.5">
        <CrumbButton marker="follow" label="任务摘要" onClick={onExit} />
        {inSubagent && (
          <>
            <ChevronRight {...ICON.xs} className="shrink-0 text-text-muted" />
            <span
              data-drill-crumb="subagent"
              className="flex min-w-0 items-center gap-1 px-1 text-xs font-medium text-text-primary"
              title={subagent?.title}
            >
              <Bot {...ICON.xs} className="shrink-0 text-text-muted" />
              <span className="truncate">子代理 · {subagent?.name ?? subagentId}</span>
            </span>
          </>
        )}
        {showChangeCrumb && (
          <>
            <ChevronRight {...ICON.xs} className="shrink-0 text-text-muted" />
            {inList ? (
              <span className="shrink-0 px-1 text-xs font-medium text-text-primary">
                本次改动
              </span>
            ) : (
              <button
                type="button"
                data-drill-crumb="list"
                onClick={goList}
                className="shrink-0 rounded-xs px-1 py-0.5 text-xs text-text-muted transition hover:bg-surface-overlay hover:text-text-primary"
              >
                本次改动
              </button>
            )}
          </>
        )}
        {!inList && !inSubagent && path !== null && (
          <>
            <ChevronRight {...ICON.xs} className="shrink-0 text-text-muted" />
            <span
              data-drill-crumb="current"
              className="min-w-0 truncate px-1 font-mono text-xs text-text-primary"
              title={path}
            >
              {path}
            </span>
          </>
        )}
        <span className="flex-1" />
        {inList && (
          <span
            title="「处」是改动次数、「文件」是按路径去重后的文件数；+a −b 是净值（改动前 → 现在）"
            className="shrink-0 pl-1 font-mono text-2xs text-text-secondary"
          >
            <span className="font-semibold text-text-primary">{list.places}</span> 处 ·{" "}
            <span className="font-semibold text-text-primary">{list.fileCount}</span> 文件
            {list.netAddedLines > 0 && (
              <span className="ml-1.5 text-success-fg">+{list.netAddedLines}</span>
            )}
            {list.netRemovedLines > 0 && (
              <span className="ml-1 text-danger-fg">−{list.netRemovedLines}</span>
            )}
          </span>
        )}
      </nav>

      {inList ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5" data-clist="">
          {list.groups.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs leading-relaxed text-text-muted">
              本次还没有改动文件。
            </p>
          ) : (
            list.groups.map((group) => (
              <div key={group.dir} className="mb-2">
                {/* 目录只是一行**弱标签**：保留归属，但不额外消耗一次点击 */}
                <div
                  data-clist-dir={group.dir}
                  className="flex items-baseline gap-2 px-1.5 py-1 text-2xs text-text-muted"
                >
                  <Folder {...ICON.xs} className="shrink-0 self-center" />
                  <span className="truncate font-mono" title={group.dir}>
                    {group.dir === "" ? "（项目根）" : `${group.dir}/`}
                  </span>
                  <span className="flex-1" />
                  <span className="shrink-0">{group.files.length} 文件</span>
                </div>

                {group.files.map((file) => {
                  const isExpanded = expanded.has(file.path);
                  const many = file.history.length > 1;
                  return (
                    <div key={file.path}>
                      <button
                        type="button"
                        data-clist-file={file.path}
                        onClick={() =>
                          many
                            ? setExpanded((prev) => {
                                const next = new Set(prev);
                                if (next.has(file.path)) next.delete(file.path);
                                else next.add(file.path);
                                return next;
                              })
                            : goDiff(file.path)
                        }
                        title={many ? `展开 / 收起 ${file.path} 的历史` : `查看 ${file.path} 的 diff`}
                        className={cn(
                          "group flex w-full items-center gap-1.5 rounded-sm px-1.5 py-1.5 text-left transition hover:bg-surface-overlay",
                          samePath(file.path, highlightPath ?? null) && "bg-surface-overlay",
                        )}
                      >
                        {many ? (
                          <ChevronRight
                            {...ICON.sm}
                            className={cn(
                              "shrink-0 text-text-muted transition-transform",
                              isExpanded && "rotate-90",
                            )}
                          />
                        ) : (
                          <ChevronRight
                            {...ICON.xs}
                            className="shrink-0 text-text-muted opacity-0 transition group-hover:opacity-100"
                          />
                        )}
                        <FileDiff {...ICON.sm} className="shrink-0 text-text-muted" />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate font-mono text-xs text-text-primary">
                            {file.name}
                          </span>
                          <span className="truncate text-2xs text-text-muted">
                            {many && <span className="text-text-secondary">×{file.history.length} </span>}
                            {file.kind === "write" ? "新建" : "编辑"} · {formatAgo(file.latestAt)}
                          </span>
                        </span>
                        {/* `+a −b` 全应用**只在这里**出现一次（⑦-G：此前被渲染了三遍）。
                            给的是**净值**：改完又退回原样就是 0，此时明说「已还原」——
                            把逐次相加的 +10 −10 摆出来，等于告诉用户文件变了，是错的。 */}
                        <span
                          data-clist-net-value={file.path}
                          title={netTitle(file)}
                          className="shrink-0 font-mono text-2xs"
                        >
                          <NetNumbers added={file.netAddedLines} removed={file.netRemovedLines} />
                        </span>
                      </button>

                      {many && isExpanded && (
                        <div className="mb-1 ml-[26px] border-l border-line pl-2">
                          {/* 这一行是「这些改动加起来是什么」——逐次行说的是「每一次改了什么」，
                              两者不可互相顶替，故都摆在同一个展开区里，位置说明身份。 */}
                          <button
                            type="button"
                            data-clist-net={file.path}
                            onClick={() => goDiff(file.path, NET_REVISION)}
                            title="本次会话的累计改动（改动前 → 现在）"
                            className="flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left transition hover:bg-surface-overlay"
                          >
                            <span className="min-w-0 flex-1 truncate text-2xs text-text-secondary">
                              全部改动（累计）
                            </span>
                            <span
                              data-clist-net-row-value={file.path}
                              className="shrink-0 font-mono text-2xs"
                            >
                              {file.netAddedLines === null || file.netRemovedLines === null ? (
                                <span className="text-text-muted">—</span>
                              ) : (
                                <NetNumbers
                                  added={file.netAddedLines}
                                  removed={file.netRemovedLines}
                                />
                              )}
                            </span>
                          </button>
                          {file.history.map((rev, index) => (
                            <button
                              key={rev.id}
                              type="button"
                              data-clist-rev={rev.id}
                              onClick={() => goDiff(file.path, rev.id)}
                              className="flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left transition hover:bg-surface-overlay"
                            >
                              <span className="shrink-0 font-mono text-2xs text-text-secondary">
                                #{file.history.length - index}
                              </span>
                              <span className="min-w-0 flex-1 truncate text-2xs text-text-muted">
                                {formatAgo(rev.timestamp)}
                              </span>
                              <span className="shrink-0 font-mono text-2xs">
                                {rev.addedLines > 0 && (
                                  <span className="text-success-fg">+{rev.addedLines}</span>
                                )}
                                {rev.removedLines > 0 && (
                                  <span className="ml-1 text-danger-fg">−{rev.removedLines}</span>
                                )}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))
          )}

          {/* 越界条目在这里就被挡掉，但**必须如实说明**——静默丢数据比不显示更可疑 */}
          {list.hidden > 0 && (
            <div
              data-clist-hidden={list.hidden}
              className="px-1.5 py-1.5 text-2xs leading-relaxed text-text-muted"
            >
              已隐藏 {list.hidden} 个项目外文件（不在项目根内，无法预览）
            </div>
          )}

          {/* 净值算不出的文件同样是「少了一块」，理由要跟着数字一起说清楚 */}
          {list.netUnknown > 0 && (
            <div
              data-clist-net-unknown={list.netUnknown}
              className="px-1.5 py-1.5 text-2xs leading-relaxed text-text-muted"
            >
              {list.netUnknown} 个文件未记录改动前的内容（过大 / 二进制 / 读取失败），未计入净值
            </div>
          )}
        </div>
      ) : inSubagent ? (
        /* 子代理的完整过程流：视图里只有有界尾部，这里按需拉整份（决策七 D9） */
        <div className="min-h-0 flex-1 overflow-auto" data-drill-subagent={subagentId ?? ""}>
          {subagentId === null ? (
            <p className="px-3 py-6 text-center text-xs text-text-muted">没有选中的子代理。</p>
          ) : (
            <SubagentStream
              sessionId={sessionId}
              subagentId={subagentId}
              reloadToken={token}
              // 视图里那份（实时通道）：运行中由它渲染，跑完才去拉完整流（见 SubagentStream）
              subagent={subagents.find((item) => item.id === subagentId)}
            />
          )}
        </div>
      ) : layer === "diff" ? (
        <div className="flex min-h-0 flex-1 flex-col" data-drill-diff="">
          <div className="flex h-[var(--h-panel-head)] shrink-0 items-center gap-2 border-b border-line px-2.5">
            <span className="truncate font-mono text-xs text-text-secondary" title={path ?? ""}>
              {path}
            </span>
            {/* 同一文件改过多次时给历史切换；只有一次就不给（一个选项的开关是噪声）。
                「累计」与 `#N` 并列：前者说「加起来的结果」，后者说「第几次」。 */}
            {current !== undefined && current.history.length > 1 && (
              <span className="ml-auto flex shrink-0 items-center gap-0.5 rounded-sm border border-line p-0.5">
                <button
                  type="button"
                  data-drill-rev={NET_REVISION}
                  onClick={() => setRevisionId(NET_REVISION)}
                  title="本次会话的累计改动（改动前 → 现在）"
                  className={cn(
                    "rounded-xs px-1.5 py-0.5 text-2xs transition",
                    netSelected
                      ? "bg-accent-soft font-semibold text-text-primary"
                      : "text-text-muted hover:text-text-primary",
                  )}
                >
                  累计
                </button>
                {current.history.map((rev, index) => (
                  <button
                    key={rev.id}
                    type="button"
                    data-drill-rev={rev.id}
                    onClick={() => setRevisionId(rev.id)}
                    title={formatAgo(rev.timestamp)}
                    className={cn(
                      "rounded-xs px-1.5 py-0.5 text-2xs transition",
                      !netSelected && rev.id === revision?.id
                        ? "bg-accent-soft font-semibold text-text-primary"
                        : "text-text-muted hover:text-text-primary",
                    )}
                  >
                    #{current.history.length - index}
                    {index === 0 && " 最新"}
                  </button>
                ))}
              </span>
            )}
            <button
              type="button"
              data-drill-content=""
              onClick={() => path !== null && goContent(path)}
              className={cn(
                "flex shrink-0 items-center gap-1 rounded-sm border border-line px-1.5 py-1 text-2xs text-text-muted transition hover:bg-surface-overlay hover:text-text-primary",
                !(current !== undefined && current.history.length > 1) && "ml-auto",
              )}
            >
              <FileText {...ICON.xs} />
              看文件
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-2">
            {netSelected ? (
              <NetDiff sessionId={sessionId} path={path ?? ""} net={netOfCurrent} />
            ) : revision?.patch ? (
              <DiffView patch={revision.patch} />
            ) : (
              <p className="px-2 py-6 text-center text-xs leading-relaxed text-text-muted">
                {revision
                  ? "该改动由 write 工具整文件写入，内核未提供 diff。点右上「看文件」看结果。"
                  : "这次改动没有可显示的 diff。"}
              </p>
            )}
          </div>
        </div>
      ) : path === null ? (
        // 进到内容层却没有目标：只可能是状态被清空，给一句说明而不是白屏
        <p className="px-3 py-6 text-center text-xs text-text-muted">
          没有选中的文件。
        </p>
      ) : (
        <FilePreview
          sessionId={sessionId}
          path={path}
          reloadToken={token}
          onReload={() => setToken((value) => value + 1)}
        />
      )}

      <BackRow
        label={
          inList || inSubagent
            ? "返回「任务摘要」"
            : layer === "diff"
              ? "返回清单"
              : "返回上一级"
        }
        onClick={goUp}
      />
    </div>
  );
}
