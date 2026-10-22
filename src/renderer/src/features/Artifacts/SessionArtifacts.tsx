// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 单条会话的「查看产物」（PRD FR-06）：按该会话工作目录的**实际内容**列文件——
 * agent 用命令行写的、外部程序产出的都会出现。`recorded` 标注「这条会话的改动
 * 记录里有它」，不是产出清单的完整口径（没记到清单里的照样列出，只是不打标）。
 *
 * 这里**只做查看与打开**：不移动、不删除任何文件。根由主进程反查
 * （`artifact.listForSession` / `revealSession` 都只收 sessionId），渲染层给不了根。
 */
import { useCallback, useEffect, useState } from "react";
import { FolderOpen, RefreshCw } from "lucide-react";
import type { SessionInfo } from "@shared/protocol";
import { ICON } from "@/lib/icon";
import { ErrorNotice } from "../../components/ErrorNotice";

interface SessionArtifactList {
  root: string;
  kind: "default" | "workspace";
  locationName: string;
  readable: boolean;
  files: { path: string; size: number; mtime: number; recorded: boolean }[];
}

function formatStamp(value: number): string {
  if (!value) return "";
  const date = new Date(value);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

export function SessionArtifacts({
  session,
  onClose,
}: {
  session: SessionInfo;
  onClose: () => void;
}): React.JSX.Element {
  const [list, setList] = useState<SessionArtifactList | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setList(null);
    try {
      setList(await window.colt.invoke("artifact.listForSession", { sessionId: session.id }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [session.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = (file: string): void => {
    void window.colt
      .invoke("artifact.revealSession", { sessionId: session.id, file })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  };
  const reveal = (file: string): void => {
    void window.colt
      .invoke("artifact.revealSession", { sessionId: session.id, file, reveal: true })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2">
        <span className="text-sm font-semibold text-text-primary">会话产物</span>
        <span className="min-w-0 truncate text-xs text-text-muted" title={list?.root}>
          {list ? `${list.locationName} · ${list.root}` : session.title}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto shrink-0 rounded-sm border border-line px-2 py-1 text-xs text-text-secondary transition hover:border-line-strong hover:text-text-primary"
        >
          返回会话
        </button>
      </div>

      <div className="flex shrink-0 items-center justify-end gap-2 px-4 py-2">
        <span className="mr-auto text-2xs text-text-muted">
          点击打开文件；「本会话记录」= 该会话的改动记录里有它
        </span>
        <button
          type="button"
          onClick={() => void load()}
          data-session-artifacts-refresh
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
        {list === null ? (
          !error && <p className="py-6 text-center text-xs text-text-muted">读取会话工作目录…</p>
        ) : !list.readable ? (
          <p data-session-artifacts-empty className="py-6 text-center text-xs text-text-muted">
            工作目录当前不可读（可能已被移动或删除）
          </p>
        ) : list.files.length === 0 ? (
          <p data-session-artifacts-empty className="py-6 text-center text-xs text-text-muted">
            目录里还没有文件
          </p>
        ) : (
          list.files.map((file) => (
            <div
              key={file.path}
              data-session-artifact-file={file.path}
              className="flex items-center gap-2 rounded-xs px-1 py-1 transition hover:bg-surface-overlay"
            >
              <button
                type="button"
                onClick={() => open(file.path)}
                title="打开文件"
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-secondary">
                  {file.path}
                </span>
                {file.recorded && (
                  <span className="shrink-0 rounded-xs bg-surface-overlay px-1.5 py-0.5 text-2xs text-text-muted">
                    本会话记录
                  </span>
                )}
                <span className="shrink-0 text-2xs tabular-nums text-text-muted">
                  {file.size > 0 ? `${(file.size / 1024).toFixed(1)} KB` : ""}
                </span>
                <span className="w-24 shrink-0 text-right text-2xs tabular-nums text-text-muted">
                  {formatStamp(file.mtime)}
                </span>
              </button>
              <button
                type="button"
                onClick={() => reveal(file.path)}
                title="在文件夹中打开"
                aria-label={`在文件夹中打开 ${file.path}`}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-xs text-text-muted transition hover:bg-surface-overlay hover:text-text-primary"
              >
                <FolderOpen {...ICON.xs} />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
