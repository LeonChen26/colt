/**
 * 草稿会话的契约测试。
 *
 * 回归背景：`session.create` 过去立刻 INSERT 一行，于是「点了新建就退出」会在侧栏留下
 * 一串 `message_count=0`、点开还没反应的空会话——用户一个字都没发过。
 * 现在改为**首次发消息才落库**：新建只分配 id（草稿），不 fork worker、不建 JSONL。
 *
 * ipc 层依赖 Electron，node 测试里起不了真进程，故这里做**源码契约**校验，
 * 把「谁负责落库」这条不变量钉住：一旦有人在 create 里重新写库、或让草稿提前拉起
 * worker，用例立刻变红。端到端行为由冒烟的 [session/draft] 用例覆盖。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const IPC_SOURCE = readFileSync(new URL("../src/main/ipc/index.ts", import.meta.url), "utf8");

/** 取出某个 IPC handler 的函数体（从 `handle("名"` 起到下一个 handler 为止） */
function handlerBody(channel: string): string {
  const start = IPC_SOURCE.indexOf(`handle("${channel}"`);
  assert.notEqual(start, -1, `找不到通道 ${channel}`);
  const end = IPC_SOURCE.indexOf("handle(", start + 1);
  return IPC_SOURCE.slice(start, end === -1 ? undefined : end);
}

describe("草稿会话：首次发消息才落库", () => {
  test("session.create 不写库，只登记草稿", () => {
    const body = handlerBody("session.create");
    assert.doesNotMatch(body, /createSession\(/, "create 一旦落库，空会话就会重新出现");
    assert.match(body, /drafts\.set\(/, "必须登记成草稿，否则首次发消息无从落库");
  });

  test("session.open 对草稿直接返回，不为它 fork worker", () => {
    const body = handlerBody("session.open");
    assert.match(body, /drafts\.has\([\s\S]*?\)\s*return/, "草稿不该被 session.open 拉起");
    assert.match(body, /openSessionWorker\(/, "非草稿仍要正常打开");
  });

  test("session.prompt 先落库再投递（worker 启动时要读得到会话行）", () => {
    const body = handlerBody("session.prompt");
    const materializeAt = body.indexOf("materializeDraft(");
    const postAt = body.indexOf("promptOrReconnect(");
    assert.notEqual(materializeAt, -1, "首次发消息必须落库");
    assert.notEqual(postAt, -1, "找不到投递路径，用例本身需要更新");
    assert.ok(materializeAt < postAt, "落库必须早于投递");
  });

  test("session.compact 同样先落库（它也会把 worker 拉起来）", () => {
    const body = handlerBody("session.compact");
    assert.match(body, /materializeDraft\(/, "compact 也会 fork worker，同样必须先有会话行");
  });

  test("session.setModel 对草稿只记内存：不写库、也不拉起 worker", () => {
    const body = handlerBody("session.setModel");
    const draftAt = body.indexOf("drafts.get(");
    assert.notEqual(draftAt, -1, "草稿上的选择要记在草稿里");
    assert.ok(
      draftAt < body.indexOf("setSessionModel("),
      "草稿还没落库，UPDATE 会打在 0 行上——必须在落库分支之前拦截",
    );
    assert.ok(
      draftAt < body.indexOf("setModelOrReconnect("),
      "草稿不该因为「切个模型」就被拉起 worker",
    );
  });

  test("session.delete 对草稿只丢内存记录", () => {
    assert.match(handlerBody("session.delete"), /drafts\.delete\(/);
  });

  test("materializeDraft 沿用草稿 id，并带上草稿期选定的模型", () => {
    const start = IPC_SOURCE.indexOf("function materializeDraft(");
    assert.notEqual(start, -1, "找不到 materializeDraft");
    const body = IPC_SOURCE.slice(start, IPC_SOURCE.indexOf("\n}", start));
    assert.match(
      body,
      /draft\.projectId, jsonlPathFor\(draft\.projectId\), draft\.presetId, sessionId/,
      "必须沿用界面手里的那个 id，否则界面持有的会话不存在",
    );
    assert.match(body, /if \(draft\.modelRef\) setSessionModel\(/, "草稿期选定的模型要跟着落库");
  });
});
