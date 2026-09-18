/**
 * 提问队列（主进程侧）测试。
 *
 * 这是本次 `ask_user` 改动里状态最密的一块：入队、超时、作答、跳过、中断作废全在这里，
 * 而失败模式全是**静默**的——回发到已出队的条目、超时后作答被丢弃、作废时漏发一条，
 * 界面上看不出任何异常，模型那边只是永远等不到答复。所以逐条钉在副作用上。
 *
 * 与 `approval-store.test.ts` 的分工：那份测的是纯状态机（计时器在 SessionManager 手里）；
 * 这份的计时器就在被测对象内部，故超时用短时限真跑（`unref` 过，不会挂住测试进程）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { QuestionStore, type UserQuestionRecord } from "../src/main/question-store.ts";
import { APPROVAL_TIMEOUT_MS } from "@shared/limits";
import type { AskUserQuestion, WorkerCommand } from "@shared/worker-protocol";

const SESSION = "s1";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function questions(): AskUserQuestion[] {
  return [
    {
      question: "用哪个库？",
      header: "依赖",
      options: [
        { label: "Zustand", description: "轻" },
        { label: "Redux", description: "重" },
      ],
    },
  ];
}

/** 宿主侧的全部副作用都记下来——判据只落在「回发了什么、推了什么」上 */
function harness(): {
  store: QuestionStore;
  posted: { sessionId: string; command: WorkerCommand }[];
  emitted: { sessionId: string; requests: UserQuestionRecord[] }[];
  attention: () => number;
} {
  const posted: { sessionId: string; command: WorkerCommand }[] = [];
  const emitted: { sessionId: string; requests: UserQuestionRecord[] }[] = [];
  let attention = 0;
  const store = new QuestionStore({
    post: (sessionId, command) => posted.push({ sessionId, command }),
    emit: (sessionId, requests) => emitted.push({ sessionId, requests }),
    attention: () => {
      attention += 1;
    },
  });
  return { store, posted, emitted, attention: () => attention };
}

/** 取出回发的 askUserResult 载荷（顺带断言它真的是这一种命令，别用 as 蒙过去） */
function resultOf(command: WorkerCommand | undefined): Extract<WorkerCommand, { type: "askUserResult" }> {
  assert.ok(
    command !== undefined && command.type === "askUserResult",
    `期望 askUserResult，实为 ${JSON.stringify(command)}`,
  );
  return command;
}

describe("QuestionStore", () => {
  test("入队：推全量列表并请求注意", () => {
    const h = harness();
    h.store.enqueue(SESSION, "t1", questions(), 60_000);

    assert.equal(h.store.count(SESSION), 1);
    assert.equal(h.emitted.at(-1)?.sessionId, SESSION);
    // 推的是**全量**：渲染层直接替换，不做增量合并
    assert.deepEqual(
      h.emitted.at(-1)?.requests.map((item) => item.toolCallId),
      ["t1"],
    );
    assert.ok(h.attention() > 0, "队列非空必须同步「有人在等」");
    h.store.cancelAll(SESSION);
  });

  test("作答：回发 answers 并出队", () => {
    const h = harness();
    h.store.enqueue(SESSION, "t1", questions(), 60_000);
    h.store.answer(SESSION, "t1", { "用哪个库？": "Zustand" });

    assert.equal(h.store.count(SESSION), 0);
    assert.equal(h.posted.length, 1);
    assert.equal(h.posted[0]?.sessionId, SESSION);
    assert.deepEqual(resultOf(h.posted[0]?.command), {
      type: "askUserResult",
      toolCallId: "t1",
      answers: { "用哪个库？": "Zustand" },
    });
    // 出队后界面要收到空列表，否则卡片会一直挂在那儿
    assert.equal(h.emitted.at(-1)?.requests.length, 0);
  });

  test("跳过：回发 skipped 这一档，与「中断」分得开", () => {
    const h = harness();
    h.store.enqueue(SESSION, "t1", questions(), 60_000);
    h.store.skip(SESSION, "t1");

    // 走 skip 而不是 cancelAll：前者告诉模型「按假设继续」，后者是「对话断了」
    assert.equal(resultOf(h.posted[0]?.command).skipped, "skipped");
    assert.equal(h.store.count(SESSION), 0);
  });

  test("超时：到点自己收尾，不等用户也不干等", async () => {
    const h = harness();
    h.store.enqueue(SESSION, "t1", questions(), 40);
    assert.equal(h.store.count(SESSION), 1);

    await sleep(200);
    assert.equal(h.store.count(SESSION), 0);
    assert.equal(resultOf(h.posted[0]?.command).skipped, "timeout");
    assert.equal(h.emitted.at(-1)?.requests.length, 0);
  });

  test("timeoutMs 传 0：沿用审批那份等待上限（不写第二份时长）", () => {
    const h = harness();
    h.store.enqueue(SESSION, "t1", questions(), 0);
    assert.equal(h.emitted.at(-1)?.requests[0]?.timeoutMs, APPROVAL_TIMEOUT_MS);
    h.store.cancelAll(SESSION);
  });

  test("重复作答 / 作答一条不在队列里的：都不再回发", () => {
    const h = harness();
    h.store.enqueue(SESSION, "t1", questions(), 60_000);
    h.store.answer(SESSION, "t1", { "用哪个库？": "Zustand" });
    // 第二次作答时 worker 已不在这条上等；再发一条命令只会让它收到两条矛盾的答复
    h.store.answer(SESSION, "t1", { "用哪个库？": "Redux" });
    h.store.answer(SESSION, "没这条", { "用哪个库？": "Redux" });
    assert.equal(h.posted.length, 1);
  });

  test("cancelAll：逐条回发 cancelled，且只作废本会话", () => {
    const h = harness();
    h.store.enqueue("s1", "t1", questions(), 60_000);
    h.store.enqueue("s1", "t2", questions(), 60_000);
    h.store.enqueue("s2", "t3", questions(), 60_000);

    h.store.cancelAll("s1");
    assert.equal(h.store.count("s1"), 0, "本会话应清空");
    assert.equal(h.store.count("s2"), 1, "别的会话不受影响");
    assert.deepEqual(
      h.posted.map((item) => resultOf(item.command).skipped),
      ["cancelled", "cancelled"],
    );
    h.store.cancelAll("s2");
  });

  test("同一条重复入队：旧定时器被撤，新记录按自己的时限收尾", async () => {
    // 回归测试：旧定时器不撤的话，它到点会把**新**记录一起判成超时
    const h = harness();
    h.store.enqueue(SESSION, "t1", questions(), 40);
    h.store.enqueue(SESSION, "t1", questions(), 60_000);

    await sleep(200);
    assert.equal(h.store.count(SESSION), 1, "新记录不该被旧定时器判成超时");
    assert.equal(h.posted.length, 0, "没到点就不该回发");
    h.store.cancelAll(SESSION);
  });

  test("list 返回副本：外部改动不会破坏队列", () => {
    const h = harness();
    h.store.enqueue(SESSION, "t1", questions(), 60_000);
    h.store.list(SESSION).pop();
    assert.equal(h.store.count(SESSION), 1);
    h.store.list("没这条会话");
    assert.deepEqual(h.store.list("没这条会话"), []);
    h.store.cancelAll(SESSION);
  });
});
