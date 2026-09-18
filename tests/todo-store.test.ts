/**
 * 待办清单（`todo`）的单测：状态机与校验（纯函数）、DAO、工具落点、注入渲染。
 *
 * 这条链路最贵的失败模式是**静默**——清单落不了库、模型看不见清单、依赖约束形同虚设，
 * 三种都不会报错。所以能测的部分必须测到：状态转移逐条钉、依赖校验逐种钉、
 * 注入截断「先丢已完成 + 如实计数」逐条钉。
 *
 * 纯函数部分不需要库；DAO 与 `TodoStore.handle` 用独立的临时库（同 `repo.test.ts`）。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makeTempDir, removeTempDir } from "./helpers/temp";
import { openDatabase, closeDatabase, getDatabase } from "../src/main/db/index.ts";
import { listSessionTodos, replaceSessionTodos, upsertProject, createSession } from "../src/main/db/repo.ts";
import {
  TODO_ACTIONS,
  newTodoId,
  applyTodoAction,
  TodoStore,
  type TodoActionResult,
  type TodoStoreHost,
} from "../src/main/todo-store.ts";
import {
  MAX_TODOS,
  TODO_TOOL_NAME,
  renderTodoBlock,
  renderTodoSnapshot,
  summarizeTodoProgress,
  blockedTodoIds,
  type TodoStatus,
  type ViewTodo,
} from "../src/shared/todo.ts";
import { READONLY_TOOLS } from "../src/shared/readonly-tools.ts";

const NOW = 1_700_000_000_000;

function todo(id: string, status: TodoStatus = "pending", extra: Partial<ViewTodo> = {}): ViewTodo {
  return {
    id,
    subject: `任务 ${id}`,
    activeForm: "",
    status,
    blockedBy: [],
    updatedAt: NOW,
    ...extra,
  };
}

/** 纯函数的调用糖：id 生成固定成 "new"（除非用例自己给） */
function run(
  current: ViewTodo[],
  action: string,
  params: Record<string, unknown> = {},
  makeId: () => string = () => "new",
): TodoActionResult {
  assert.ok((TODO_ACTIONS as readonly string[]).includes(action), `用例给的动作必须存在：${action}`);
  return applyTodoAction(current, action as (typeof TODO_ACTIONS)[number], params, NOW, makeId);
}

function expectOk(result: TodoActionResult): Extract<TodoActionResult, { ok: true }> {
  assert.ok(result.ok, `期望成功，实际失败：${result.ok ? "" : result.message}`);
  return result;
}

function expectFail(result: TodoActionResult): string {
  assert.ok(!result.ok, "期望被拒绝，实际却成功了");
  return result.message;
}

describe("todo 状态机：create", () => {
  test("新建的是「待办」，id 由写入方生成，落在末尾", () => {
    const result = expectOk(run([todo("a")], "create", { subject: "写契约" }));
    assert.equal(result.todos.length, 2);
    const created = result.todos[1]!;
    assert.equal(created.id, "new");
    assert.equal(created.subject, "写契约");
    assert.equal(created.status, "pending");
    assert.equal(created.activeForm, "");
    assert.deepEqual(created.blockedBy, []);
    assert.equal(created.updatedAt, NOW);
  });

  test("缺 subject 时拒绝，并把正确写法说清楚", () => {
    const message = expectFail(run([], "create", {}));
    assert.match(message, /subject/);
  });

  test("空 subject / 超长 subject 都拒绝", () => {
    assert.match(expectFail(run([], "create", { subject: "   " })), /不能为空/);
    const long = "x".repeat(200);
    assert.match(expectFail(run([], "create", { subject: long })), /超过/);
  });

  test("blockedBy 指向不存在的条目时拒绝（并列出可用 id）", () => {
    const message = expectFail(run([todo("a")], "create", { subject: "s", blockedBy: ["zz"] }));
    assert.match(message, /不存在/);
    assert.match(message, /a\(任务 a\)/);
  });

  test("达到条数上限时拒绝，而不是静默丢弃", () => {
    const full = Array.from({ length: MAX_TODOS }, (_, index) => todo(`t${index}`));
    const message = expectFail(run(full, "create", { subject: "再来一条" }));
    assert.match(message, new RegExp(String(MAX_TODOS)));
  });

  test("blockedBy 里的重复项会被合并（同一条依赖写两遍无意义）", () => {
    const result = expectOk(run([todo("a")], "create", { subject: "s", blockedBy: ["a", "a"] }));
    assert.deepEqual(result.todos[1]!.blockedBy, ["a"]);
  });
});

describe("todo 状态机：状态转移", () => {
  test("pending → in_progress → completed 是允许的路径", () => {
    const started = expectOk(run([todo("a")], "update", { id: "a", status: "in_progress" }));
    assert.equal(started.todos[0]!.status, "in_progress");
    const done = expectOk(run(started.todos, "update", { id: "a", status: "completed" }));
    assert.equal(done.todos[0]!.status, "completed");
  });

  test("completed → pending（显式重开）允许", () => {
    const reopened = expectOk(run([todo("a", "completed")], "update", { id: "a", status: "pending" }));
    assert.equal(reopened.todos[0]!.status, "pending");
  });

  test("completed → in_progress 拒绝，并提示先标回 pending", () => {
    const message = expectFail(run([todo("a", "completed")], "update", { id: "a", status: "in_progress" }));
    assert.match(message, /不允许的状态转移/);
    assert.match(message, /pending/);
  });

  test("pending → completed 拒绝：没开始过就不该「已完成」", () => {
    const message = expectFail(run([todo("a")], "update", { id: "a", status: "completed" }));
    assert.match(message, /in_progress/);
  });

  test("同状态重复转移是 no-op（重试不该失败），且如实说明未变化", () => {
    const current = [todo("a", "in_progress")];
    const result = expectOk(run(current, "update", { id: "a", status: "in_progress" }));
    assert.deepEqual(result.todos, current);
    assert.match(result.note ?? "", /未发生变化/);
  });

  test("未知 id 拒绝，并列出当前清单的 id", () => {
    const message = expectFail(run([todo("a")], "update", { id: "nope", status: "in_progress" }));
    assert.match(message, /没有 id 为 nope/);
    assert.match(message, /a\(任务 a\)/);
  });

  test("未知 status 拒绝", () => {
    const message = expectFail(run([todo("a")], "update", { id: "a", status: "archived" }));
    assert.match(message, /pending \/ in_progress \/ completed/);
  });

  test("可以只改内容（不改状态）", () => {
    const result = expectOk(
      run([todo("a")], "update", { id: "a", subject: "换个说法", activeForm: "正在换说法" }),
    );
    assert.equal(result.todos[0]!.subject, "换个说法");
    assert.equal(result.todos[0]!.activeForm, "正在换说法");
    assert.equal(result.todos[0]!.status, "pending");
  });
});

describe("todo 状态机：同一时刻只允许一条 in_progress", () => {
  test("新开工的那条会把上一条自动退回待办，并在返回文本里说明", () => {
    const current = [todo("a", "in_progress"), todo("b")];
    const result = expectOk(run(current, "update", { id: "b", status: "in_progress" }));
    assert.equal(result.todos[0]!.status, "pending");
    assert.equal(result.todos[1]!.status, "in_progress");
    assert.match(result.note ?? "", /任务 a/);
    assert.match(result.note ?? "", /自动退回待办/);
  });

  test("新开工的那条依赖着正在跑的那条时，拒绝而不是「先退后开」", () => {
    const current = [todo("a", "in_progress"), todo("b", "pending", { blockedBy: ["a"] })];
    const message = expectFail(run(current, "update", { id: "b", status: "in_progress" }));
    assert.match(message, /还在等 a/);
  });
});

describe("todo 状态机：依赖校验（整次调用不落任何一行）", () => {
  test("被依赖项未完成时不许标 in_progress", () => {
    const current = [todo("a"), todo("b", "pending", { blockedBy: ["a"] })];
    const message = expectFail(run(current, "update", { id: "b", status: "in_progress" }));
    assert.match(message, /还在等 a/);
  });

  test("被依赖项完成后可以开工", () => {
    const current = [todo("a", "completed"), todo("b", "pending", { blockedBy: ["a"] })];
    const result = expectOk(run(current, "update", { id: "b", status: "in_progress" }));
    assert.equal(result.todos[1]!.status, "in_progress");
  });

  test("「在做」不算满足依赖（互等会永远开不了工）", () => {
    const current = [todo("a", "in_progress"), todo("b", "pending", { blockedBy: ["a"] })];
    assert.match(expectFail(run(current, "update", { id: "b", status: "in_progress" })), /还在等 a/);
  });

  test("自依赖拒绝", () => {
    const message = expectFail(run([todo("a")], "update", { id: "a", blockedBy: ["a"] }));
    assert.match(message, /不能指向自己/);
  });

  test("成环拒绝（互相等待谁都无法开工）", () => {
    const current = [todo("a"), todo("b")];
    // 先建一条单向依赖（此时无环）
    const oneWay = expectOk(run(current, "update", { id: "b", blockedBy: ["a"] }));
    assert.deepEqual(oneWay.todos.find((item) => item.id === "b")!.blockedBy, ["a"]);
    // 再让 a 依赖 b → 成环
    assert.match(expectFail(run(oneWay.todos, "update", { id: "a", blockedBy: ["b"] })), /环/);
  });

  test("blockedBy 指向不存在的条目时拒绝", () => {
    assert.match(expectFail(run([todo("a")], "update", { id: "a", blockedBy: ["zz"] })), /不存在/);
  });
});

describe("todo 状态机：delete / clear", () => {
  test("删除时一并清掉指向它的依赖，并如实计数", () => {
    const current = [todo("a"), todo("b", "pending", { blockedBy: ["a"] }), todo("c", "pending", { blockedBy: ["a"] })];
    const result = expectOk(run(current, "delete", { ids: ["a"] }));
    assert.deepEqual(result.todos.map((item) => item.id), ["b", "c"]);
    for (const item of result.todos) assert.deepEqual(item.blockedBy, []);
    assert.match(result.note ?? "", /清掉 2 处/);
  });

  test("删不存在的 id 时整次拒绝（不许删一半）", () => {
    const message = expectFail(run([todo("a"), todo("b")], "delete", { ids: ["a", "zz"] }));
    assert.match(message, /不存在/);
  });

  test("ids 为空或不是数组时拒绝", () => {
    assert.match(expectFail(run([todo("a")], "delete", {})), /ids/);
    assert.match(expectFail(run([todo("a")], "delete", { ids: [] })), /ids/);
  });

  test("clear 清空；本来就是空的时候如实说明", () => {
    assert.deepEqual(expectOk(run([todo("a"), todo("b")], "clear")).todos, []);
    const empty = expectOk(run([], "clear"));
    assert.deepEqual(empty.todos, []);
    assert.match(empty.note ?? "", /本来就是空/);
  });

  test("list 原样返回，且不产生 note（只读动作不该有副作用文案）", () => {
    const current = [todo("a")];
    const result = expectOk(run(current, "list"));
    assert.deepEqual(result.todos, current);
    assert.equal(result.note, undefined);
  });
});

describe("newTodoId", () => {
  test("8 位十六进制，且不与现有条目重号", () => {
    const existing = [todo("aaaaaaaa"), todo("bbbbbbbb")];
    for (let i = 0; i < 20; i += 1) {
      const id = newTodoId(existing);
      assert.match(id, /^[0-9a-f]{8}$/);
      assert.ok(!existing.some((item) => item.id === id));
    }
  });
});

describe("免审批口径：todo 在白名单里，且工具名与常量同源", () => {
  test("TODO_TOOL_NAME 在 READONLY_TOOLS 里（改名单会让这条红，而不是让闸门开始拦它）", () => {
    assert.ok(READONLY_TOOLS.has(TODO_TOOL_NAME));
  });
});

describe("渲染：工具结果给全量", () => {
  test("空清单时说清楚「没有待办」，不装成一份清单", () => {
    assert.match(renderTodoSnapshot([]), /清单为空/);
  });

  test("每条都带状态、id 与进度计分板（模型要靠 id 定位）", () => {
    const current = [
      todo("a", "completed"),
      todo("b", "in_progress", { activeForm: "正在写 todo-store" }),
      todo("c", "pending", { blockedBy: ["b"] }),
    ];
    const text = renderTodoSnapshot(current);
    assert.match(text, /共 3 项：1 进行中 · 1 待办 · 1 已完成/);
    assert.match(text, /\[进行中\] 正在写 todo-store（id: b）/);
    assert.match(text, /\[已完成\] 任务 a（id: a）/);
    // 依赖未满足要看得出来：它是在等，不是被忘了
    assert.match(text, /\[待办\] 任务 c（id: c；等待：b）/);
  });

  test("已完成的也逐条列出（这与注入块的口径不同，故意的）", () => {
    const current = [todo("a", "completed"), todo("b", "completed")];
    const text = renderTodoSnapshot(current);
    assert.match(text, /任务 a/);
    assert.match(text, /任务 b/);
  });
});

describe("渲染：注入块给有界的一段", () => {
  test("空清单不产出任何文本（宁可少一段，也不要一段常态噪声）", () => {
    assert.equal(renderTodoBlock([]), "");
  });

  test("只铺开进行中 + 待办，已完成折成一行", () => {
    const current = [
      todo("a", "completed"),
      todo("b", "in_progress", { activeForm: "正在写注入" }),
      todo("c"),
    ];
    const block = renderTodoBlock(current);
    assert.match(block, /^<todo_list>/);
    assert.match(block, /<\/todo_list>$/);
    assert.match(block, /\[进行中\] 正在写注入/);
    assert.match(block, /\[待办\] 任务 c/);
    // 已完成的那条**只以一行汇总出现**，不逐条铺开
    assert.match(block, /已完成 1 项（任务 a）/);
    assert.doesNotMatch(block, /\[已完成\]/);
  });

  test("维护规矩随块一起注入（这是它唯一持久的通道）", () => {
    assert.match(renderTodoBlock([todo("a")]), /完成一条立即标/);
  });

  test("超预算时先丢已完成那行，并如实写出还剩多少（不许静默裁掉）", () => {
    const current = [
      todo("a", "completed"),
      todo("b", "in_progress"),
      ...Array.from({ length: 10 }, (_, index) => todo(`p${index}`)),
    ];
    const block = renderTodoBlock(current, 8);
    const lines = block.split("\n");
    // 预算数的是**内容行**（表头 + 条目 + 规则），两个标签行是框子，不计入
    const content = lines.filter((line) => line !== "<todo_list>" && line !== "</todo_list>");
    assert.ok(content.length <= 8, `注入块不该超预算：${content.length} 行`);
    // 已完成那行先被丢掉（未完成的对「接下来做什么」更有用）
    assert.doesNotMatch(block, /已完成 1 项/);
    // 截断必须如实计数
    assert.match(block, /还有 \d+ 项未列出/);
    // 进行中的一定还在
    assert.match(block, /\[进行中\]/);
  });

  test("预算足够大时不截断，也不出现「未列出」那句话", () => {
    const current = [todo("a", "in_progress"), todo("b")];
    const block = renderTodoBlock(current, 24);
    assert.doesNotMatch(block, /未列出/);
    assert.match(block, /已完成 0 项|共 2 项/);
  });
});

describe("进度与依赖判据（界面与注入块同源）", () => {
  test("计分板三态各计一格", () => {
    const stats = summarizeTodoProgress([
      todo("a", "completed"),
      todo("b", "in_progress"),
      todo("c"),
      todo("d"),
    ]);
    assert.deepEqual(stats, { total: 4, done: 1, running: 1, pending: 2 });
  });

  test("被挡住的只有「依赖未全部完成」的那些", () => {
    const current = [
      todo("a", "completed"),
      todo("b"),
      todo("c", "pending", { blockedBy: ["a"] }),
      todo("d", "pending", { blockedBy: ["b"] }),
    ];
    const blocked = blockedTodoIds(current);
    assert.deepEqual([...blocked], ["d"]);
  });
});

describe("DAO：todos 表", () => {
  let root: string;
  let projectId: string;
  let sessionId: string;

  beforeEach(() => {
    closeDatabase();
    root = makeTempDir("colt-todo-");
    openDatabase(root);
    projectId = upsertProject("E:/demo").id;
    sessionId = createSession(projectId, "x.jsonl").id;
  });

  afterEach(() => {
    closeDatabase();
    removeTempDir(root);
  });

  test("写入后读回：顺序、状态与依赖都保持", () => {
    replaceSessionTodos(sessionId, [
      todo("a", "in_progress"),
      todo("b", "pending", { blockedBy: ["a"], activeForm: "正在等 a" }),
    ]);
    const back = listSessionTodos(sessionId);
    assert.deepEqual(back.map((item) => item.id), ["a", "b"]);
    assert.equal(back[0]!.status, "in_progress");
    assert.deepEqual(back[1]!.blockedBy, ["a"]);
    assert.equal(back[1]!.activeForm, "正在等 a");
  });

  test("整份覆盖是幂等的（同一份写两遍不涨条目）", () => {
    const current = [todo("a"), todo("b")];
    replaceSessionTodos(sessionId, current);
    replaceSessionTodos(sessionId, current);
    assert.equal(listSessionTodos(sessionId).length, 2);
  });

  test("按会话隔离：另一个会话的清单互不可见", () => {
    const other = createSession(projectId, "y.jsonl").id;
    replaceSessionTodos(sessionId, [todo("a")]);
    replaceSessionTodos(other, [todo("x"), todo("y")]);
    assert.deepEqual(listSessionTodos(sessionId).map((item) => item.id), ["a"]);
    assert.deepEqual(listSessionTodos(other).map((item) => item.id), ["x", "y"]);
  });

  test("写空数组 = 只清本会话", () => {
    const other = createSession(projectId, "y.jsonl").id;
    replaceSessionTodos(sessionId, [todo("a")]);
    replaceSessionTodos(other, [todo("x")]);
    replaceSessionTodos(sessionId, []);
    assert.deepEqual(listSessionTodos(sessionId), []);
    assert.equal(listSessionTodos(other).length, 1);
  });

  test("脏的 blocked_by_json 不会让整份清单读不出来（当作空依赖）", () => {
    replaceSessionTodos(sessionId, [todo("a")]);
    // 直接写坏 JSON：这是「依赖信息丢了」，不该升级成「界面空白」
    getDatabase()
      .prepare("UPDATE todos SET blocked_by_json = 'not json' WHERE session_id = ?")
      .run(sessionId);
    const back = listSessionTodos(sessionId);
    assert.equal(back.length, 1);
    assert.deepEqual(back[0]!.blockedBy, []);
  });
});

describe("TodoStore：工具落点", () => {
  let root: string;
  let sessionId: string;
  let calls: { changed: number; pushed: ViewTodo[][] };

  beforeEach(() => {
    closeDatabase();
    root = makeTempDir("colt-todo-store-");
    openDatabase(root);
    const project = upsertProject("E:/demo");
    sessionId = createSession(project.id, "x.jsonl").id;
    calls = { changed: 0, pushed: [] };
  });

  afterEach(() => {
    closeDatabase();
    removeTempDir(root);
  });

  function store(): TodoStore {
    const instance = new TodoStore();
    const host: TodoStoreHost = {
      changed: () => {
        calls.changed += 1;
      },
      push: (_sessionId, todos) => {
        calls.pushed.push(todos);
      },
    };
    instance.setHost(host);
    return instance;
  }

  test("未知动作抛错（不静默当成 list）", () => {
    assert.throws(() => store().handle(sessionId, "archive", {}), /未知的 todo 动作/);
  });

  test("create 写库、推视图、推镜像，并把整份清单交回模型", () => {
    const result = store().handle(sessionId, "create", { subject: "写单测" });
    assert.match(result.text, /写单测/);
    assert.equal(listSessionTodos(sessionId).length, 1);
    assert.equal(calls.changed, 1);
    assert.equal(calls.pushed.length, 1);
    assert.equal(calls.pushed[0]!.length, 1);
  });

  test("list 只读：不写库、不推视图也不推镜像", () => {
    const instance = store();
    instance.handle(sessionId, "create", { subject: "a" });
    calls.changed = 0;
    calls.pushed.length = 0;
    const result = instance.handle(sessionId, "list", {});
    assert.match(result.text, /a/);
    assert.equal(calls.changed, 0);
    assert.equal(calls.pushed.length, 0);
  });

  test("校验失败抛错（内核据此标 isError），且一行都没落", () => {
    const instance = store();
    assert.throws(() => instance.handle(sessionId, "update", { id: "nope", status: "in_progress" }), /没有 id/);
    assert.deepEqual(listSessionTodos(sessionId), []);
    assert.equal(calls.changed, 0);
    assert.equal(calls.pushed.length, 0);
  });

  test("返回文本里带上「自动退回」的说明（模型才不会以为自己写错）", () => {
    const instance = store();
    const first = instance.handle(sessionId, "create", { subject: "第一条" });
    const second = instance.handle(sessionId, "create", { subject: "第二条" });
    const ids = listSessionTodos(sessionId).map((item) => item.id);
    instance.handle(sessionId, "update", { id: ids[0]!, status: "in_progress" });
    const text = instance.handle(sessionId, "update", { id: ids[1]!, status: "in_progress" }).text;
    assert.match(text, /自动退回待办/);
    assert.match(text, /第一条/);
    assert.ok(first.text.length > 0 && second.text.length > 0);
  });

  test("没有接线宿主时也能工作（单测 / 无 worker 的场景）", () => {
    const instance = new TodoStore();
    const result = instance.handle(sessionId, "create", { subject: "无人接线" });
    assert.match(result.text, /无人接线/);
  });
});
