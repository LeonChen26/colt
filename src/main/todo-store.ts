// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 待办清单的**状态机与宿主**（`todo` 工具的主进程侧）。
 *
 * 体例照 `question-store.ts`：**状态机在一个文件里读完，副作用交给宿主**
 * （`TodoStoreHost` 两个回调都是一行委托，由 session-manager 接线）。
 *
 * 三条结构性决定（见 `DESIGN-todo.md` §3、§5）：
 *
 * 1. **主进程是唯一写入方**，真源是 SQLite 的 `todos` 表。worker 被空闲回收重启后
 *    进程内存归零，靠「从会话分支重放工具结果」的参考实现方案要求「最后一条快照还在
 *    分支里」——压缩之后那还成不成立我们没验证过，落库把这个前提整个去掉。
 * 2. **每个动作是一个同步函数：校验 → 写入 → 返回整份快照，中间不 `await`。**
 *    主进程 JS 是单线程，这样「读-改-写」天然不会被两个并发 RPC 交错，
 *    于是「自动把上一条 `in_progress` 置回 `pending`」不需要显式事务，
 *    依赖校验失败时也能保证**一行都没落**（校验全在写之前）。
 * 3. **免审批**（工具名已在 `READONLY_TOOLS` 里），但它**会写库**——所以白名单的注释口径
 *    是「不对**用户工作区**产生副作用」，而不是「不产生副作用」。参数里没有任何路径，
 *    写入目标是应用自有的库，会话隔离由主进程按 `entry.sessionId` 强制
 *    （见 `docs/SECURITY.md` 的边界论证）。
 */
import { randomUUID } from "node:crypto";
import type { HostResult } from "@shared/worker-protocol";
import {
  MAX_ACTIVE_FORM_CHARS,
  MAX_BLOCKED_BY,
  MAX_SUBJECT_CHARS,
  MAX_TODOS,
  renderTodoSnapshot,
  type TodoStatus,
  type ViewTodo,
} from "@shared/todo";
import { listSessionTodos, replaceSessionTodos } from "./db/repo";

/**
 * 宿主接线：状态机只决定「写什么」，推界面与推镜像由宿主决定。
 * 两者都是一行委托（`#emitView` / `#post`），放在这里是想把
 * 「工具调用 → 校验 → 写库 → 推视图 + 推镜像」这条链留在同一个文件里读完。
 */
export interface TodoStoreHost {
  /** 写入后：失效该会话的视图缓存，并让 session-manager 重推视图（搭 `session.view` 顺风车） */
  changed: (sessionId: string) => void;
  /** 写入后：把整份清单推给 worker 做镜像（工具执行完 → 模型下一请求就能看到） */
  push: (sessionId: string, todos: ViewTodo[]) => void;
}

/** 五个动作。**不做**参考实现的 `get`：`list` 就是全量，清单很小，两个入口是重复的 */
export const TODO_ACTIONS = ["create", "update", "list", "delete", "clear"] as const;
export type TodoAction = (typeof TODO_ACTIONS)[number];

export function isTodoAction(value: unknown): value is TodoAction {
  return typeof value === "string" && (TODO_ACTIONS as readonly string[]).includes(value);
}

export type TodoActionResult =
  | { ok: true; todos: ViewTodo[]; note?: string }
  | { ok: false; message: string };

/** 状态转移表：只允许这些，其余一律拒绝（同状态重复是 no-op，不算转移） */
const ALLOWED: Record<TodoStatus, TodoStatus[]> = {
  // 开工：必须是这一条；做完：从「在做」收口
  pending: ["in_progress"],
  // 「在做」可以退回待办——**自动退回也走这条路径**（同一时刻只允许一条 in_progress）
  in_progress: ["completed", "pending"],
  // 已完成只能**显式重开**；不允许直接跳回「在做」——那让进度看起来莫名倒退
  completed: ["pending"],
};

/** 清单条目的定位提示：报错时把可用 id 一并给出，模型才知道该改成什么 */
function describeIds(todos: readonly ViewTodo[]): string {
  if (todos.length === 0) return "当前清单为空";
  return `当前清单：${todos.map((todo) => `${todo.id}(${todo.subject})`).join("、")}`;
}

/** 可空文本字段的读取与校验（`subject` / `activeForm` 共用） */
function readText(
  params: Record<string, unknown>,
  key: string,
  max: number,
  label: string,
): { ok: true; value?: string } | { ok: false; message: string } {
  const raw = params[key];
  if (raw === undefined) return { ok: true };
  if (typeof raw !== "string") return { ok: false, message: `${label} 必须是字符串` };
  const text = raw.trim();
  if (text === "") return { ok: false, message: `${label} 不能为空` };
  if (text.length > max) {
    return { ok: false, message: `${label} 超过 ${max} 字符（当前 ${text.length}）：${text}` };
  }
  return { ok: true, value: text };
}

/** 依赖列表的读取与形态校验（是否指向存在的条目由各动作自己判） */
function readBlockedBy(
  params: Record<string, unknown>,
): { ok: true; value?: string[] } | { ok: false; message: string } {
  const raw = params.blockedBy;
  if (raw === undefined) return { ok: true };
  if (!Array.isArray(raw)) return { ok: false, message: "blockedBy 必须是字符串数组（条目 id）" };
  const ids: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || item.trim() === "") {
      return { ok: false, message: "blockedBy 里的每一项都必须是非空的条目 id" };
    }
    const id = item.trim();
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length > MAX_BLOCKED_BY) {
    return { ok: false, message: `blockedBy 最多 ${MAX_BLOCKED_BY} 项，本次给了 ${ids.length} 项` };
  }
  return { ok: true, value: ids };
}

function assertKnown(
  ids: readonly string[],
  todos: readonly ViewTodo[],
  selfId?: string,
): string | undefined {
  const known = new Set(todos.map((todo) => todo.id));
  for (const id of ids) {
    if (id === selfId) return `blockedBy 不能指向自己（${id}）`;
    if (!known.has(id)) return `blockedBy 指向了不存在的条目：${id}。${describeIds(todos)}`;
  }
  return undefined;
}

/** 依赖图是否有环：`blockedBy` 边必须构成 DAG，否则「永远开不了工」且看不出原因 */
function hasCycle(todos: readonly ViewTodo[]): boolean {
  const byId = new Map(todos.map((todo) => [todo.id, todo]));
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string): boolean => {
    const current = state.get(id);
    if (current === "visiting") return true;
    if (current === "done") return false;
    state.set(id, "visiting");
    const todo = byId.get(id);
    for (const next of todo?.blockedBy ?? []) {
      if (byId.has(next) && visit(next)) return true;
    }
    state.set(id, "done");
    return false;
  };
  return todos.some((todo) => visit(todo.id));
}

/** 依赖是否已满足：`blockedBy` 全部 completed（**在做**不算满足） */
function blockedReason(todo: ViewTodo, todos: readonly ViewTodo[]): string | undefined {
  if (todo.blockedBy.length === 0) return undefined;
  const done = new Set(todos.filter((item) => item.status === "completed").map((item) => item.id));
  const open = todo.blockedBy.filter((id) => !done.has(id));
  return open.length > 0 ? open.join("、") : undefined;
}

/**
 * 生成一个新的条目 id：8 位十六进制（读写都短，模型回传不易抄错）。
 * 撞号时重试；**绝不静默重号**——极端情况下回落到完整 UUID。
 */
export function newTodoId(existing: readonly ViewTodo[]): string {
  const taken = new Set(existing.map((todo) => todo.id));
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = randomUUID().replace(/-/g, "").slice(0, 8);
    if (!taken.has(id)) return id;
  }
  return randomUUID();
}

/**
 * 纯状态机：给当前清单、动作与入参，算出**新清单**或一条可执行的报错。
 *
 * 纯函数（id 生成与时间都由调用方注入）是为了能单测到每一条状态转移与依赖校验——
 * 这条链路最贵的失败模式是**静默**，而能测的部分必须测到（同 `ask-user-tool.ts` 的理由）。
 */
export function applyTodoAction(
  current: readonly ViewTodo[],
  action: TodoAction,
  params: Record<string, unknown>,
  now: number,
  makeId: () => string,
): TodoActionResult {
  if (action === "list") return { ok: true, todos: [...current] };
  if (action === "clear") {
    if (current.length === 0) return { ok: true, todos: [], note: "（清单本来就是空的，无需清空）" };
    return { ok: true, todos: [], note: `（已清空本会话清单，共 ${current.length} 项）` };
  }
  if (action === "create") return createTodo(current, params, now, makeId);
  if (action === "update") return updateTodo(current, params, now);
  return deleteTodos(current, params);
}

function createTodo(
  current: readonly ViewTodo[],
  params: Record<string, unknown>,
  now: number,
  makeId: () => string,
): TodoActionResult {
  if (current.length >= MAX_TODOS) {
    return {
      ok: false,
      message: `清单最多 ${MAX_TODOS} 项，当前已有 ${current.length} 项。请先收敛清单（删掉不做的，或把已完成的清掉）。`,
    };
  }
  const subject = readText(params, "subject", MAX_SUBJECT_CHARS, "subject");
  if (!subject.ok) return subject;
  if (subject.value === undefined) {
    return { ok: false, message: "create 需要 subject（祈使句，一句话说清要做什么）" };
  }
  const activeForm = readText(params, "activeForm", MAX_ACTIVE_FORM_CHARS, "activeForm");
  if (!activeForm.ok) return activeForm;
  const blockedBy = readBlockedBy(params);
  if (!blockedBy.ok) return blockedBy;
  const unknown = assertKnown(blockedBy.value ?? [], current);
  if (unknown !== undefined) return { ok: false, message: unknown };

  const todo: ViewTodo = {
    id: makeId(),
    subject: subject.value,
    activeForm: activeForm.value ?? "",
    // 新建的一律是「待办」：开工是**显式**动作（标 in_progress），不靠猜
    status: "pending",
    blockedBy: blockedBy.value ?? [],
    updatedAt: now,
  };
  return { ok: true, todos: [...current, todo] };
}

function updateTodo(
  current: readonly ViewTodo[],
  params: Record<string, unknown>,
  now: number,
): TodoActionResult {
  const rawId = params.id;
  if (typeof rawId !== "string" || rawId.trim() === "") {
    return { ok: false, message: `update 需要 id（条目 id）。${describeIds(current)}` };
  }
  const id = rawId.trim();
  const index = current.findIndex((todo) => todo.id === id);
  if (index === -1) return { ok: false, message: `没有 id 为 ${id} 的条目。${describeIds(current)}` };
  const target = current[index]!;

  const subject = readText(params, "subject", MAX_SUBJECT_CHARS, "subject");
  if (!subject.ok) return subject;
  const activeForm = readText(params, "activeForm", MAX_ACTIVE_FORM_CHARS, "activeForm");
  if (!activeForm.ok) return activeForm;
  const blockedBy = readBlockedBy(params);
  if (!blockedBy.ok) return blockedBy;

  // 入参里的 status 与 blockedBy 一起生效，故所有校验都在**候选清单**上做
  let nextStatus = target.status;
  if (params.status !== undefined) {
    const raw = params.status;
    if (raw !== "pending" && raw !== "in_progress" && raw !== "completed") {
      return {
        ok: false,
        message: `status 只能是 pending / in_progress / completed，收到：${String(raw)}`,
      };
    }
    if (raw !== target.status && !ALLOWED[target.status].includes(raw)) {
      const hint =
        target.status === "completed" && raw === "in_progress"
          ? "已完成的任务要重新开工，请先标回 pending（显式重开），再标 in_progress。"
          : "待办要先标 in_progress 才能标 completed——「做完了」应当能看出它曾被开始过。";
      return {
        ok: false,
        message: `不允许的状态转移：${target.status} → ${raw}。${hint}`,
      };
    }
    nextStatus = raw;
  }

  const nextBlockedBy = blockedBy.value ?? target.blockedBy;
  const unknown = assertKnown(nextBlockedBy, current, id);
  if (unknown !== undefined) return { ok: false, message: unknown };

  const changed: ViewTodo = {
    ...target,
    subject: subject.value ?? target.subject,
    activeForm: activeForm.value ?? target.activeForm,
    status: nextStatus,
    blockedBy: nextBlockedBy,
    updatedAt: now,
  };
  const candidate = current.map((todo, at) => (at === index ? changed : todo));

  if (hasCycle(candidate)) {
    return { ok: false, message: "blockedBy 会形成环（互相等待，谁都无法开工），已拒绝本次修改。" };
  }

  // 依赖校验先于任何写入：被依赖项**未完成**时不许开工
  if (nextStatus === "in_progress" && nextStatus !== target.status) {
    const waiting = blockedReason(changed, candidate);
    if (waiting !== undefined) {
      return {
        ok: false,
        message: `这一条还在等 ${waiting} 完成，不能标 in_progress。先把依赖做完（或去掉 blockedBy 里已不成立的依赖）。`,
      };
    }
  }

  // 同一会话同一时刻只允许一条 in_progress：新开工的那条会**自动**把上一条退回待办，
  // 并在返回文本里说明——不说的话模型会以为自己写错了（或界面莫名的「进度倒退」）
  const previousRunning =
    nextStatus === "in_progress" && target.status !== "in_progress"
      ? candidate.find((todo) => todo.status === "in_progress" && todo.id !== id)
      : undefined;
  const todos =
    previousRunning === undefined
      ? candidate
      : candidate.map((todo) =>
          todo.id === previousRunning.id ? { ...todo, status: "pending" as const, updatedAt: now } : todo,
        );

  const depsEqual =
    nextBlockedBy.length === target.blockedBy.length &&
    nextBlockedBy.every((value, at) => value === target.blockedBy[at]);
  if (
    nextStatus === target.status &&
    depsEqual &&
    changed.subject === target.subject &&
    changed.activeForm === target.activeForm
  ) {
    // 同状态重复转移是 no-op（成功返回，不报错——重试不该失败）
    return { ok: true, todos: [...current], note: "（清单未发生变化）" };
  }
  return {
    ok: true,
    todos,
    ...(previousRunning !== undefined
      ? {
          note: `（上一条进行中的「${previousRunning.subject}」已自动退回待办——同一时刻只允许一条进行中）`,
        }
      : {}),
  };
}

function deleteTodos(
  current: readonly ViewTodo[],
  params: Record<string, unknown>,
): TodoActionResult {
  const raw = params.ids;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, message: `delete 需要 ids（要删的条目 id 数组）。${describeIds(current)}` };
  }
  const ids: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || item.trim() === "") {
      return { ok: false, message: "ids 里的每一项都必须是非空的条目 id" };
    }
    if (!ids.includes(item.trim())) ids.push(item.trim());
  }
  const known = new Set(current.map((todo) => todo.id));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length > 0) {
    return { ok: false, message: `这些 id 不存在：${missing.join("、")}。${describeIds(current)}` };
  }

  const removed = new Set(ids);
  // 删除必须**一并清掉指向它的依赖**：否则留下悬空引用，之后每次校验都会莫名失败
  let cleanedDeps = 0;
  const todos = current
    .filter((todo) => !removed.has(todo.id))
    .map((todo) => {
      const kept = todo.blockedBy.filter((id) => !removed.has(id));
      if (kept.length === todo.blockedBy.length) return todo;
      cleanedDeps += todo.blockedBy.length - kept.length;
      return { ...todo, blockedBy: kept };
    });
  return {
    ok: true,
    todos,
    note:
      cleanedDeps > 0
        ? `（已删除 ${ids.length} 项，并清掉 ${cleanedDeps} 处指向它们的依赖）`
        : `（已删除 ${ids.length} 项）`,
  };
}

/**
 * 工具调用的落点：校验 → 写库 → 推视图 + 推镜像 → 把整份快照交回模型。
 *
 * 校验失败**抛错**而不是回一段「失败文本」：内核的 `AgentToolResult` 没有 `isError`，
 * 返回文本会被当成「工具成功返回了一段话」，模型不知道自己发错了参数、也就不会改对重发
 * （这一条是 `ask-user-tool.ts` 实施时踩出来的）。抛出的文案里必须写清**正确写法**。
 */
export class TodoStore {
  #host?: TodoStoreHost;

  /** 由 session-manager 在构造时接线（它才有 `#emitView` 与 `#post`） */
  setHost(host: TodoStoreHost): void {
    this.#host = host;
  }

  handle(sessionId: string, action: string, params: Record<string, unknown>): HostResult {
    if (!isTodoAction(action)) {
      throw new Error(`未知的 todo 动作：${action}（可用：${TODO_ACTIONS.join(" / ")}）`);
    }
    const current = listSessionTodos(sessionId);
    const result = applyTodoAction(current, action, params, Date.now(), () => newTodoId(current));
    if (!result.ok) throw new Error(result.message);

    // `list` 是只读的：不写库、不推视图也不推镜像（否则每次看一眼清单都触发一次全量推送）
    if (action !== "list") {
      replaceSessionTodos(sessionId, result.todos);
      this.#host?.changed(sessionId);
      this.#host?.push(sessionId, result.todos);
    }
    const text = [result.note, renderTodoSnapshot(result.todos)]
      .filter((part): part is string => part !== undefined)
      .join("\n");
    return { text };
  }
}

/**
 * 单例：`HostBridge` 是模块级单例，`case "todo"` 要够得着它，而它又不能 import
 * session-manager（会成环）——故状态机做成单例、宿主回调由 session-manager 注入。
 * 库里没有任何会话级内存（真源是表），故 host 的 dispose 路径无需清它。
 */
export const todoStore = new TodoStore();
