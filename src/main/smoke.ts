/**
 * 端到端冒烟
 * basic：建项目 → 建会话 → 真实对话 → 截图
 * advanced：多会话并行 → 分支查询 → navigateTree 分叉 → 截图
 * 作者：陕耀云栈WorkMate
 */
import { app, type BrowserWindow } from "electron";
import { writeFile } from "node:fs/promises";
import { upsertProject, createSession } from "./db/repo";
import { join } from "node:path";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function runSmoke(window: BrowserWindow, outputPath: string): Promise<void> {
  const log = (message: string): void => console.log(`[SMOKE] ${message}`);
  const run = <T>(expression: string): Promise<T> =>
    window.webContents.executeJavaScript(expression) as Promise<T>;

  try {
    const projectRoot = process.env.BANYAN_SMOKE_CWD ?? process.cwd();
    const project = upsertProject(projectRoot);
    log(`项目：${project.name} (${project.rootPath})`);

    const sessionsDir = join(app.getPath("userData"), "sessions", project.id);
    const advanced = process.env.BANYAN_SMOKE_MODE === "advanced";

    if (advanced) {
      await runAdvanced(window, project.id, sessionsDir, log, run);
    } else {
      await runBasic(window, sessionsDir, project.id, log, run);
    }

    const image = await window.capturePage();
    await writeFile(outputPath, image.toPNG());
    log(`截图：${outputPath}`);
    log("DONE");
  } catch (error) {
    console.error("[SMOKE] 失败", error);
  } finally {
    app.quit();
  }
}

async function runBasic(
  window: BrowserWindow,
  sessionsDir: string,
  projectId: string,
  log: (message: string) => void,
  run: <T>(expression: string) => Promise<T>,
): Promise<void> {
  const session = createSession(projectId, sessionsDir);
  log(`会话：${session.id}`);

  window.reload();
  await sleep(4000);

  const prompt = process.env.BANYAN_SMOKE_PROMPT ?? "用一句话介绍你自己。";
  log(`发送：${prompt}`);
  await run(
    `window.banyan.invoke("session.prompt", ${JSON.stringify({ sessionId: session.id, text: prompt })})`,
  );

  await sleep(Number(process.env.BANYAN_SMOKE_WAIT ?? 20000));

  // 展开工具卡片，让验收截图能看到实际输出
  // 注意：不能用「改动」字样匹配，会误中顶部导航标签
  await run(`(() => {
    const buttons = [...document.querySelectorAll("button")];
    buttons.filter((b) => /^\\s*(bash|edit|write|read)\\b/.test(b.textContent.trim()))
      .forEach((b) => b.click());
    return true;
  })()`);
  await sleep(800);

  // 可选：打开右侧某个面板（用量 / 工具），便于验收截图覆盖该面板
  const panel = process.env.BANYAN_SMOKE_PANEL;
  if (panel) {
    await run(`(() => {
      const target = ${JSON.stringify(panel)};
      const buttons = [...document.querySelectorAll("button")];
      const hit = buttons.find((b) => b.textContent.trim() === target);
      if (hit) hit.click();
      return hit !== undefined;
    })()`);
    await sleep(1200);
  }

  await report(session.id, log, run);
}

/** 多会话并行 + 分支导航 */
async function runAdvanced(
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
  await run(`Promise.all([
    window.banyan.invoke("session.open", ${JSON.stringify({ sessionId: first.id, cwd: process.env.BANYAN_SMOKE_CWD })}),
    window.banyan.invoke("session.open", ${JSON.stringify({ sessionId: second.id, cwd: process.env.BANYAN_SMOKE_CWD })})
  ])`);
  log(`两个 worker 就绪，耗时 ${Date.now() - started}ms`);

  await run(`Promise.all([
    window.banyan.invoke("session.prompt", ${JSON.stringify({ sessionId: first.id, text: "说出数字 1，只回一个字" })}),
    window.banyan.invoke("session.prompt", ${JSON.stringify({ sessionId: second.id, text: "说出数字 2，只回一个字" })})
  ])`);
  await sleep(25000);

  const viewA = await run<{ messages: { role: string; text: string }[] } | null>(
    `window.banyan.invoke("session.view", ${JSON.stringify({ sessionId: first.id })})`,
  );
  const viewB = await run<{ messages: { role: string; text: string }[] } | null>(
    `window.banyan.invoke("session.view", ${JSON.stringify({ sessionId: second.id })})`,
  );
  log(`会话 A 消息数：${viewA?.messages.length}，末条：${viewA?.messages.at(-1)?.text.slice(0, 40)}`);
  log(`会话 B 消息数：${viewB?.messages.length}，末条：${viewB?.messages.at(-1)?.text.slice(0, 40)}`);

  // 分支：在会话 A 再问一轮，然后跳回第一个用户节点形成分叉
  await run(
    `window.banyan.invoke("session.prompt", ${JSON.stringify({ sessionId: first.id, text: "再说出数字 3，只回一个字" })})`,
  );
  await sleep(20000);

  type Node = { id: string; kind: string; summary: string; isTip: boolean; onActivePath: boolean };
  const before = await run<Node[]>(
    `window.banyan.invoke("session.branches", ${JSON.stringify({ sessionId: first.id })})`,
  );
  log(`分支节点数（分叉前）：${before.length}`);
  for (const node of before) {
    log(`  ${node.isTip ? "→" : " "} [${node.kind}] ${node.summary.slice(0, 40)}`);
  }

  const target = before.find((node) => node.kind === "user");
  if (target) {
    log(`跳转到首个用户节点：${target.id}`);
    await run(
      `window.banyan.invoke("session.navigate", ${JSON.stringify({ sessionId: first.id, targetId: target.id })})`,
    );
    await sleep(4000);

    const mid = await run<{ running: boolean; messages: { role: string; text: string }[] } | null>(
      `window.banyan.invoke("session.view", ${JSON.stringify({ sessionId: first.id })})`,
    );
    log(`跳转后：running=${mid?.running}，消息数=${mid?.messages.length}`);

    // 跳转后再提问，应当形成新分支而不是覆盖原有记录
    await run(
      `window.banyan.invoke("session.prompt", ${JSON.stringify({ sessionId: first.id, text: "改说字母 X，只回一个字" })})`,
    );
    await sleep(25000);

    const post = await run<{ running: boolean; messages: { role: string; text: string }[] } | null>(
      `window.banyan.invoke("session.view", ${JSON.stringify({ sessionId: first.id })})`,
    );
    log(`新分支提问后：running=${post?.running}，消息数=${post?.messages.length}`);
    for (const message of post?.messages ?? []) {
      log(`    [${message.role}] ${message.text.slice(0, 40)}`);
    }

    const after = await run<Node[]>(
      `window.banyan.invoke("session.branches", ${JSON.stringify({ sessionId: first.id })})`,
    );
    log(`分支节点数（分叉后）：${after.length}`);
    log(`活跃路径节点数：${after.filter((node) => node.onActivePath).length}`);
    log(`离线分支节点数：${after.filter((node) => !node.onActivePath).length}`);
  }

  // 切到会话 A 并打开分支面板，让验收截图能看到分叉结构
  await run(`(() => {
    const items = [...document.querySelectorAll("button")];
    items.find((b) => b.textContent.includes("说出数字 1"))?.click();
    return true;
  })()`);
  await sleep(2500);
  await run(`(() => {
    const buttons = [...document.querySelectorAll("button")];
    buttons.find((b) => b.textContent.trim() === "分支")?.click();
    return true;
  })()`);
  await sleep(1500);
}

async function report(
  sessionId: string,
  log: (message: string) => void,
  run: <T>(expression: string) => Promise<T>,
): Promise<void> {
  const view = await run<{
    messages: { role: string; text: string; toolCalls: { name: string; args: string }[] }[];
    fileChanges: { path: string; kind: string; addedLines: number; removedLines: number; patch: string | null }[];
    stats: { totalTokens: number; costUsd: number };
    running: boolean;
  } | null>(`window.banyan.invoke("session.view", ${JSON.stringify({ sessionId })})`);

  if (!view) {
    log("未取得会话视图");
    return;
  }

  log(`消息数：${view.messages.length}，运行中：${view.running}`);
  for (const message of view.messages) {
    const calls = message.toolCalls.map((call) => `${call.name}(${call.args})`).join(" ");
    log(`  [${message.role}] ${message.text.slice(0, 100)}${calls ? ` → ${calls.slice(0, 120)}` : ""}`);
  }
  log(`文件改动：${view.fileChanges.length} 项`);
  for (const change of view.fileChanges) {
    log(`  ${change.kind} ${change.path} +${change.addedLines} -${change.removedLines} patch=${change.patch ? "有" : "无"}`);
  }
  log(`用量：${view.stats.totalTokens} tokens / $${view.stats.costUsd}`);
}
