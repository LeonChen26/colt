/**
 * 会话目录 / 历史搜索浮层——从 ② 会话头唤起，贴在会话区上方。
 *
 * 一个搜索框 + 两种结果：没输查询时列**你的每条提问**（目录），输了就列**命中的片段**
 * （提问与回复都搜）。点任一条 = 跳到那一轮，浮层收起、把位置让给正文。
 *
 * 为什么是浮层而不是右栏页签：⑦ 的禁止清单里第一条就是「会话叙事」（见 `docs/UI-REGIONS.md`），
 * 而目录与搜索正是关于会话叙事的导航；② 的定位才是「针对这个会话本身的操作」。
 *
 * 为什么跳转**不复用**左栏那个「会话分支」：那个走 `session.navigate`、点了会**分叉**
 * （界面自己写着「之后的对话形成新分支」）。目录要的是**只读定位**——滚过去看一眼，
 * 会话本身一个字节都不动。
 *
 * 数据全在渲染层：`messages` 是整份推过来的，窗口只限制**挂多少**、不限制**拿到多少**，
 * 所以这里既没有 IPC 也不碰 worker（算术见 `@/lib/session-outline`，有单测）。
 */
import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { ICON } from "../../lib/icon";
import { outlineOf, searchHistory } from "../../lib/session-outline";
import { cn } from "../../lib/utils";
import type { ViewMessage } from "@shared/worker-protocol";

export function HistoryPanel({
  messages,
  onJump,
  onClose,
}: {
  messages: ViewMessage[];
  onJump: (index: number) => void;
  onClose: () => void;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const items = useMemo(() => outlineOf(messages), [messages]);
  const hits = useMemo(() => searchHistory(messages, query), [messages, query]);
  const searching = query.trim() !== "";

  const rowClass =
    "flex w-full items-baseline gap-2 rounded-[6px] px-2 py-1.5 text-left transition hover:bg-surface-overlay";

  return (
    <div
      data-conv-history
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
      className="absolute right-4 top-2 z-30 flex max-h-[70%] w-[380px] flex-col overflow-hidden rounded-[10px] border border-line bg-surface-raised shadow-xl"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-2.5 py-2">
        <Search {...ICON.sm} className="shrink-0 text-text-muted" />
        <input
          data-conv-history-query
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={searching ? "搜历史文字…" : "搜历史文字，或从下面挑一轮"}
          className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-text-muted"
        />
        <button
          type="button"
          data-conv-history-close
          onClick={onClose}
          className="shrink-0 rounded-[5px] px-1.5 py-0.5 text-[11.5px] text-text-muted transition hover:bg-surface-overlay hover:text-text-primary"
        >
          关闭
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-1.5">
        {searching ? (
          hits.length === 0 ? (
            <p className="px-2 py-3 text-[12px] text-text-muted">没有匹配的历史文字</p>
          ) : (
            hits.map((hit) => (
              <button
                key={hit.id}
                type="button"
                data-conv-history-hit={hit.index}
                onClick={() => onJump(hit.index)}
                className={cn(rowClass, "flex-col items-stretch gap-0.5")}
              >
                <span className="text-[11px] text-text-muted">
                  {hit.role === "user" ? "你" : "Agent"}
                </span>
                <span className="text-[12.5px] text-text-secondary">{hit.snippet}</span>
              </button>
            ))
          )
        ) : items.length === 0 ? (
          <p className="px-2 py-3 text-[12px] text-text-muted">这个会话还没有提问</p>
        ) : (
          items.map((item) => (
            <button
              key={item.id}
              type="button"
              data-conv-history-item={item.index}
              onClick={() => onJump(item.index)}
              className={rowClass}
            >
              <span className="w-8 shrink-0 text-right text-[11px] text-text-muted">{item.turn}</span>
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-text-secondary">
                {item.label}
              </span>
            </button>
          ))
        )}
      </div>

      {!searching && items.length > 0 && (
        <div className="shrink-0 border-t border-line px-2.5 py-1.5 text-[11px] text-text-muted">
          共 {items.length} 轮 · 点一行跳到那一轮（只滚动，不改会话）
        </div>
      )}
    </div>
  );
}
