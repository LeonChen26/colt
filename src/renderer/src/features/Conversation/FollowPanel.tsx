// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 右栏工作区的「任务摘要」视图（默认视图，规则 ⑦-E；v1.48 由「正在处理」更名）。
 *
 * 规则 ⑦-G：本视图**只由三段构成，三个时态、互不重复**（顺序即阅读顺序，v1.48 定）——
 *   1. 计划（将来）：待办清单，`N/M` 进度 + 进行中那条（带 `activeForm`）+ 待做；
 *      **已完成折成一行**，点开才铺开。没有清单时**整段不渲染**（不占位）——
 *      「没有清单」与「有清单但此刻空闲」是两件事，前者不该在界面上留一个空壳。
 *   2. 进行中的动作（此刻）：`runningTools` 逐条，**全应用唯一出处**。
 *      已完成的文件改动**不在这里重复列一遍**——它们的去处是总账 → 清单。
 *      理由：面板必须能显示「空」。若把已完成内容也常驻在此，它永远有内容，
 *      ⑦-E 那句「它是活的吗」就再也答不出来，而这是自用场景判断安全性的第一依据。
 *   3. 本次改动（过去 / 累计）：底部**一行常驻总账**「N 处 · M 文件」，点它进入清单。
 *      `+a −b` 是**净值**（基线 → 现在，与清单层同源）：改完又退回原样就是 0，
 *      故这里不给「干了多少下」的错觉——「处 / 文件」两个数说明干过活，净值说明结果。
 *      它不是可折叠区段（没有 caret / 展开态 / 空态），也不固定在右栏底部——
 *      它属于本视图，跟着出现、随切页签消失。
 *
 * 由 WorkspaceDock 提供页签与边框，本组件只负责内容，故根节点是撑满的 div 而非 aside。
 * 数据全部来自 ConversationView，无需额外 IPC（清单也是——它就在 `view.todos` 里）。
 *
 * ⚠️ 落地进度（⑦-G 的五项改动见 `UI-REGIONS` 规则 ⑦-G）：①（段二降级为总账）、
 * ②（段一不再列已完成文件）、③（改动 / 文件页签合并为下钻）、④（清单层）均已落地，
 * 总账的出口是下钻的**清单层**（`ChangeDrilldown`）；
 * ⑤（越界过滤扩到所有可点入口）由 `lib/change-list.ts` 的 `isProjectRelative` 统一保证，
 * 故本文件里的**文件行**不再各自可点——可点入口只剩一处：底部总账那一行
 * （`onOpenChanges` → 下钻的清单层）。路径的越界过滤仍在 `buildChangeList` 里统一做。
 *
 * hover 工具卡片时通过 highlightPath 跟随高亮**正在跑的那个动作**（⑦-A 的现场联动）。
 * 注：它原先高亮的是段一里的文件行，文件行按 ⑦-G 移除后，能对上的只剩「正在跑的同路径工具」；
 * 清单层里的文件行另有 `samePath` 高亮（见 `ChangeDrilldown`），两条联动各管各的层。
 */
import { useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, Circle, Clock, FileDiff } from "lucide-react";
import { ICON } from "@/lib/icon";
import { buildChangeList } from "@/lib/change-list";
import { formatAgo, samePath } from "@/lib/format";
import { blockedTodoIds, summarizeTodoProgress, type ViewTodo } from "@shared/todo";
import type { ConversationView } from "@shared/worker-protocol";
import { cn } from "../../lib/utils";

/** 从工具入参里取「它在干什么」的摘要（命令 / 路径），以及其中的路径（供跟随高亮用） */
function parseToolArgs(argsJson: string): { summary: string; path: string } {
  try {
    const parsed = JSON.parse(argsJson) as Record<string, unknown>;
    const command = typeof parsed.command === "string" ? parsed.command : undefined;
    const path = typeof parsed.path === "string" ? parsed.path : undefined;
    return { summary: command ?? path ?? "", path: path ?? "" };
  } catch {
    return { summary: "", path: "" };
  }
}

/** 可折叠分段头：caret + 标题 + 右侧元信息（对齐 .fsec-head） */
function SectionHead({
  title,
  meta,
  collapsed,
  onToggle,
}: {
  title: string;
  meta?: ReactNode;
  collapsed: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full shrink-0 items-center gap-1.5 px-3.5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[.6px] text-text-muted transition hover:text-text-secondary"
    >
      <ChevronDown
        {...ICON.xs}
        className={cn("shrink-0 transition-transform", collapsed && "-rotate-90")}
      />
      <span className="truncate">{title}</span>
      {meta !== undefined && (
        <span className="ml-auto shrink-0 text-[10.5px] font-medium normal-case tracking-normal text-text-muted">
          {meta}
        </span>
      )}
    </button>
  );
}

export function FollowPanel({
  view,
  highlightPath,
  onOpenChanges,
}: {
  view: ConversationView | null;
  highlightPath?: string | null;
  /** 点总账 → 进入下钻的**清单层**（⑦-G） */
  onOpenChanges: () => void;
}): React.JSX.Element {
  const [stepsCollapsed, setStepsCollapsed] = useState(false);
  const [planCollapsed, setPlanCollapsed] = useState(false);
  /** 「已完成」默认折成一行，点开才铺开（⑦-H：给结论不给流水） */
  const [doneOpen, setDoneOpen] = useState(false);
  const changes = view?.fileChanges ?? [];
  const runningTools = view?.runningTools ?? [];
  const todos = view?.todos ?? [];
  const plan = summarizeTodoProgress(todos);
  // 依赖未满足的条目要**看得出来**：它是在等，不是被忘了（判据与注入块同源）
  const blocked = blockedTodoIds(todos);
  const subjectOf = (id: string): string =>
    todos.find((item) => item.id === id)?.subject ?? id;
  const activeTodos = todos.filter((item) => item.status !== "completed");
  const doneTodos = todos.filter((item) => item.status === "completed");

  /** 计划的一条：字形 + 文字（进行中显示 `activeForm`）+ 未满足的依赖 */
  const renderTodo = (todo: ViewTodo): ReactNode => (
    <div
      key={todo.id}
      data-todo-id={todo.id}
      data-todo-status={todo.status}
      className="rounded-[6px] px-2 py-1"
    >
      <div className="flex items-start gap-1.5">
        <span data-todo-glyph={todo.status} className="mt-[3px] flex shrink-0 items-center">
          {todo.status === "completed" ? (
            <Check {...ICON.xs} className="text-success-fg" />
          ) : todo.status === "in_progress" ? (
            <span className="live-dot" />
          ) : (
            <Circle {...ICON.xs} className="text-text-muted" />
          )}
        </span>
        <span
          data-todo-subject=""
          title={todo.subject}
          className={cn(
            "min-w-0 flex-1 truncate text-[12px]",
            todo.status === "completed" ? "text-text-muted" : "text-text-secondary",
          )}
        >
          {todo.status === "in_progress" && todo.activeForm !== "" ? todo.activeForm : todo.subject}
        </span>
      </div>
      {blocked.has(todo.id) && (
        <div className="truncate pl-3.5 text-[10.5px] text-text-muted">
          等待：
          {todo.blockedBy
            .filter((id) => !doneTodos.some((item) => item.id === id))
            .map(subjectOf)
            .join("、")}
        </div>
      )}
    </div>
  );

  // 总账的两个口径（⑦-G）：**「处」是改动条数、「文件」是按路径去重后的文件数**。
  // 此前两处都叫「N 文件」却给出两个不同的数（段二写去重文件数、改动面板写条数），
  // 用户在同一屏看到「3 文件」与「7 处」无从理解——故两个数都必须显式命名。
  const places = changes.length;
  const fileCount = new Set(changes.map((change) => change.path)).size;
  // `+a −b` 是**净值**（基线 → 现在），与清单层的卡片、头部同一处算出（`buildChangeList`）——
  // 逐次相加会把「改了又退回去」读成实打实的改动，那正是总账最不该给的错觉。
  const net = buildChangeList(changes);
  const hasDiff = net.netAddedLines > 0 || net.netRemovedLines > 0;

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      {/* 段一：计划（将来）——v1.48 新增。**没有清单时整段不渲染**（不占位）：
          那是「模型还没拆解」，不是「有清单但空着」，留个空壳只会让人以为坏了。 */}
      {todos.length > 0 && (
        <section
          data-todo-section=""
          className="flex shrink-0 flex-col border-b border-line"
        >
          <SectionHead
            title="计划"
            meta={<span data-todo-progress="">{`${plan.done}/${plan.total}`}</span>}
            collapsed={planCollapsed}
            onToggle={() => setPlanCollapsed((value) => !value)}
          />
          {!planCollapsed && (
            <div className="max-h-[45%] overflow-y-auto px-2 pb-1.5">
              {activeTodos.map(renderTodo)}
              {doneTodos.length > 0 && (
                <button
                  type="button"
                  data-todo-done-toggle=""
                  onClick={() => setDoneOpen((value) => !value)}
                  className="flex w-full items-center gap-1.5 rounded-[6px] px-2 py-1 text-left text-[11px] text-text-muted transition hover:text-text-secondary"
                >
                  <ChevronRight
                    {...ICON.xs}
                    className={cn("shrink-0 transition-transform", doneOpen && "rotate-90")}
                  />
                  {doneOpen ? "收起已完成" : `已完成 ${plan.done} 项`}
                </button>
              )}
              {doneOpen && doneTodos.map(renderTodo)}
            </div>
          )}
        </section>
      )}

      {/* 段二：进行中的动作（此刻）——只放「此刻在跑」的，已完成的下沉到总账 → 清单 */}
      <section className="flex min-h-0 flex-1 flex-col">
        <SectionHead
          title="进行中的动作"
          meta={runningTools.length > 0 ? `${runningTools.length} 个动作进行中` : "空闲"}
          collapsed={stepsCollapsed}
          onToggle={() => setStepsCollapsed((value) => !value)}
        />
        {!stepsCollapsed &&
          (runningTools.length === 0 ? (
            /* 空态是⑦-E 的安全判断依据（「它是活的吗」），故它比内容更值得画清楚 */
            <div
              data-follow-empty=""
              className="flex min-h-0 flex-1 flex-col items-center gap-1 px-5 py-8 text-center"
            >
              <span className="mb-2 flex h-[34px] w-[34px] items-center justify-center rounded-full bg-surface-overlay text-text-muted">
                <Clock {...ICON.sm} />
              </span>
              <p className="text-[12.5px] text-text-secondary">会话空闲</p>
              <p className="max-w-[250px] text-[11.5px] leading-relaxed text-text-muted">
                Agent 没有正在进行的操作。它不再碰你的代码，可以放心离开。
              </p>
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-1.5">
              {runningTools.map((tool) => {
                const { summary, path } = parseToolArgs(tool.args);
                return (
                  <div
                    key={tool.id}
                    className={cn(
                      "rounded-[6px] px-2 py-1.5",
                      samePath(path, highlightPath ?? null) && "bg-surface-overlay",
                    )}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="live-dot shrink-0" />
                      <span className="truncate font-mono text-[11px] text-text-secondary">
                        {tool.name}
                      </span>
                      <span className="ml-auto shrink-0 text-[10.5px] text-text-muted">
                        {formatAgo(tool.startedAt)}
                      </span>
                    </div>
                    {summary.length > 0 && (
                      <div
                        title={summary}
                        className="truncate pl-3.5 font-mono text-[10.5px] text-text-muted"
                      >
                        {summary}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
      </section>

      {/* 总账（⑦-G）：一行常驻状态，不是区段（没有 caret / 展开态 / 空态）。
          「空」时它仍在，只是数字为 0 且**不给出口**——一个点了没反应的按钮就是死控件。 */}
      {places === 0 ? (
        <div
          data-follow-ledger=""
          className="flex w-full shrink-0 items-center gap-2 border-t border-line bg-surface px-3 py-2"
        >
          <FileDiff {...ICON.sm} className="shrink-0 text-text-muted" />
          <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[.4px] text-text-muted">
            本次改动
          </span>
          <span className="min-w-0 flex-1 truncate text-[12px] text-text-muted">0 处 · 0 文件</span>
        </div>
      ) : (
        <button
          type="button"
          data-follow-ledger=""
          onClick={onOpenChanges}
          title="本次会话的文件改动（+a −b 为净值：改动前 → 现在）"
          className="group flex w-full shrink-0 items-center gap-2 border-t border-line bg-surface px-3 py-2 text-left transition hover:bg-surface-overlay"
        >
          <FileDiff {...ICON.sm} className="shrink-0 text-text-muted" />
          <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[.4px] text-text-muted">
            本次改动
          </span>
          <span className="min-w-0 flex-1 truncate text-[12px] text-text-secondary">
            <span className="font-semibold text-text-primary">{places}</span> 处 ·{" "}
            <span className="font-semibold text-text-primary">{fileCount}</span> 文件
            {hasDiff && (
              <>
                {" "}
                <span className="text-success-fg">+{net.netAddedLines}</span>{" "}
                <span className="text-danger-fg">−{net.netRemovedLines}</span>
              </>
            )}
          </span>
          <span className="flex shrink-0 items-center gap-1 text-[11.5px] text-text-muted transition group-hover:text-text-primary">
            查看全部
            <ChevronRight {...ICON.xs} />
          </span>
        </button>
      )}
    </div>
  );
}
