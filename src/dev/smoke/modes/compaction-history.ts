// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 冒烟模式：compaction-history
 *
 * 验一条**产品原则**：压缩解决的是「发给模型的上下文」，会话历史是「用户看的」，
 * 两者不能混为一谈。压缩之后，界面上的消息流必须**仍然包含压缩之前的历史**
 * （摘要卡按时间顺序插在中间），而不是只剩摘要 + 最近保留的尾部。
 *
 * 做法（免模型服务、不出网、不计费）：
 *  1. 本地起一个 OpenAI 兼容桩，把会话模型指过去；
 *  2. 把压缩策略调到很小（`keepRecentTokens: 1024`，下界），发两轮**带标记的长消息**；
 *  3. 手动触发 `/compact`（摘要请求也由桩回答），等压缩卡出现；
 *  4. 断言：压缩卡在消息流里、且**第一轮的标记文本仍然在**（这正是压缩前的历史）。
 *
 * 判据全部来自主进程视图（`sessionManager.getView()`），不看「函数被调用过」。
 */
import { app, type BrowserWindow } from "electron";
import { createServer, type ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createSession, upsertProject } from "../../../main/db/repo";
import { sessionManager } from "../../../main/session-manager";
import { sleep } from "../context";

const PROVIDER_ID = "smoke-compaction-history";
const MODEL_ID = "smoke-model";
const MODEL_REF = `${PROVIDER_ID}/${MODEL_ID}`;
/** 第一轮的标记：压缩之后它必须还在消息流里 */
const OLD_MARK = "ALPHA-压缩前的历史";
/** 第二轮的标记 */
const NEW_MARK = "BETA-压缩前的近期";
/** 制造足够的 token（下界保留量 1024），让压缩真的切掉第一轮 */
const FILLER = "甲乙丙丁戊己庚辛壬癸".repeat(220);

export async function runCompactionHistory(
  _window: BrowserWindow,
  log: (message: string) => void,
  run: <T>(expression: string) => Promise<T>,
): Promise<void> {
  const checks: [string, boolean][] = [];
  const push = (label: string, ok: boolean): void => {
    checks.push([label, ok]);
    log(`  ${ok ? "✓" : "✗"} ${label}`);
  };

  const fixtureDir = join(process.cwd(), "out", "smoke-compaction-history");
  mkdirSync(fixtureDir, { recursive: true });
  const project = upsertProject(fixtureDir);
  const session = createSession(project.id, join(app.getPath("userData"), "sessions", project.id));
  log(`夹具项目：${fixtureDir}`);
  log(`会话：${session.id}`);

  let requests = 0;
  const chunk = (choices: unknown[]): Record<string, unknown> => ({
    id: "chatcmpl-smoke",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: MODEL_ID,
    choices,
  });
  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.statusCode = 404;
      res.end();
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (piece: string) => {
      body += piece;
    });
    req.on("end", () => {
      requests += 1;
      const index = requests;
      // 摘要请求与普通对话走同一个桩：回一句短文本即可（判据不依赖摘要内容）
      log(`  模型请求 #${index}（${body.length} 字节）`);
      const reply = (res: ServerResponse, text: string): void => {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(
          `data: ${JSON.stringify(
            chunk([{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }]),
          )}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify(
            chunk([{ index: 0, delta: {}, finish_reason: "stop" }]),
          )}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
      };
      // 回复内容一律恒定：判据不依赖文本，按请求序号分支只会在「有额外请求」时错位
      reply(res, `第 ${index} 次回答。`);
    });
  });

  const waitUntil = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await sleep(200);
    }
    return false;
  };
  const viewTexts = (): string[] =>
    (sessionManager.getView(session.id)?.messages ?? []).map((message) => message.text);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  if (port === 0) throw new Error("模型桩服务没有拿到监听端口");
  log(`模型桩：http://127.0.0.1:${port}/v1`);

  // 改的是**全局设置**：先记下用户原来的配置，收尾原样还回去
  const previous = await run<{ config: unknown }>(
    `window.colt.invoke("compaction.config.get")`,
  ).catch(() => undefined);

  try {
    await run(
      `window.colt.invoke("providers.save", ${JSON.stringify({
        id: PROVIDER_ID,
        name: "压缩历史冒烟（本地桩）",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        // 上下文窗口给大：阻塞阈值 = contextWindow − reserveTokens，小窗口会让**自动压缩**
        // 在两轮之间就触发，于是「压缩卡出现」可能来自自动压缩，手动 `session.compact`
        // 那条路根本没被走到（实测 8192 时桩会多收到一次摘要请求，之后手动压缩是空操作）
        models: [{ id: MODEL_ID, name: "冒烟桩模型", contextWindow: 200_000 }],
        requiresKey: false,
      })})`,
    );
    // 压缩策略调到下界：保留 1024 token，两轮长消息足够切掉第一轮
    await run(
      `window.colt.invoke("compaction.config.set", ${JSON.stringify({
        config: {
          enabled: true,
          reserveTokens: 1024,
          keepRecentTokens: 1024,
          backgroundTokens: 0,
        },
      })})`,
    );

    await run(
      `window.colt.invoke("session.open", ${JSON.stringify({
        sessionId: session.id,
        model: MODEL_REF,
      })})`,
    );
    const started = await waitUntil(
      () => sessionManager.workerPidForSmoke(session.id) !== undefined,
      15_000,
    );
    push("前置：真实 worker 已就绪", started);
    if (!started) return;
    // 渲染层挂载时会把「最近的项目」的第一条会话自动打开，可能先于上面这次 open 抢到
    // 同一个 worker，而 worker 的模型由先到者定——于是这里读到的可能是真实服务
    // （实测撞到过 deepseek）。显式改一次模型把竞态收口，绝不带着真模型往下发 prompt。
    let boundModel = sessionManager.getView(session.id)?.model;
    if (boundModel !== MODEL_REF) {
      log(`  会话模型是 ${boundModel ?? "?"}（渲染层抢先打开了会话），显式切到本地桩`);
      await run(
        `window.colt.invoke("session.setModel", ${JSON.stringify({
          sessionId: session.id,
          providerId: PROVIDER_ID,
          modelId: MODEL_ID,
        })})`,
      );
      boundModel = sessionManager.getView(session.id)?.model;
    }
    push(
      `前置：会话模型指向本地桩（实际 ${boundModel ?? "?"}；指错就会打到真模型、既计费又没验到东西）`,
      boundModel === MODEL_REF,
    );
    // 模型没指到桩上就**别发 prompt**——这时的每一条都会打真模型
    if (boundModel !== MODEL_REF) return;

    for (const [mark, filler] of [
      [OLD_MARK, FILLER],
      [NEW_MARK, FILLER],
    ] as const) {
      await run(
        `window.colt.invoke("session.prompt", ${JSON.stringify({
          sessionId: session.id,
          text: `${mark}\n${filler}`,
        })})`,
      );
    }
    // 两次 prompt 是排队执行的：只等「第一条的回复到了」会在两轮之间误判成跑完，
    // 判据要落在「两轮各自都有回复 + 队列空了」上
    const answered = await waitUntil(() => {
      const view = sessionManager.getView(session.id);
      if (view === undefined || view.running || view.queuedCount > 0) return false;
      return view.messages.filter((m) => m.role === "assistant").length >= 2;
    }, 60_000);
    push("前置：两轮对话都跑完了", answered);
    log(`  模型：${sessionManager.getView(session.id)?.model ?? "?"}`);
    log(`  桩服务收到请求数：${requests}`);
    push(
      "前置：两轮对话都打到了本地桩（不是真模型——否则既计费又没验到东西）",
      requests >= 2,
    );
    // 桩没被调用过 → 不能再触发压缩（那还会再打一次模型）
    if (requests < 2) return;
    log(
      `  助手回复：${(sessionManager.getView(session.id)?.messages ?? [])
        .filter((message) => message.role === "assistant")
        .map((message) => message.text.slice(0, 24))
        .join(" | ")}`,
    );

    const before = viewTexts();
    push("前置：压缩前两轮的标记都在视图里", before.some((t) => t.includes(OLD_MARK)) && before.some((t) => t.includes(NEW_MARK)));
    // 手动压缩那条路要被真正走到：压缩卡必须**由下面这次调用**产生，
    // 否则「卡出现了」可能只是自动压缩的功劳（判据落在因果上，不落在有无上）
    const cardsBefore = (sessionManager.getView(session.id)?.messages ?? []).filter(
      (message) => message.compaction === true,
    ).length;
    push("前置：这两轮没有触发自动压缩（压缩卡只能来自下面这次手动调用）", cardsBefore === 0);
    if (cardsBefore !== 0) return;

    await run(
      `window.colt.invoke("session.compact", ${JSON.stringify({ sessionId: session.id })})`,
    );
    const compacted = await waitUntil(
      () => (sessionManager.getView(session.id)?.messages ?? []).some((m) => m.compaction === true),
      60_000,
    );
    push("前置：压缩真的发生了（消息流里出现压缩卡）", compacted);

    const after = viewTexts();
    push("压缩前的历史仍在消息流里（界面历史 ≠ 模型上下文）", after.some((t) => t.includes(OLD_MARK)));
    push("近期消息也仍在（压缩只替换了模型上下文的那一段）", after.some((t) => t.includes(NEW_MARK)));

    const messages = sessionManager.getView(session.id)?.messages ?? [];
    const oldIndex = messages.findIndex((m) => m.text.includes(OLD_MARK));
    const cardIndex = messages.findIndex((m) => m.compaction === true);
    push(
      "顺序正确：旧消息在压缩卡之前（卡按时间顺序插在中间，不是把历史挪走）",
      oldIndex >= 0 && cardIndex >= 0 && oldIndex < cardIndex,
    );
    log(`  模型请求总数：${requests}`);
  } finally {
    const pid = sessionManager.workerPidForSmoke(session.id);
    if (pid !== undefined) {
      try {
        process.kill(pid);
      } catch {
        // 已经没了
      }
    }
    sessionManager.close(session.id);
    await run(
      `window.colt.invoke("providers.remove", ${JSON.stringify({ id: PROVIDER_ID })}).catch(() => undefined)`,
    ).catch(() => undefined);
    // 把用户原来的压缩配置还回去（这个冒烟改的是全局设置）
    if (previous !== undefined) {
      await run(
        `window.colt.invoke("compaction.config.set", ${JSON.stringify({ config: previous.config })})`,
      ).catch(() => undefined);
    }
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const failed = checks.filter(([, ok]) => !ok);
    log(`通过 ${checks.length - failed.length}/${checks.length}`);
  }
}
