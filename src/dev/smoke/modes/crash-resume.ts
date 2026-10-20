// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 冒烟模式：crash-resume
 *
 * durable 崩溃恢复的**应用层**验证（免模型服务、不出网、不计费）。
 *
 * 与 `tests/durable-crash-recovery.test.ts` 的分工：那份用例在**库这一层**证明
 * 「重开同一个 SQLite 库 → 未完成的 submission 接着跑、safe 工具重跑、unsafe 工具留 interrupted」；
 * 这条补的是它够不到的那一段——**主进程 + 真实 worker 进程**：
 *
 *  1. 会话真的跑在一个 `utilityProcess` 里，我们在**模型请求飞行中**把它强杀（不是优雅 dispose）；
 *  2. 重开同一会话时，主进程按库里的 `kernelSessionId` 起新 worker，durable `resume()` 把
 *     崩溃时未完成的**生成任务**接着跑（不需要用户重发消息）；
 *  3. 续跑的那一轮里模型调用 `read`，工具真的执行、结果真的回到模型（工具层在恢复后仍然可用）；
 *  4. 最终答复落到主进程视图，且**提问只有一条**（重开没有重复落一条用户消息）。
 *
 * 模型由本文件里一个 OpenAI-compatible 的本地桩提供：`/v1/chat/completions` 用 SSE 回脚本化的
 * 响应。第一条请求**故意不回复**——那就是「飞行中」的现场；强杀之后新 worker 会再发一次，
 * 第二次回 `read` 工具调用、第三次回最终答复。判据一律是**桩服务收到的真实请求**
 * 与主进程视图，而不是「函数被调用过」。
 */
import { app, type BrowserWindow } from "electron";
import { createServer, type ServerResponse } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSession, upsertProject } from "../../../main/db/repo";
import { sessionManager } from "../../../main/session-manager";
import { sleep } from "../context";

const PROVIDER_ID = "smoke-crash-resume";
const MODEL_ID = "smoke-model";
const MODEL_REF = `${PROVIDER_ID}/${MODEL_ID}`;
const FIXTURE_TEXT = "CRASH-RESUME-FIXTURE-CONTENT";
const PROMPT = "读一下 target.txt，然后告诉我读到了什么。";
const ANSWER = "RECOVERED-OK";

/** 桩服务收到的一次请求（只取要断言的那部分，不引 pi-ai 的类型） */
interface ModelRequest {
  messages?: { role?: string; content?: unknown }[];
}

export async function runCrashResume(
  _window: BrowserWindow,
  log: (message: string) => void,
  run: <T>(expression: string) => Promise<T>,
): Promise<void> {
  const checks: [string, boolean][] = [];
  const push = (label: string, ok: boolean): void => {
    checks.push([label, ok]);
    log(`  ${ok ? "✓" : "✗"} ${label}`);
  };

  const fixtureDir = join(process.cwd(), "out", "smoke-crash-resume-fixture");
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(join(fixtureDir, "target.txt"), `${FIXTURE_TEXT}\n`, "utf8");
  const project = upsertProject(fixtureDir);
  const session = createSession(project.id, join(app.getPath("userData"), "sessions", project.id));
  log(`夹具项目：${fixtureDir}`);
  log(`会话：${session.id}`);

  const requests: ModelRequest[] = [];
  const chunk = (choices: unknown[]): Record<string, unknown> => ({
    id: "chatcmpl-smoke",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: MODEL_ID,
    choices,
  });
  const sse = (res: ServerResponse, chunks: Record<string, unknown>[]): void => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    for (const item of chunks) res.write(`data: ${JSON.stringify(item)}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  };
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };

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
      let parsed: ModelRequest = {};
      try {
        parsed = JSON.parse(body) as ModelRequest;
      } catch {
        // 桩服务不关心解析失败：下面按序号回脚本，请求体只用来做断言
      }
      requests.push(parsed);
      const index = requests.length;
      log(`  模型请求 #${index} 到达`);
      // #1 故意挂住：不写响应、也不结束——这条请求就是「崩溃时飞行中的任务」
      if (index === 1) return;
      if (index === 2) {
        sse(res, [
          chunk([
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_read_1",
                    type: "function",
                    function: { name: "read", arguments: JSON.stringify({ path: "target.txt" }) },
                  },
                ],
              },
              finish_reason: null,
            },
          ]),
          chunk([{ index: 0, delta: {}, finish_reason: "tool_calls" }]),
          { ...chunk([]), usage },
        ]);
        return;
      }
      sse(res, [
        chunk([{ index: 0, delta: { role: "assistant", content: ANSWER }, finish_reason: null }]),
        chunk([{ index: 0, delta: {}, finish_reason: "stop" }]),
        { ...chunk([]), usage },
      ]);
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
  const textOfRequest = (request: ModelRequest | undefined): string =>
    JSON.stringify(request?.messages ?? []);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  if (port === 0) throw new Error("模型桩服务没有拿到监听端口");
  log(`模型桩：http://127.0.0.1:${port}/v1`);

  try {
    // 免密钥的本地 provider：与用户配置隔离，跑完删掉（同 rm-workspace 的占位 provider）
    await run(
      `window.colt.invoke("providers.save", ${JSON.stringify({
        id: PROVIDER_ID,
        name: "崩溃恢复冒烟（本地桩）",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        models: [{ id: MODEL_ID, name: "冒烟桩模型", contextWindow: 8192 }],
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
    push("前置：真实 worker 已起来且拿得到 pid（否则「强杀」是空操作）", started);
    if (!started) return;

    await run(
      `window.colt.invoke("session.prompt", ${JSON.stringify({
        sessionId: session.id,
        text: PROMPT,
      })})`,
    );
    const firstArrived = await waitUntil(() => requests.length >= 1, 30_000);
    push("前置：第一条模型请求真的发出去了（「飞行中强杀」的前提成立）", firstArrived);
    push(
      "前置：那条请求里带着本次提问（模型确实在处理这件事）",
      firstArrived && textOfRequest(requests[0]).includes(PROMPT),
    );

    // 强杀：close() 走 dispose，验不到 resume，必须杀真实进程
    const pid = sessionManager.workerPidForSmoke(session.id);
    if (pid !== undefined) {
      try {
        process.kill(pid);
      } catch (error) {
        log(`  强杀失败：${String(error)}`);
      }
    }
    const died = await waitUntil(
      () => sessionManager.workerPidForSmoke(session.id) === undefined,
      15_000,
    );
    push("worker 真的没了（强杀生效，不是优雅 dispose）", died);

    // 重开同一会话：这是产品的恢复入口（侧栏报错文案承诺「再打开会自动重连恢复」）
    const reopened = await run<{ ok: boolean; message: string }>(
      `window.colt.invoke("session.open", ${JSON.stringify({
        sessionId: session.id,
        model: MODEL_REF,
      })})
         .then(() => ({ ok: true, message: "" }))
         .catch((error) => ({ ok: false, message: String(error && error.message) }))`,
    );
    push("重开同一会话成功（不需要用户重发消息）", reopened.ok);
    if (!reopened.ok) log(`  重开失败：${reopened.message}`);

    const secondArrived = await waitUntil(() => requests.length >= 2, 60_000);
    push("崩溃时未完成的生成任务在重开后自动续跑（第 2 条请求到达）", secondArrived);
    push(
      "续跑用的是原上下文（第 2 条请求里仍有那条提问）",
      secondArrived && textOfRequest(requests[1]).includes(PROMPT),
    );

    const toolRoundArrived = await waitUntil(() => requests.length >= 3, 60_000);
    push("模型要的 read 在恢复后真的执行了（第 3 条请求带着工具结果回来）", toolRoundArrived);
    push(
      "工具结果里是夹具文件的内容（不是空结果或错误占位）",
      toolRoundArrived && textOfRequest(requests[2]).includes(FIXTURE_TEXT),
    );

    const settled = await waitUntil(() => {
      const view = sessionManager.getView(session.id);
      return (
        view !== undefined &&
        !view.running &&
        view.messages.some((message) => message.role === "assistant" && message.text.includes(ANSWER))
      );
    }, 60_000);
    push("最终答复落到主进程视图（会话恢复后正常收尾）", settled);

    const view = sessionManager.getView(session.id);
    const userMessages =
      view?.messages.filter(
        (message) => message.role === "user" && message.text.includes(PROMPT),
      ) ?? [];
    push("提问只有一条（重开没有重复落一条用户消息）", userMessages.length === 1);
    log(`  模型请求总数：${requests.length}`);
  } finally {
    // 强行收尾：中途失败时 worker 可能还在跑，close() 对运行中的会话是空操作
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
    // 第一条请求的 socket 可能还挂着（worker 被杀后由对端关闭，但别赌它一定及时）：
    // 不主动断开，`close()` 会一直等这个连接，整个冒烟就卡在收尾里。
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    // 汇总放在 finally：中途提前返回 / 抛错时也要留下「跑了几条、过了几条」
    const failed = checks.filter(([, ok]) => !ok);
    log(`通过 ${checks.length - failed.length}/${checks.length}`);
  }
}
