/**
 * 「正在处理」的下钻（规则 ⑦-G）：**清单 → diff → 内容**，一个东西的连续下钻。
 *
 * 它取代了原先并列的两个页签（「改动」`ChangesPanel` + 「文件」`FilePanel`）——
 * 用户不需要知道「该去改动页签还是文件页签」，只需要知道「想看得更细」
 * （概念稿 `prototype-follow-merged-hifi.html` 的页签行只剩 正在处理 / 浏览器 / 统计 / 规则）。
 *
 * 层与进入方式：
 *   - `list`（清单层）：总账点进来。按目录一层分组、同文件多次编辑折成 `×N`、
 *     `+a −b` **只在这里出现一次**；点文件卡（或它的历史行）→ `diff`
 *   - `diff`：该次改动的 patch，可在历史之间切换，「看文件」→ `content`
 *   - `content`：文件本身（`FilePreview`）。**④ 点文件路径直接落这一层**
 *     （原 A3-2 的入口，行为等价，只是不再切页签）
 *
 * 逐层回退有三条出口：面包屑、各层底部那一行「返回」、ESC。
 * **层状态由本组件持有**（容器只管「在不在下钻」，见 `WorkspaceDock`）：
 * 层内跳转不该绕一圈回到容器再下来。
 */
import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, FileDiff, FileText, Folder, Undo2 } from "lucide-react";
import { ICON } from "@/lib/icon";
import { buildChangeList, type ChangeFile } from "@/lib/change-list";
import { formatAgo, samePath } from "@/lib/format";
import { cn } from "@/lib/utils";
import { DiffView } from "../../../components/DiffView";
import type { ViewFileChange } from "@shared/worker-protocol";
import { FilePreview } from "./FilePreview";

/** 容器发来的「进入下钻」请求。每次都是新对象，故 `useEffect` 的依赖判定永远生效 */
export type DrillEntry =
  | { layer: "list" }
  | { layer: "content"; path: string; token: number };

type DrillLayer = "list" | "diff" | "content";

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
      className="flex shrink-0 items-center gap-1 rounded-[4px] px-1 py-0.5 text-[11px] text-text-muted transition hover:bg-surface-overlay hover:text-text-primary"
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
      <span className="text-[11.5px] text-text-secondary">{label}</span>
      <span className="ml-auto shrink-0 text-[11px] text-text-muted transition group-hover:text-text-primary">
        {hint ?? "ESC"}
      </span>
    </button>
  );
}

export function ChangeDrilldown({
  sessionId,
  changes,
  entry,
  highlightPath,
  menuOpen,
  onExit,
}: {
  sessionId: string;
  changes: ViewFileChange[];
  /** 容器发来的进入请求（点总账 = 清单层；点路径 = 内容层） */
  entry: DrillEntry;
  /** hover ④ 的工具卡时跟随高亮清单里对应的文件行（⑦-A 的现场联动） */
  highlightPath?: string | null;
  /** 「+」菜单开着时不接管 ESC——一次按键只该做一件事 */
  menuOpen: boolean;
  /** 回到「正在处理」（面包屑第一段 / 清单层底部的返回） */
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
  const [revisionId, setRevisionId] = useState<string | null>(null);
  /** `×N` 展开了历史的那几个文件 */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  /** 内容层的重读令牌：换文件时靠 `path` 变，重读同一文件靠它自增 */
  const [token, setToken] = useState(entry.layer === "content" ? entry.token : 0);

  // 容器再次发来请求（④ 又点了一个路径 / 又点了总账）→ 按请求重置层
  useEffect(() => {
    setLayer(entry.layer);
    setRevisionId(null);
    if (entry.layer === "content") {
      setPath(entry.path);
      setToken(entry.token);
    }
  }, [entry]);

  const current = fileOf(path);
  const revision: ViewFileChange | null =
    (revisionId === null
      ? current?.history[0]
      : current?.history.find((item) => item.id === revisionId)) ?? current?.history[0] ?? null;

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
   * 「返回」应该直接回「正在处理」，而不是落在一个空清单上。
   */
  const goUp = (): void => {
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
  const showChangeCrumb = inList || (current !== undefined && current.history.length > 0);

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col" data-drill={layer}>
      {/* 面包屑：只列**真实存在**的层（没被改过的文件没有「本次改动」这一层） */}
      <nav className="flex h-[30px] shrink-0 items-center gap-0.5 border-b border-line px-1.5">
        <CrumbButton marker="follow" label="正在处理" onClick={onExit} />
        {showChangeCrumb && (
          <>
            <ChevronRight {...ICON.xs} className="shrink-0 text-text-muted" />
            {inList ? (
              <span className="shrink-0 px-1 text-[11px] font-medium text-text-primary">
                本次改动
              </span>
            ) : (
              <button
                type="button"
                data-drill-crumb="list"
                onClick={goList}
                className="shrink-0 rounded-[4px] px-1 py-0.5 text-[11px] text-text-muted transition hover:bg-surface-overlay hover:text-text-primary"
              >
                本次改动
              </button>
            )}
          </>
        )}
        {!inList && path !== null && (
          <>
            <ChevronRight {...ICON.xs} className="shrink-0 text-text-muted" />
            <span
              data-drill-crumb="current"
              className="min-w-0 truncate px-1 font-mono text-[11px] text-text-primary"
              title={path}
            >
              {path}
            </span>
          </>
        )}
        <span className="flex-1" />
        {inList && (
          <span className="shrink-0 pl-1 font-mono text-[10.5px] text-text-secondary">
            <span className="font-semibold text-text-primary">{list.places}</span> 处 ·{" "}
            <span className="font-semibold text-text-primary">{list.fileCount}</span> 文件
            {list.addedLines > 0 && (
              <span className="ml-1.5 text-success-fg">+{list.addedLines}</span>
            )}
            {list.removedLines > 0 && (
              <span className="ml-1 text-danger-fg">−{list.removedLines}</span>
            )}
          </span>
        )}
      </nav>

      {inList ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5" data-clist="">
          {list.groups.length === 0 ? (
            <p className="px-2 py-6 text-center text-[11.5px] leading-relaxed text-text-muted">
              本次还没有改动文件。
            </p>
          ) : (
            list.groups.map((group) => (
              <div key={group.dir} className="mb-2">
                {/* 目录只是一行**弱标签**：保留归属，但不额外消耗一次点击 */}
                <div
                  data-clist-dir={group.dir}
                  className="flex items-baseline gap-2 px-1.5 py-1 text-[10.5px] text-text-muted"
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
                          "group flex w-full items-center gap-1.5 rounded-[6px] px-1.5 py-1.5 text-left transition hover:bg-surface-overlay",
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
                          <span className="truncate font-mono text-[11.5px] text-text-primary">
                            {file.name}
                          </span>
                          <span className="truncate text-[10.5px] text-text-muted">
                            {many && <span className="text-text-secondary">×{file.history.length} </span>}
                            {file.kind === "write" ? "新建" : "编辑"} · {formatAgo(file.latestAt)}
                          </span>
                        </span>
                        {/* `+a −b` 全应用**只在这里**出现一次（⑦-G：此前被渲染了三遍） */}
                        <span className="shrink-0 font-mono text-[10.5px]">
                          {file.addedLines > 0 && (
                            <span className="text-success-fg">+{file.addedLines}</span>
                          )}
                          {file.removedLines > 0 && (
                            <span className="ml-1 text-danger-fg">−{file.removedLines}</span>
                          )}
                        </span>
                      </button>

                      {many && isExpanded && (
                        <div className="mb-1 ml-[26px] border-l border-line pl-2">
                          {file.history.map((rev, index) => (
                            <button
                              key={rev.id}
                              type="button"
                              data-clist-rev={rev.id}
                              onClick={() => goDiff(file.path, rev.id)}
                              className="flex w-full items-center gap-2 rounded-[5px] px-1.5 py-1 text-left transition hover:bg-surface-overlay"
                            >
                              <span className="shrink-0 font-mono text-[10.5px] text-text-secondary">
                                #{file.history.length - index}
                              </span>
                              <span className="min-w-0 flex-1 truncate text-[10.5px] text-text-muted">
                                {formatAgo(rev.timestamp)}
                              </span>
                              <span className="shrink-0 font-mono text-[10.5px]">
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
              className="px-1.5 py-1.5 text-[10.5px] leading-relaxed text-text-muted"
            >
              已隐藏 {list.hidden} 个项目外文件（不在项目根内，无法预览）
            </div>
          )}
        </div>
      ) : layer === "diff" ? (
        <div className="flex min-h-0 flex-1 flex-col" data-drill-diff="">
          <div className="flex h-[30px] shrink-0 items-center gap-2 border-b border-line px-2.5">
            <span className="truncate font-mono text-[11px] text-text-secondary" title={path ?? ""}>
              {path}
            </span>
            {/* 同一文件改过多次时给历史切换；只有一次就不给（一个选项的开关是噪声） */}
            {current !== undefined && current.history.length > 1 && (
              <span className="ml-auto flex shrink-0 items-center gap-0.5 rounded-[5px] border border-line p-0.5">
                {current.history.map((rev, index) => (
                  <button
                    key={rev.id}
                    type="button"
                    data-drill-rev={rev.id}
                    onClick={() => setRevisionId(rev.id)}
                    title={formatAgo(rev.timestamp)}
                    className={cn(
                      "rounded-[4px] px-1.5 py-0.5 text-[10.5px] transition",
                      rev.id === revision?.id
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
                "flex shrink-0 items-center gap-1 rounded-[5px] border border-line px-1.5 py-1 text-[10.5px] text-text-muted transition hover:bg-surface-overlay hover:text-text-primary",
                !(current !== undefined && current.history.length > 1) && "ml-auto",
              )}
            >
              <FileText {...ICON.xs} />
              看文件
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-2">
            {revision?.patch ? (
              <DiffView patch={revision.patch} />
            ) : (
              <p className="px-2 py-6 text-center text-[11.5px] leading-relaxed text-text-muted">
                {revision
                  ? "该改动由 write 工具整文件写入，内核未提供 diff。点右上「看文件」看结果。"
                  : "这次改动没有可显示的 diff。"}
              </p>
            )}
          </div>
        </div>
      ) : path === null ? (
        // 进到内容层却没有目标：只可能是状态被清空，给一句说明而不是白屏
        <p className="px-3 py-6 text-center text-[11.5px] text-text-muted">
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
        label={inList ? "返回「正在处理」" : layer === "diff" ? "返回清单" : "返回上一级"}
        onClick={goUp}
      />
    </div>
  );
}
