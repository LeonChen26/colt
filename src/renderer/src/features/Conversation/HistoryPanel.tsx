// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 历史搜索浮层——从 ② 会话头唤起，贴在会话区上方。
 *
 * 曾经这里还带着「目录」（列出每条提问）；v1.45 起目录收成 ④ 左缘的**轮次点链**
 * （见 `TurnRail.tsx`），这里只留**按文字搜**：提问与回复都搜，
 * 点命中跳到那一轮，浮层收起、把位置让给正文。
 *
 * 为什么跳转**不复用** `session.navigate`（会话分支那条）：它点了会**分叉**，之后的提问
 * 落成新分支。搜索要的是**只读定位**——滚过去看一眼，会话本身一个字节都不动。
 * 点链与这里同走 `history.jumpTo`，语义一致。
 *
 * 数据全在渲染层：`messages` 是整份推过来的，窗口只限制**挂多少**、不限制**拿到多少**，
 * 所以这里既没有 IPC 也不碰 worker（算术见 `@/lib/session-outline`，有单测）。
 */
import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { ICON } from "../../lib/icon";
import { searchHistory } from "../../lib/session-outline";
import type { ViewMessage } from "@shared/worker-protocol";

/** 浮层里一次列出多少条命中；超出的在底部**如实计数**，不再静默截断（D6） */
const VISIBLE_HITS = 50;

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
  // 纯函数不再默认截断（它拿不到总数就无从交代）；这里先全量匹配，再决定画多少、并说清还有多少
  const hits = useMemo(() => searchHistory(messages, query), [messages, query]);
  const shown = hits.slice(0, VISIBLE_HITS);

  /**
   * 关闭的两条出口（键盘 + 指针）都挂在 **document** 上。
   *
   * 为什么不是浮层 div 上的 `onKeyDown`：React 的合成事件只在「事件目标在浮层内」时
   * 才会冒泡到浮层——用户点过别处（焦点离开浮层）之后按 ESC 就再也关不掉；
   * 而浮层又没有「点外部关闭」，于是它成了只能靠那个「关闭」按钮关掉的东西。
   * 挂到 document 上与「+」菜单同一套契约（见 `WorkspaceDock` 的菜单）。
   *
   * 「点外部关闭」要**排除触发它的那枚按钮**（`data-panel-toggle`）：那枚按钮是 toggle，
   * 若 mousedown 先把它关掉、紧接着 click 又把它打开，用户看到的就是「点了没反应」。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    const onPointerDown = (event: MouseEvent): void => {
      const node = event.target;
      if (node instanceof Element && node.closest("[data-conv-history], [data-panel-toggle]") !== null) {
        return;
      }
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [onClose]);

  const rowClass =
    "flex w-full items-baseline gap-2 rounded-sm px-2 py-1.5 text-left transition hover:bg-surface-overlay";

  return (
    <div
      data-conv-history
      className="absolute right-4 top-2 z-30 flex max-h-[70%] w-[380px] flex-col overflow-hidden rounded-lg border border-line bg-surface-raised shadow-xl"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-2.5 py-2">
        <Search {...ICON.sm} className="shrink-0 text-text-muted" />
        <input
          data-conv-history-query
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜历史文字：提问与回复都搜，点命中跳到那一轮"
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-text-muted"
        />
        <button
          type="button"
          data-conv-history-close
          onClick={onClose}
          className="shrink-0 rounded-sm px-1.5 py-0.5 text-xs text-text-muted transition hover:bg-surface-overlay hover:text-text-primary"
        >
          关闭
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-1.5">
        {query.trim() === "" ? (
          <p className="px-2 py-3 text-xs text-text-muted">
            输入文字开始搜索；想按轮次跳转，用会话区左缘的点链
          </p>
        ) : hits.length === 0 ? (
          <p className="px-2 py-3 text-xs text-text-muted">没有匹配的历史文字</p>
        ) : (
          shown.map((hit) => (
            <button
              key={hit.id}
              type="button"
              data-conv-history-hit={hit.index}
              onClick={() => onJump(hit.index)}
              className={rowClass + " flex-col items-stretch gap-0.5"}
            >
              <span className="text-xs text-text-muted">
                {hit.role === "user" ? "你" : "Agent"}
              </span>
              <span className="text-sm text-text-secondary">{hit.snippet}</span>
            </button>
          ))
        )}
        {/* 命中多于一屏：说清总数（不静默截断——与清单层「已隐藏 N 个」同一套纪律） */}
        {hits.length > shown.length && (
          <p data-conv-history-more className="px-2 py-2 text-xs text-text-muted">
            共 {hits.length} 条命中，这里只列前 {VISIBLE_HITS} 条：继续输入可以缩小范围。
          </p>
        )}
      </div>
    </div>
  );
}
