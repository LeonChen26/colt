// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 冒烟模式：fork
 *
 * 验「从这里分叉」的产品语义：**产出一条新会话，源会话一个字节都不动**。
 *
 * 为什么需要它：dock 模式把 `sessionManager.fork` 打桩成「只记账」——那验的是渲染层
 * 交出的是哪个 id；而复制库快照、新 worker 在副本里 fork、源库不被改，整条链路只有
 * 真跑一遍才知道。存储层前提（WAL 进副本、副本里同一条目 id 仍可分叉）由
 * `tests/session-fork.test.ts` 覆盖，这里补的是**编排**。
 *
 * 做法（免模型服务、不出网、不计费）：
 *  1. 本地起一个 OpenAI 兼容桩，把会话模型指过去；
 *  2. 真 worker 跑两轮问答；
 *  3. 用第一轮的最终回复 id 调 `session.fork`；
 *  4. 断言：新会话 id / `kernelSessionId` 是新的、历史只到目标轮；源会话行与源库不动，
 *     重新打开源会话两轮都还在。
 *
 * 判据全部来自主进程（`getSession` / `sessionManager.getView`），不看「函数被调用过」。
 */
import { app, type BrowserWindow } from "electron";
import { createServer, type ServerResponse } from "node:http";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SessionInfo } from "@shared/protocol";
import { createSession, getSession, upsertProject } from "../../../main/db/repo";
import { sessionManager } from "../../../main/session-manager";
import { sleep } from "../context";

const PROVIDER_ID = "smoke-fork";
const MODEL_ID = "smoke-model";
const MODEL_REF = `${PROVIDER_ID}/${MODEL_ID}`;
const FIRST = "FIRST-分叉前的第一问";
const SECOND = "SECOND-第二问";

export async function runFork(
  _window: BrowserWindow,
  log: (message: string) => void,
  run: <T>(expression: string) => Promise<T>,
): Promise<void> {
  const checks: [string, boolean][] = [];
  const push = (label: string, ok: boolean): void => {
    checks.push([label, ok]);
    log(`  ${ok ? "✓" : "✗"} ${label}`);
  };

  const fixtureDir = join(process.cwd(), "out", "smoke-fork");
  mkdirSync(fixtureDir, { recursive: true });
  const project = upsertProject(fixtureDir);
  const session = createSession(project.id, join(app.getPath("userData"), "sessions", project.id));
  log(`夹具项目：${fixtureDir}`);
  log(`源会话：${session.id}`);

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
    req.setEncoding("utf8");
    req.on("data", () => undefined);
    req.on("end", () => {
      requests += 1;
      const index = requests;
      const reply = (target: ServerResponse, text: string): void => {
        target.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        target.write(
          `data: ${JSON.stringify(
            chunk([{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }]),
          )}\n\n`,
        );
        target.write(
          `data: ${JSON.stringify(chunk([{ index: 0, delta: {}, finish_reason: "stop" }]))}\n\n`,
        );
        target.write("data: [DONE]\n\n");
        target.end();
      };
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
  const textsOf = (sessionId: string): string[] =>
    (sessionManager.getView(sessionId)?.messages ?? []).map((message) => message.text);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  if (port === 0) throw new Error("模型桩服务没有拿到监听端口");
  log(`模型桩：http://127.0.0.1:${port}/v1`);

  let forked: SessionInfo | undefined;
  try {
    await run(
      `window.colt.invoke("providers.save", ${JSON.stringify({
        id: PROVIDER_ID,
        name: "分叉冒烟（本地桩）",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        models: [{ id: MODEL_ID, name: "冒烟桩模型", contextWindow: 200_000 }],
        requiresKey: false,
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

    // 渲染层会抢先自动打开「当前项目」的第一条会话，模型由先到者定——显式收口，
    // 绝不带着真模型往下发 prompt（与 compaction-history 同一条竞态处理）。
    // 同时走 `session.setModel`（用户在选择器里选模型走的就是这条）：它会把模型**落库**，
    // 分叉时新会话的 modelRef 才有东西可继承；只靠 `session.open` 传模型是不落库的。
    await run(
      `window.colt.invoke("session.setModel", ${JSON.stringify({
        sessionId: session.id,
        providerId: PROVIDER_ID,
        modelId: MODEL_ID,
      })})`,
    );
    const boundModel = sessionManager.getView(session.id)?.model;
    push(`前置：会话模型指向本地桩且已落库（实际 ${boundModel ?? "?"}）`, boundModel === MODEL_REF);
    if (boundModel !== MODEL_REF) return;

    for (const text of [FIRST, SECOND]) {
      await run(
        `window.colt.invoke("session.prompt", ${JSON.stringify({ sessionId: session.id, text })})`,
      );
    }
    const answered = await waitUntil(() => {
      const view = sessionManager.getView(session.id);
      if (view === undefined || view.running || view.queuedCount > 0) return false;
      return view.messages.filter((message) => message.role === "assistant").length >= 2;
    }, 60_000);
    push("前置：两轮问答都跑完了", answered);
    push("前置：两次请求都打到本地桩（不是真模型）", requests >= 2);
    if (!answered || requests < 2) return;

    const sourceBefore = getSession(session.id);
    if (sourceBefore === undefined) return;
    const sourceMessages = sessionManager.getView(session.id)?.messages ?? [];
    const firstAnswer = sourceMessages.find((message) => message.role === "assistant");
    push(
      "前置：源会话里有两条提问、两条回复",
      sourceMessages.filter((m) => m.role === "user").length === 2 &&
        sourceMessages.filter((m) => m.role === "assistant").length === 2,
    );
    if (firstAnswer === undefined) return;

    const sessionsRoot = join(app.getPath("userData"), "sessions");
    const sourceDb = join(sessionsRoot, `durable-${session.id}.db`);
    push("前置：源库文件在", existsSync(sourceDb));

    // 走真实 IPC（渲染层点按钮走的就是这条），目标 id 取第一轮的最终回复
    const response = await run<{ session: SessionInfo }>(
      `window.colt.invoke("session.fork", ${JSON.stringify({
        sessionId: session.id,
        targetId: firstAnswer.id,
      })})`,
    );
    forked = response.session;
    log(`新会话：${forked.id}（标题「${forked.title}」，消息数 ${forked.messageCount}）`);

    push("分叉产出的是**另一条会话**", forked.id !== session.id);
    push(
      "新会话与源会话同项目、同工作目录、同模型",
      forked.projectId === project.id &&
        forked.cwd === sourceBefore.cwd &&
        forked.modelRef === MODEL_REF,
    );
    push(
      "新会话有自己的内核对话 id（不是源对话的续接）",
      forked.kernelSessionId !== null &&
        forked.kernelSessionId !== sourceBefore.kernelSessionId,
    );
    push(
      "新会话的库是独立文件",
      existsSync(join(sessionsRoot, `durable-${forked.id}.db`)),
    );

    const forkedReady = await waitUntil(
      () => sessionManager.getView(forked!.id) !== undefined,
      15_000,
    );
    push("前置：新会话的第一份视图到了", forkedReady);
    const forkedTexts = textsOf(forked.id);
    const forkedUsers = (sessionManager.getView(forked.id)?.messages ?? []).filter(
      (message) => message.role === "user",
    );
    log(`  新会话消息：${forkedTexts.map((text) => text.slice(0, 16)).join(" | ") || "（空）"}`);
    push("新会话的历史只到目标轮：只有第一问", forkedUsers.length === 1 && forkedUsers[0]?.text === FIRST);
    push(
      "目标轮（第一轮最终回复）本身在分叉里",
      forkedTexts.some((text) => text.includes("第 1 次回答")),
    );
    push("第二问没有被复制过去", !forkedTexts.some((text) => text.includes(SECOND)));

    const sourceAfter = getSession(session.id);
    push(
      "源会话行没被动过（内核对话 id 与消息数都不变）",
      sourceAfter !== undefined &&
        sourceAfter.kernelSessionId === sourceBefore.kernelSessionId &&
        sourceAfter.messageCount === sourceBefore.messageCount,
    );
    push("源库文件仍然在", existsSync(sourceDb));

    // 重新打开源会话：库真的没被 fork 截断，两轮都还在
    await run(`window.colt.invoke("session.open", ${JSON.stringify({ sessionId: session.id })})`);
    const reopened = await waitUntil(() => textsOf(session.id).length >= 4, 20_000);
    push("切回源会话：两轮历史完整（分叉没有截断它）", reopened);
    push(
      "源会话重新打开后内核对话 id 仍是原来那条",
      getSession(session.id)?.kernelSessionId === sourceBefore.kernelSessionId,
    );
  } finally {
    for (const id of [session.id, forked?.id]) {
      if (id === undefined) continue;
      const pid = sessionManager.workerPidForSmoke(id);
      if (pid !== undefined) {
        try {
          process.kill(pid);
        } catch {
          // 已经没了
        }
      }
      sessionManager.close(id);
    }
    await run(
      `window.colt.invoke("providers.remove", ${JSON.stringify({ id: PROVIDER_ID })}).catch(() => undefined)`,
    ).catch(() => undefined);
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const failed = checks.filter(([, ok]) => !ok);
    log(`通过 ${checks.length - failed.length}/${checks.length}`);
  }
}
