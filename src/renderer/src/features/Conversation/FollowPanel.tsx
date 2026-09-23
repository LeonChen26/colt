// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 右栏工作区的「任务摘要」视图（默认视图，规则 ⑦-E；v1.48 由「正在处理」更名）。
 *
 * 规则 ⑦-G：本视图构成**几段互不重复的结论**（顺序即阅读顺序）——
 *   1. 本次用量（过去 / 累计，v1.61 新增；**v1.67 置顶**）：费用 + 输入 / 输出 tokens 的**结论**，
 *      数据直接取 `view.stats`（**零 IPC、随会话实时**）；**没有用量时整段不渲染**
 *      （摆一个「$0.0000」的空壳与摆一个空清单一样没有意义）。
 *      它只给结论，**流水仍在「统计」页签**（按模型 / 工具排行 / 可筛明细）——
 *      ⑦-H：附属视图给结论不给流水；这里那行「查看完整统计」就是去流水层的唯一出口。
 *      加这一段是因为另两段**都可能为空**，只剩一行「0 处 · 0 文件」的面板太空。
 *      **置顶的理由**：它是三段里**唯一带钱**的结论（花销比进度更早被关心），也是
 *      最容易被满足的一段——没有消耗就整段消失，不留空壳。
 *   2. 计划（将来）：待办清单，`N/M` 进度 + 进行中那条（带 `activeForm`）+ 待做；
 *      **已完成折成一行**，点开才铺开。没有清单时**整段不渲染**（不占位）——
 *      「没有清单」与「有清单但此刻空闲」是两件事，前者不该在界面上留一个空壳。
 *      清单**不设自己的滚动上限**：它多长就多长，超出面板高度由**本视图整体**滚动，
 *      绝不在半截处截断（曾写死 `max-h-[45%]`，清单略多就只在自己那一小块里滚）。
 *   3. 本次改动（过去 / 累计）：**紧跟计划**（本视图最后一段）的一行常驻总账
 *      「N 处 · M 文件」，点它进入清单。
 *      `+a −b` 是**净值**（基线 → 现在，与清单层同源）：改完又退回原样就是 0，
 *      故这里不给「干了多少下」的错觉——「处 / 文件」两个数说明干过活，净值说明结果。
 *      它不是可折叠区段（没有 caret / 展开态 / 空态）。
 *
 * 「此刻在跑什么」**不在本视图**（v1.53 删去「进行中的动作」段）：④ 消息流里已有运行中
 * 工具卡（含输出 / diff / 截图）与子代理卡，那是叙事的真源；本视图再列一遍只是把同一批
 * `runningTools` 画第二遍，还因为它当时是 `flex-1`，会把剩余高度全吃掉——清单被挤进
 * `max-h`、总账被顶到面板最下沿。「它是活的吗」由 ⑥ 状态栏（运行中 / 已中断 / 已失败 /
 * 空闲）回答，不必在本视图再占一块；子代理的「中止」挪到 ④ 子代理卡（`ToolCard`）上。
 *
 * 由 WorkspaceDock 提供页签与边框，本组件只负责内容，故根节点是撑满的 div 而非 aside。
 * 数据全部来自 ConversationView，无需额外 IPC（清单也是——它就在 `view.todos` 里）。
 *
 * ⚠️ 落地进度（⑦-G 的五项改动见 `UI-REGIONS` 规则 ⑦-G）：①（段二降级为总账）、
 * ②（段一不再列已完成文件）、③（改动 / 文件页签合并为下钻）、④（清单层）均已落地，
 * 总账的出口是下钻的**清单层**（`ChangeDrilldown`）；
 * ⑤（越界过滤扩到所有可点入口）由 `lib/change-list.ts` 的 `isProjectRelative` 统一保证，
 * 故本文件里的**文件行**不再各自可点——可点入口只剩一处：总账那一行
 * （`onOpenChanges` → 下钻的清单层）。路径的越界过滤仍在 `buildChangeList` 里统一做。
 */
import { useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, Circle, FileDiff } from "lucide-react";
import { ICON } from "@/lib/icon";
import { buildChangeList } from "@/lib/change-list";
import { formatTokenCount } from "@/lib/session-stats";
import { blockedTodoIds, summarizeTodoProgress, type ViewTodo } from "@shared/todo";
import type { ConversationView } from "@shared/worker-protocol";
import { cn } from "../../lib/utils";

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
      className="flex h-[var(--h-panel-head)] w-full shrink-0 items-center gap-1.5 px-3.5 text-left text-xs font-semibold uppercase tracking-[.5px] text-text-muted transition hover:text-text-secondary"
    >
      <ChevronDown
        {...ICON.xs}
        className={cn("shrink-0 transition-transform", collapsed && "-rotate-90")}
      />
      <span className="truncate">{title}</span>
      {meta !== undefined && (
        <span className="ml-auto shrink-0 text-2xs font-medium normal-case tracking-normal text-text-muted">
          {meta}
        </span>
      )}
    </button>
  );
}

/** 用量格：小标签 + 等宽数值（比 `UsagePanel` 的 Kpi 小一号——它只占任务摘要里的一段） */
function UsageStat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="rounded-sm border border-line bg-surface px-2 py-1.5">
      <div className="text-2xs text-text-muted">{label}</div>
      <div className="mt-0.5 font-mono text-sm font-semibold text-text-primary">{value}</div>
    </div>
  );
}

export function FollowPanel({
  view,
  onOpenChanges,
  onOpenStats,
}: {
  view: ConversationView | null;
  /** 点总账 → 进入下钻的**清单层**（⑦-G） */
  onOpenChanges: () => void;
  /** 点「本次用量」的出口 → 打开**「统计」页签**（流水在那边，⑦-H） */
  onOpenStats: () => void;
}): React.JSX.Element {
  const [planCollapsed, setPlanCollapsed] = useState(false);
  /** 「已完成」默认折成一行，点开才铺开（⑦-H：给结论不给流水） */
  const [doneOpen, setDoneOpen] = useState(false);
  /** 用量段同样可折；默认展开——这段本来就是用来补「面板太空」的 */
  const [usageCollapsed, setUsageCollapsed] = useState(false);
  const changes = view?.fileChanges ?? [];
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
      className="rounded-sm px-2 py-1"
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
            "min-w-0 flex-1 truncate text-xs",
            todo.status === "completed" ? "text-text-muted" : "text-text-secondary",
          )}
        >
          {todo.status === "in_progress" && todo.activeForm !== "" ? todo.activeForm : todo.subject}
        </span>
      </div>
      {blocked.has(todo.id) && (
        <div className="truncate pl-3.5 text-2xs text-text-muted">
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
  /**
   * 用量（v1.61）：数据来自 `view.stats`——视图自带、**零 IPC**、随会话实时。
   * **没有任何消耗时整段不渲染**：一段全是 0 的用量块和一个空清单一样，是纯噪声。
   */
  const usage = view?.stats;
  const hasUsage = usage !== undefined && (usage.costUsd > 0 || usage.totalTokens > 0);

  return (
    // 本视图整体滚动（而不是给清单一个自己的滚动盒）：清单必须能完整铺开，
    // 总账**紧跟**在它下面（不再被一个吃高度的中间段顶到面板最下沿）。
    <div className="flex min-h-0 w-full flex-1 flex-col overflow-y-auto">
      {/* 段一：本次用量（v1.61 新增；v1.67 置顶）——结论（费用 / tokens）留在这里，
          流水留在「统计」页签。没有消耗时整段不渲染（`hasUsage`）。 */}
      {usage !== undefined && hasUsage && (
        <section data-usage-section="" className="flex shrink-0 flex-col border-b border-line">
          <SectionHead
            title="本次用量"
            meta={<span data-usage-cost="">${usage.costUsd.toFixed(4)}</span>}
            collapsed={usageCollapsed}
            onToggle={() => setUsageCollapsed((value) => !value)}
          />
          {!usageCollapsed && (
            <div className="px-3.5 pb-2.5">
              <div className="grid grid-cols-2 gap-2">
                <UsageStat label="输入" value={formatTokenCount(usage.inputTokens)} />
                <UsageStat label="输出" value={formatTokenCount(usage.outputTokens)} />
              </div>
              <button
                type="button"
                data-usage-open=""
                onClick={onOpenStats}
                title="打开「统计」页签：按模型 / 工具排行 / 可筛明细"
                className="mt-2 flex items-center gap-1 text-xs text-text-muted transition hover:text-text-primary"
              >
                查看完整统计
                <ChevronRight {...ICON.xs} />
              </button>
            </div>
          )}
        </section>
      )}

      {/* 段二：计划（将来）——v1.48 新增。**没有清单时整段不渲染**（不占位）：
          那是「模型还没拆解」，不是「有清单但空着」，留个空壳只会让人以为坏了。 */}
      {todos.length > 0 && (
        <section data-todo-section="" className="flex shrink-0 flex-col border-b border-line">
          <SectionHead
            title="计划"
            meta={<span data-todo-progress="">{`${plan.done}/${plan.total}`}</span>}
            collapsed={planCollapsed}
            onToggle={() => setPlanCollapsed((value) => !value)}
          />
          {!planCollapsed && (
            <div className="px-2 pb-1.5">
              {activeTodos.map(renderTodo)}
              {doneTodos.length > 0 && (
                <button
                  type="button"
                  data-todo-done-toggle=""
                  onClick={() => setDoneOpen((value) => !value)}
                  className="flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-left text-xs text-text-muted transition hover:text-text-secondary"
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

      {/* 段三：本次改动（总账，⑦-G）——一行常驻状态，**紧跟计划**（本视图最后一段），
          不是区段（没有 caret / 展开态 / 空态）。「空」时它仍在，只是数字为 0 且**不给出口**
          ——一个点了没反应的按钮就是死控件。 */}
      {places === 0 ? (
        <div
          data-follow-ledger=""
          className="flex w-full shrink-0 items-center gap-2 bg-surface px-3 py-2"
        >
          <FileDiff {...ICON.sm} className="shrink-0 text-text-muted" />
          <span className="shrink-0 text-xs font-semibold uppercase tracking-[.5px] text-text-muted">
            本次改动
          </span>
          <span className="min-w-0 flex-1 truncate text-xs text-text-muted">0 处 · 0 文件</span>
        </div>
      ) : (
        <button
          type="button"
          data-follow-ledger=""
          onClick={onOpenChanges}
          title="本次会话的文件改动（+a −b 为净值：改动前 → 现在）"
          className="group flex w-full shrink-0 items-center gap-2 bg-surface px-3 py-2 text-left transition hover:bg-surface-overlay"
        >
          <FileDiff {...ICON.sm} className="shrink-0 text-text-muted" />
          <span className="shrink-0 text-xs font-semibold uppercase tracking-[.5px] text-text-muted">
            本次改动
          </span>
          <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">
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
          <span className="flex shrink-0 items-center gap-1 text-xs text-text-muted transition group-hover:text-text-primary">
            查看全部
            <ChevronRight {...ICON.xs} />
          </span>
        </button>
      )}
    </div>
  );
}
