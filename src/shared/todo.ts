// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 待办清单（todo）的**契约与纯渲染**：main / worker / 渲染层三方共用同一份定义。
 *
 * 为什么单独一个模块而不是塞进 `worker-protocol.ts`：
 *
 * - 契约本体（`ViewTodo`）要被**三处**用：主进程的库与状态机、worker 的注入块、
 *   渲染层的第一段；放协议文件里会让「清单怎么渲染」这类纯函数跟着协议一起漂。
 * - 渲染是**纯函数**（给一串清单、出一段文本），两个消费方各有各的预算——
 *   工具结果要**全量**（模型据它决策），提示词注入要**有界**（视图每 50ms 全推，
 *   而注入每次请求都在）。两者共用同一份「怎么描述一条」的规则，避免两处口径打架。
 *
 * ⚠️ 上限常量放**本模块**、**不放** `@shared/limits`：`limits.ts` 的准入判据是
 * 「两侧不同值就会**静默**出错」（挂半路、界面停住却没有失败信号）。这里的漂移是
 * **可见的报错**——校验失败会作为工具错误回到模型（见 `main/todo-store.ts`）。
 * 别照「两侧共享的常量」一律往 `limits.ts` 里塞。
 */

/** 一条待办的状态。只有三态——没有「已取消」，删掉就是删掉（真源是库，不留墓碑） */
export type TodoStatus = "pending" | "in_progress" | "completed";

/** 投影给界面与模型的一条待办 */
export interface ViewTodo {
  /** 跨进程稳定（由**写入方**生成，重启后不变）：模型回传它来定位，界面拿它做 key */
  id: string;
  /** 祈使句：「给 session-manager 加体量闸守卫」 */
  subject: string;
  /** 进行中时的动名词：「正在写 todo-store」——**只在 in_progress 时显示** */
  activeForm: string;
  status: TodoStatus;
  /** 依赖的其它任务 id；被依赖项未完成时本项**不可**被标为 in_progress */
  blockedBy: string[];
  updatedAt: number;
}

/** 工具名：注册名、白名单项、模型看到的入参说明必须是同一个字面量 */
export const TODO_TOOL_NAME = "todo";

/** 单会话清单条数上限（超过就拒绝，而不是静默丢弃——模型会因此知道该先收敛清单） */
export const MAX_TODOS = 30;
/** `subject` / `activeForm` 长度上限（两者都直接进注入块，太长会把上下文挤掉） */
export const MAX_SUBJECT_CHARS = 100;
export const MAX_ACTIVE_FORM_CHARS = 100;
/** 单条依赖数量上限（依赖是给模型看的约束，不是依赖图工具） */
export const MAX_BLOCKED_BY = 10;
/** 注入块的行数预算：超预算时先丢已完成，最后才截断未完成，并**如实写出**还剩多少 */
export const TODO_BLOCK_LINES = 24;

/** 进度计分板：`done/total` 同时给界面标题与注入块表头用（口径只此一处） */
export function summarizeTodoProgress(todos: readonly ViewTodo[]): {
  total: number;
  done: number;
  running: number;
  pending: number;
} {
  let done = 0;
  let running = 0;
  for (const todo of todos) {
    if (todo.status === "completed") done += 1;
    else if (todo.status === "in_progress") running += 1;
  }
  return { total: todos.length, done, running, pending: todos.length - done - running };
}

const STATUS_WORD: Record<TodoStatus, string> = {
  pending: "待办",
  in_progress: "进行中",
  completed: "已完成",
};

/**
 * 依赖尚未满足的条目 id 集合：`blockedBy` 里**有任意一条未完成**即算被挡住。
 *
 * 抽成纯函数是为了让界面与注入块**用同一个判据**——两处各写一遍「依赖满足了吗」，
 * 迟早演变成「界面说在等、模型说可以开工」。
 */
export function blockedTodoIds(todos: readonly ViewTodo[]): Set<string> {
  const done = new Set(
    todos.filter((todo) => todo.status === "completed").map((todo) => todo.id),
  );
  const blocked = new Set<string>();
  for (const todo of todos) {
    if (todo.blockedBy.some((id) => !done.has(id))) blocked.add(todo.id);
  }
  return blocked;
}

/** 一条待办的描述：`- [进行中] 正在写 todo-store（id: a1b2c3d4；等待：…）` */
function describeTodo(todo: ViewTodo, blocked: Set<string>): string {
  const label = todo.status === "in_progress" && todo.activeForm !== "" ? todo.activeForm : todo.subject;
  const waiting = blocked.has(todo.id) ? "；等待：" + todo.blockedBy.join("、") : "";
  return `- [${STATUS_WORD[todo.status]}] ${label}（id: ${todo.id}${waiting}）`;
}

/**
 * 工具结果里的清单：**全量**（含已完成的每一条）。
 *
 * 模型据它决策下一次改哪条，所以不能像注入块那样把已完成折成一行——那正是它判断
 * 「还剩什么」的一半信息。行数由 `MAX_TODOS` 兜底，不会无界。
 */
export function renderTodoSnapshot(todos: readonly ViewTodo[]): string {
  const { total, done, running, pending } = summarizeTodoProgress(todos);
  if (total === 0) return "当前清单为空（没有任何待办）。";
  const blocked = blockedTodoIds(todos);
  return [
    `计划（共 ${total} 项：${running} 进行中 · ${pending} 待办 · ${done} 已完成）：`,
    ...todos.map((todo) => describeTodo(todo, blocked)),
  ].join("\n");
}

/**
 * 提示词注入块：**每请求**拼进系统提示词（见 `worker/entry.ts` 的 `transform_context`）。
 *
 * 三条口径（都来自 `DESIGN-todo.md` §8，别自己发明）：
 * 1. **空清单不产出任何东西**——宁可少一段，也不要一段「（无待办）」的常态噪声；
 * 2. 只铺开 `in_progress` + `pending`（进行中排在最前），`completed` 折成一行；
 * 3. 超出行数预算时**先丢已完成那行、最后才截断未完成**，并如实写出还剩多少。
 *    静默裁掉是不可接受的：模型会以为清单就这么长，然后漏掉后半段（`docs/ERRORS.md`）。
 */
export function renderTodoBlock(
  todos: readonly ViewTodo[],
  maxLines: number = TODO_BLOCK_LINES,
): string {
  if (todos.length === 0) return "";
  const { total, done, running, pending } = summarizeTodoProgress(todos);
  const blocked = blockedTodoIds(todos);
  const active = todos.filter((todo) => todo.status !== "completed");
  const finished = todos.filter((todo) => todo.status === "completed");

  const header = `当前待办清单（共 ${total} 项：${running} 进行中 · ${pending} 待办 · ${done} 已完成）`;
  const rule =
    "维护：开工前把该条标 in_progress；**完成一条立即标 completed**，不要批量补标；同一时刻只保留一条 in_progress。";

  // 预算先被表头与规则吃掉；剩下的才分给条目行
  const budget = Math.max(0, maxLines - 2);
  const hasFinished = finished.length > 0;
  // 口径 3 的**次序**：未完成条目 → 已完成汇总行 → 再截断未完成。
  // 所以「装不下」时**先丢已完成那行**（它的信息在表头的「已完成 N 项」里还在），
  // 再给「还有 N 项未列出」留一行——那句是**必写**的（不许静默裁掉）。
  const willTruncate = active.length > budget;
  const showFinished = hasFinished && !willTruncate && active.length + 1 <= budget;
  const room = willTruncate ? Math.max(0, budget - 1) : active.length;
  const shown = active.slice(0, room);
  const hidden = active.length - shown.length;

  const body = shown.map((todo) => describeTodo(todo, blocked));
  if (showFinished) {
    body.push(
      done === 1
        ? `- 已完成 1 项（${finished[0]!.subject}）`
        : `- 已完成 ${done} 项（用 todo list 可看全部）`,
    );
  }
  if (hidden > 0) body.push(`- （还有 ${hidden} 项未列出：超出注入预算，用 todo list 可看全部）`);
  return [`<todo_list>`, header, ...body, rule, `</todo_list>`].join("\n");
}
