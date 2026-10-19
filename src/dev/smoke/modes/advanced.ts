// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 冒烟模式：advanced
 *
 * 由 scripts/split-smoke.mjs 从 src/dev/smoke/index.ts 逐字切出，内容与拆分前一致。
 */
import { BrowserWindow } from "electron";
import { createSession } from "../../../main/db/repo";
import { sleep } from "../context";

/** 多会话并行 + 分支导航 */
export async function runAdvanced(
  window: BrowserWindow,
  projectId: string,
  sessionsDir: string,
  log: (message: string) => void,
  run: <T>(expression: string) => Promise<T>,
): Promise<void> {
  const first = createSession(projectId, sessionsDir);
  const second = createSession(projectId, sessionsDir);
  log(`会话 A：${first.id}`);
  log(`会话 B：${second.id}`);

  window.reload();
  await sleep(4000);

  // 两个会话同时开工，验证 worker 进程池并行
  log("并行发起两个会话…");
  const started = Date.now();
  // cwd 不再由调用方传入：主进程按 sessionId → 项目反查 rootPath（F1 修复，
  // 与 file.read 同一套信任假设）。夹具会话的项目根已在落库时登记（见下方 createSession 前）。
  await run(`Promise.all([
    window.colt.invoke("session.open", ${JSON.stringify({ sessionId: first.id })}),
    window.colt.invoke("session.open", ${JSON.stringify({ sessionId: second.id })})
  ])`);
  log(`两个 worker 就绪，耗时 ${Date.now() - started}ms`);

  await run(`Promise.all([
    window.colt.invoke("session.prompt", ${JSON.stringify({ sessionId: first.id, text: "说出数字 1，只回一个字" })}),
    window.colt.invoke("session.prompt", ${JSON.stringify({ sessionId: second.id, text: "说出数字 2，只回一个字" })})
  ])`);
  await sleep(25000);

  const viewA = await run<{ messages: { role: string; text: string }[] } | null>(
    `window.colt.invoke("session.view", ${JSON.stringify({ sessionId: first.id })})`,
  );
  const viewB = await run<{ messages: { role: string; text: string }[] } | null>(
    `window.colt.invoke("session.view", ${JSON.stringify({ sessionId: second.id })})`,
  );
  log(`会话 A 消息数：${viewA?.messages.length}，末条：${viewA?.messages.at(-1)?.text.slice(0, 40)}`);
  log(`会话 B 消息数：${viewB?.messages.length}，末条：${viewB?.messages.at(-1)?.text.slice(0, 40)}`);
}
