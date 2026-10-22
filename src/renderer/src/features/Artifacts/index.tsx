// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 默认空间的跨会话产物清单（PRD FR-02 / FR-06）。
 *
 * 按产物目录分组：正常、归档与已删除的会话都在——已删除会话的目录与文件仍然保留，
 * manifest 冻结了标题与文件列表，所以这里照常列出它，并标「会话已删除」。
 *
 * 清单口径以目录内容为准（由主进程读盘），因此 agent 用命令行写的、外部程序产出的文件
 * 都会出现。这里**只做查看与定位**：不移动、不删除任何文件（PRD 硬规则）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, FolderOpen, RefreshCw, Search } from "lucide-react";
import type { ArtifactGroup } from "@shared/protocol";
import { ICON } from "@/lib/icon";
import { cn } from "@/lib/utils";
import { ErrorNotice } from "../../components/ErrorNotice";

function formatStamp(value: number): string {
  if (!value) return "时间未知";
  const date = new Date(value);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

export function DefaultSpaceArtifacts({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [groups, setGroups] = useState<ArtifactGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  /** 收起的分组（按目录名）。默认全展开：产物清单就是要一眼看到「哪条会话产出了什么」 */
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const load = useCallback(async () => {
    try {
      const result = await window.colt.invoke("artifact.listDefaultSpace", undefined);
      setGroups(result.groups);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 在文件管理器里打开产物。失败必须看得见：目录已被外部删除、路径不合法时主进程会拒绝，
   * 静默吞掉就变成「点了没反应」。
   */
  const reveal = (dirName: string, file?: string): void => {
    void window.colt
      .invoke("artifact.reveal", file === undefined ? { dirName } : { dirName, file })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  };

  const keyword = query.trim().toLowerCase();
  /** 按标题或文件名过滤；只保留有命中的分组，不展示空组 */
  const visible = useMemo(() => {
    if (!groups) return null;
    if (!keyword) return groups;
    return groups
      .map((group) => {
        const titleHit = group.title.toLowerCase().includes(keyword);
        const files = group.files.filter((file) => file.path.toLowerCase().includes(keyword));
        return titleHit ? group : files.length > 0 ? { ...group, files } : null;
      })
      .filter((group): group is ArtifactGroup => group !== null);
  }, [groups, keyword]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2">
        <span className="text-sm font-semibold text-text-primary">产物</span>
        <span className="text-xs text-text-muted">
          默认空间 · 跨会话（含已删除会话，文件只读列出，不移动不删除）
        </span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto shrink-0 rounded-sm border border-line px-2 py-1 text-xs text-text-secondary transition hover:border-line-strong hover:text-text-primary"
        >
          返回会话
        </button>
      </div>

      <div className="flex shrink-0 items-center gap-2 px-4 py-2">
        <div className="relative min-w-0 flex-1">
          <Search
            {...ICON.xs}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-text-muted"
          />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            data-artifacts-search
            placeholder="按会话标题或文件名查找"
            aria-label="按会话标题或文件名查找产物"
            className="w-full rounded-sm border border-line bg-transparent py-1.5 pl-6 pr-2 text-xs text-text-primary outline-none transition placeholder:text-text-muted focus:border-line-strong"
          />
        </div>
        <button
          type="button"
          onClick={() => void load()}
          data-artifacts-refresh
          title="重新读目录（外部改动后手动刷新）"
          className="flex shrink-0 items-center gap-1 rounded-sm border border-line px-2 py-1.5 text-xs text-text-secondary transition hover:border-line-strong hover:text-text-primary"
        >
          <RefreshCw {...ICON.xs} />
          刷新
        </button>
      </div>

      {error && (
        <ErrorNotice message={error} onDismiss={() => setError(null)} className="mx-4 mb-2" />
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {visible === null ? (
          <p className="py-6 text-center text-xs text-text-muted">读取产物目录…</p>
        ) : visible.length === 0 ? (
          <p data-artifacts-empty className="py-6 text-center text-xs text-text-muted">
            {keyword ? `没有匹配「${query.trim()}」的产物` : "默认空间还没有产物目录"}
          </p>
        ) : (
          visible.map((group) => {
            const open = !collapsed.has(group.dirName);
            return (
              <div
                key={group.dirName}
                data-artifact-group={group.dirName}
                className="mb-2 rounded-md border border-line"
              >
                <div className="flex items-center gap-2 px-3 py-2">
                  <button
                    type="button"
                    onClick={() =>
                      setCollapsed((set) => {
                        const next = new Set(set);
                        if (next.has(group.dirName)) next.delete(group.dirName);
                        else next.add(group.dirName);
                        return next;
                      })
                    }
                    aria-expanded={open}
                    aria-label={open ? "收起" : "展开"}
                    className="flex h-4 w-4 shrink-0 items-center justify-center text-text-muted transition hover:text-text-primary"
                  >
                    <ChevronDown
                      {...ICON.xs}
                      className={cn("transition-transform", !open && "-rotate-90")}
                    />
                  </button>
                  <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
                    {group.title}
                  </span>
                  {group.deletedAt !== null && (
                    <span className="shrink-0 rounded-xs bg-surface-overlay px-1.5 py-0.5 text-2xs text-text-muted">
                      会话已删除
                    </span>
                  )}
                  {!group.readable && (
                    <span className="shrink-0 rounded-xs bg-warning-soft px-1.5 py-0.5 text-2xs text-warning-fg">
                      目录缺失
                    </span>
                  )}
                  <span className="shrink-0 text-2xs text-text-muted">
                    {formatStamp(group.createdAt)}
                  </span>
                  <button
                    type="button"
                    onClick={() => reveal(group.dirName)}
                    title="在文件夹中打开"
                    aria-label="在文件夹中打开"
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded-xs text-text-muted transition hover:bg-surface-overlay hover:text-text-primary"
                  >
                    <FolderOpen {...ICON.xs} />
                  </button>
                </div>
                {open && (
                  <div className="border-t border-line px-3 py-1.5">
                    {group.files.length === 0 ? (
                      <p className="py-1 text-xs text-text-muted">目录里还没有文件</p>
                    ) : (
                      group.files.map((file) =>
                        group.readable ? (
                          <button
                            key={file.path}
                            type="button"
                            onClick={() => reveal(group.dirName, file.path)}
                            title="在文件夹中打开"
                            className="flex w-full items-center gap-2 rounded-xs px-1 py-1 text-left transition hover:bg-surface-overlay"
                          >
                            <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-secondary">
                              {file.path}
                            </span>
                            <span className="shrink-0 text-2xs tabular-nums text-text-muted">
                              {file.size > 0 ? `${(file.size / 1024).toFixed(1)} KB` : ""}
                            </span>
                          </button>
                        ) : (
                          // 目录不可读：文件来自冻结快照，盘上定位不到。做成不可点的行——
                          // `shell.showItemInFolder` 对不存在的路径既不报错也无回调，
                          // 摆一个可点的入口就是「点了没反应」（AGENTS §3.6）
                          <div
                            key={file.path}
                            data-artifact-file-missing={file.path}
                            title="目录缺失，无法在文件夹中定位"
                            className="flex w-full items-center gap-2 px-1 py-1 opacity-60"
                          >
                            <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-secondary">
                              {file.path}
                            </span>
                            <span className="shrink-0 text-2xs tabular-nums text-text-muted">
                              {file.size > 0 ? `${(file.size / 1024).toFixed(1)} KB` : ""}
                            </span>
                          </div>
                        ),
                      )
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
