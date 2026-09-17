/**
 * 冒烟模式：approval
 *
 * 由 scripts/split-smoke.mjs 从 src/dev/smoke/index.ts 逐字切出，内容与拆分前一致。
 */
import { BrowserWindow } from "electron";
import { writeFile } from "node:fs/promises";
import { createSession } from "../../../main/db/repo";
import { sleep, activeOutputPath } from "../context";

/**
 * 审批模式冒烟：验证三条路径
 *   1. 只读命令自动放行，不弹审批
 *   2. 写入类操作被拦下，出现待审条目
 *   3. 用户批准后工具真的执行，文件真的改动
 */
export async function runApproval(
  window: BrowserWindow,
  projectId: string,
  sessionsDir: string,
  log: (message: string) => void,
  run: <T>(expression: string) => Promise<T>,
): Promise<void> {
  /**
   * 轮询等待待审条目出现。
   * 不用固定 sleep：模型响应快慢不定，赌时长会造成假阴性，
   * 把测试自身的不稳定误当成产品缺陷。
   */
  const waitForPending = async (sessionId: string, timeoutMs: number): Promise<number> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const list = await run<unknown[]>(
        `window.colt.invoke("approval.list", ${JSON.stringify({ sessionId })})`,
      );
      if (list.length > 0) return list.length;
      if (Date.now() > deadline) return 0;
      await sleep(1000);
    }
  };

  /** 列出当前会话调用过的工具名，用于区分「模型没调工具」与「调用未被拦」 */
  const toolTrail = async (sessionId: string): Promise<string> => {
    const view = await run<{ messages: { role: string; toolCalls?: { name: string }[] }[] } | null>(
      `window.colt.invoke("session.view", ${JSON.stringify({ sessionId })})`,
    );
    const names = (view?.messages ?? []).flatMap((message) =>
      (message.toolCalls ?? []).map((call) => call.name),
    );
    return names.length > 0 ? names.join(",") : "（无）";
  };

  const session = createSession(projectId, sessionsDir);
  log(`会话：${session.id}`);

  window.reload();
  await sleep(4000);

  // 冒烟自检：确认渲染层真的挂上了，而不是一片空白
  const dom = await run<string>(
    `JSON.stringify({ root: document.getElementById("root")?.children.length ?? -1, text: document.body.innerText.slice(0, 120) })`,
  );
  log(`  DOM 自检：${dom}`);
  await run(
    `window.colt.invoke("session.open", ${JSON.stringify({ sessionId: session.id, cwd: process.env.COLT_SMOKE_CWD })})`,
  );

  // ---- 场景一：只读命令应当自动放行 ----
  log("[场景1] 只读命令 ls，预期自动放行");
  await run(
    `window.colt.invoke("session.prompt", ${JSON.stringify({
      sessionId: session.id,
      text: "用 bash 运行 ls -la，只要列目录，不要做别的",
    })})`,
  );
  await sleep(25000);
  const pendingAfterRead = await run<unknown[]>(
    `window.colt.invoke("approval.list", ${JSON.stringify({ sessionId: session.id })})`,
  );
  log(`  待审条目：${pendingAfterRead.length}（预期 0）`);

  // ---- 场景二：写入应当被拦下 ----
  log("[场景2] 写入 demo.md，预期出现待审");
  await run(
    `window.colt.invoke("session.prompt", ${JSON.stringify({
      sessionId: session.id,
      text: "把 demo.md 末尾追加一行「审批测试」，用 edit 工具",
    })})`,
  );
  const count = await waitForPending(session.id, 60000);

  const pending = await run<{ toolCallId: string; toolName: string; summary: string; risk: string; reason: string }[]>(
    `window.colt.invoke("approval.list", ${JSON.stringify({ sessionId: session.id })})`,
  );
  log(`  待审条目：${pending.length}（预期 1）`);
  for (const item of pending) {
    log(`  - ${item.toolName} [${item.risk}] ${item.summary} :: ${item.reason}`);
  }

  if (count === 0) {
    // 区分「模型没调 edit」（测试时序）与「调了但未被拦」（产品缺陷）
    log(`  工具调用轨迹：${await toolTrail(session.id)}`);
    log("  未拦截到写入，审批链路异常");
    return;
  }

  // ---- 场景三：批准后工具应真的执行 ----
  // 先截一张待审状态的图，处置后卡片就消失了
  const pendingShot = activeOutputPath.replace(/\.png$/, "-pending.png");
  if (pendingShot) {
    const image = await window.capturePage();
    await writeFile(pendingShot, image.toPNG());
    log(`  待审截图：${pendingShot}`);
  }

  log("[场景3] 批准该调用，预期文件真的被改");
  await run(
    `window.colt.invoke("approval.resolve", ${JSON.stringify({
      sessionId: session.id,
      toolCallId: pending[0]!.toolCallId,
      approved: true,
    })})`,
  );
  await sleep(20000);

  const view = await run<{ fileChanges: { kind: string; path: string; addedLines: number }[] } | null>(
    `window.colt.invoke("session.view", ${JSON.stringify({ sessionId: session.id })})`,
  );
  log(`  文件改动：${view?.fileChanges.length ?? 0} 项（预期 >=1）`);
  for (const change of view?.fileChanges ?? []) {
    log(`  - ${change.kind} ${change.path} +${change.addedLines}`);
  }

  const left = await run<unknown[]>(
    `window.colt.invoke("approval.list", ${JSON.stringify({ sessionId: session.id })})`,
  );
  log(`  处置后待审：${left.length}（预期 0）`);

  // ---- 场景四：拒绝后模型应知悉并继续对话，不能卡死 ----
  log("[场景4] 再次写入并拒绝，预期文件不变、对话继续");
  const changesBefore = view?.fileChanges.length ?? 0;
  await run(
    `window.colt.invoke("session.prompt", ${JSON.stringify({
      sessionId: session.id,
      text: "再把 demo.md 末尾追加一行「第二次追加」，用 edit 工具",
    })})`,
  );
  const count2 = await waitForPending(session.id, 60000);

  const pending2 = await run<{ toolCallId: string }[]>(
    `window.colt.invoke("approval.list", ${JSON.stringify({ sessionId: session.id })})`,
  );
  log(`  待审条目：${pending2.length}（预期 1）`);
  if (count2 > 0 && pending2.length > 0) {
    await run(
      `window.colt.invoke("approval.resolve", ${JSON.stringify({
        sessionId: session.id,
        toolCallId: "__PLACEHOLDER__",
        approved: false,
      })})`.replace("__PLACEHOLDER__", pending2[0]!.toolCallId),
    );
    await sleep(20000);

    const after = await run<{
      fileChanges: unknown[];
      messages: { role: string; text: string }[];
      running: boolean;
    } | null>(`window.colt.invoke("session.view", ${JSON.stringify({ sessionId: session.id })})`);
    log(`  拒绝后文件改动：${after?.fileChanges.length ?? 0}（预期仍为 ${changesBefore}）`);
    log(`  会话运行中：${after?.running}（预期 false，说明未卡死）`);
    const last = after?.messages.at(-1);
    log(`  末条消息[${last?.role}]：${(last?.text ?? "").slice(0, 80)}`);
  } else {
    log(`  未拦截到写入，工具调用轨迹：${await toolTrail(session.id)}`);
  }
}

/**
 * 宿主能力冒烟：真实验证「审批闸门 → toolRpc → BrowserHost / ComputerHost → 结果投影」全链路。
 *
 * 刻意保持默认的 approval 审批模式，由本流程轮询待审并自动批准，
 * 从而把风险分级、签名、放行/回执这些环节一并覆盖，而不是绕过它们。
 */
