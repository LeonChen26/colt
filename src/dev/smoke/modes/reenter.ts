/**
 * 冒烟模式：reenter
 *
 * 由 scripts/split-smoke.mjs 从 src/dev/smoke/index.ts 逐字切出，内容与拆分前一致。
 */
import { BrowserWindow } from "electron";
import { createSession } from "../../../main/db/repo";
import { sleep } from "../context";

/**
 * 切会话回挂冒烟：复现「运行中的会话切走再切回后卡在『正在启动会话进程…』」。
 * 步骤：建长任务会话 → 让它跑起来 → 切到另一个会话 → 再切回来 →
 * 轮询界面上的启动提示是否在合理时间内消失。
 */
export async function runReenter(
  window: BrowserWindow,
  projectId: string,
  sessionsDir: string,
  log: (message: string) => void,
  run: <T>(expression: string) => Promise<T>,
): Promise<void> {
  const busy = createSession(projectId, sessionsDir);
  const other = createSession(projectId, sessionsDir);
  log(`长任务会话：${busy.id}`);
  log(`对照会话：${other.id}`);

  window.reload();
  await sleep(4000);

  // 让 busy 会话真正跑起来（带工具调用，耗时较长），模拟「分析当前项目」
  log("打开长任务会话…");
  await run(
    `window.colt.invoke("session.open", ${JSON.stringify({ sessionId: busy.id, cwd: process.env.COLT_SMOKE_CWD })})`,
  );
  log("让长任务会话开工…");
  await run(
    `window.colt.invoke("session.prompt", ${JSON.stringify({ sessionId: busy.id, text: "分析当前项目：先 ls 列出顶层目录，再读取 package.json，用一句话总结这是什么项目。" })})`,
  );
  await sleep(3000);

  /** 读取界面上的启动提示文本（Conversation 的 opening 态） */
  const startupText = `(() => {
    const el = [...document.querySelectorAll("div")]
      .find((d) => d.textContent && d.textContent.includes("正在启动会话进程"));
    return el ? el.textContent.trim().slice(0, 40) : null;
  })()`;

  const clickSession = (title: string): string =>
    `(() => {
      const b = [...document.querySelectorAll("button")]
        .find((x) => x.textContent && x.textContent.includes(${JSON.stringify(title)}));
      if (b) b.click();
      return b !== undefined;
    })()`;

  // 切走：点对照会话（它没有历史，标题是「新会话」或空）
  log("切到对照会话…");
  const switched = await run<boolean>(
    `(() => {
      const rows = [...document.querySelectorAll("aside button")]
        .filter((b) => b.textContent.includes("新会话") || b.textContent.includes("分析当前项目"));
      // 选一个与当前不同的
      const target = rows[rows.length - 1];
      if (target) target.click();
      return rows.length;
    })()`,
  );
  log(`侧栏候选会话数：${switched}`);
  await sleep(1500);

  // 切回 busy 会话：按首条用户消息标题点击
  log("切回长任务会话…");
  const back = await run<boolean>(clickSession("分析当前项目"));
  log(`点回长任务会话：${back}`);

  // 轮询启动提示是否消失
  const deadline = Date.now() + 60000;
  let clearedAt = -1;
  let lastSeen: string | null = null;
  while (Date.now() < deadline) {
    const text = await run<string | null>(startupText);
    if (text === null) {
      clearedAt = Date.now();
      break;
    }
    lastSeen = text;
    await sleep(1000);
  }

  if (clearedAt > 0) {
    log(`启动提示已清掉（耗时约 ${Math.round((clearedAt - (deadline - 60000)) / 1000)}s）`);
  } else {
    log(`启动提示一直未消失，最后看到：${JSON.stringify(lastSeen)}`);
  }

  const view = await run<{ running: boolean; messages: unknown[] } | null>(
    `window.colt.invoke("session.view", ${JSON.stringify({ sessionId: busy.id })})`,
  );
  log(`长任务会话视图：running=${view?.running}，消息数=${view?.messages.length ?? 0}`);
}

/**
 * 审批模式冒烟：验证三条路径
 *   1. 只读命令自动放行，不弹审批
 *   2. 写入类操作被拦下，出现待审条目
 *   3. 用户批准后工具真的执行，文件真的改动
 */
