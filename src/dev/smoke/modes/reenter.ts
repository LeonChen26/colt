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
  // cwd 是 `session.open` 的**必填**项，JSON.stringify 会抹掉 undefined；
  // 漏填时 worker 拿 undefined 去调内核路径解析，报出与现场无关的
  // `undefined.startsWith`（见 AGENTS.md §五「环境前提必须显式建立」）。
  await run(
    `window.colt.invoke("session.open", ${JSON.stringify({ sessionId: busy.id, cwd: process.env.COLT_SMOKE_CWD ?? process.cwd() })})`,
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

  // ---- 回收体验（2026-09-18）：切走不再杀 worker + 切回立刻见历史 ----
  const checks: [string, boolean][] = [];
  const clickRow = (id: string): string =>
    `(() => { const el = document.querySelector('[data-session-row="${id}"] button'); if (el) el.click(); return el !== null; })()`;

  // 判据一：切走再切回**空闲**会话应复用同一 worker，而不是重启。
  // 信号取 `session.status` 的 idle：主进程只在 worker 真的发回 ready（= 新进程）时才广播，
  // 复用分支（`#spawnWorker` 命中 existing）压根不走那段。所以「切回后 idle 计数没涨」= 没重启。
  // 没有这条断言，卸载时那句 `session.close` 被谁加回来都不会有人发现。
  // 先把对照会话的 worker 关掉，让状态归零：紧跟的 open 就必定是**新进程**、必定广播 idle。
  // 反过来做会假绿——第一版没关，worker 早就存在，计数 0 → 0 也照样「通过」。
  await run(`window.colt.invoke("session.close", ${JSON.stringify({ sessionId: other.id })})`);
  await run(`(() => {
    window.__coltIdle = window.__coltIdle ?? {};
    if (!window.__coltIdleWatch) {
      window.__coltIdleWatch = true;
      window.colt.on("session.status", (s) => {
        if (s.state === "idle") window.__coltIdle[s.sessionId] = (window.__coltIdle[s.sessionId] ?? 0) + 1;
      });
    }
    return true;
  })()`);
  const otherCwd = process.env.COLT_SMOKE_CWD ?? process.cwd();
  await run(
    `window.colt.invoke("session.open", ${JSON.stringify({ sessionId: other.id, cwd: otherCwd })})`,
  );
  await sleep(1200);
  const idleBefore = await run<number>(`window.__coltIdle["${other.id}"] ?? 0`);
  // 点击要留证据：行没找到 / 点了没生效时，「没重启」同样会假绿——因为压根没切走。
  const hitOther1 = await run<boolean>(clickRow(other.id));
  await sleep(1200);
  const hitBusy = await run<boolean>(clickRow(busy.id));
  await sleep(1200);
  const hitOther2 = await run<boolean>(clickRow(other.id));
  await sleep(1500);
  const idleAfter = await run<number>(`window.__coltIdle["${other.id}"] ?? 0`);
  // 先证「信号是活的」再证「没重启」：少了前一条，事件压根没送达时 0 === 0 会**假绿**。
  checks.push([`回收信号可用：空闲会话开进程时确实收到过 idle（计数=${idleBefore}）`, idleBefore >= 1]);
  checks.push([
    "三次切换都真的点中了侧栏行（否则「没重启」是因为压根没切走）",
    hitOther1 && hitBusy && hitOther2,
  ]);
  checks.push([
    `切走再切回空闲会话不重启 worker（idle 计数 ${idleBefore} → ${idleAfter}，应不变）`,
    idleAfter === idleBefore,
  ]);

  // 判据二：切回**有历史**的会话时，挂载那一刻就画得出内容（渲染层缓存），不必干等 worker 重推。
  // 点击与读取放进**同一次** executeJavaScript：React 对离散事件同步刷新，读之前只让出一个
  // 微任务（IPC 推视图是宏任务，插不进来），所以拿到的必然是「挂载时立刻画出来的东西」。
  // 没有缓存时这里只有转圈——那正是原先的白屏。
  const cacheHit = await run<boolean>(`(async () => {
    const el = document.querySelector('[data-session-row="${busy.id}"] button');
    if (!el) return false;
    el.click();
    await Promise.resolve();
    const area = document.querySelector("[data-conv-scroll]");
    return area !== null && area.innerText.includes("分析当前项目");
  })()`);
  checks.push(["切回有历史的会话立刻出内容（渲染层缓存生效，不必干等重放）", cacheHit]);

  // ---- 钉住（2026-09-18）：把「别自动回收」这个决定交回用户 ----
  // 空闲回收是「60 秒一跳、超时 30 分钟」，冒烟里等不到那一刻——**回收规则本身**由
  // tests/worker-pool.test.ts 那组纯函数单测钉死。这里只验入口这一段：图钉点了确实有变化、
  // 且真的写回了主进程。不在这里验「它拦住了回收」：那要等 30 分钟或凑满 6 个 worker，
  // 冒烟里做不到；但「按钮在、点得动、状态回读得到」是这条链路唯一没被单测盖住的一段。
  const pinSel = `[data-session-row="${other.id}"] button[aria-label="钉住会话"]`;
  const unpinSel = `[data-session-row="${other.id}"] button[aria-label="取消钉住"]`;
  // 小目标入口（20px 图标）必须确认「真的落在可视区、且那一层就是它」：
  // 只查 DOM 里存在会假绿——窄栏下它可能被顶出窗口右边，`el.click()` 照样"命中"（见 AGENTS.md §五 ⑥）。
  const hitTest = (sel: string): string =>
    `(() => {
      const el = document.querySelector('${sel}');
      if (!el) return "missing";
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return "zero-size";
      if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) return "offscreen";
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return el === hit || el.contains(hit) ? "ok" : "blocked";
    })()`;

  const pinHit = await run<string>(hitTest(pinSel));
  const pinClick = await run<boolean>(
    `(() => { const el = document.querySelector('${pinSel}'); if (el) el.click(); return el !== null; })()`,
  );
  await sleep(400);
  const pinnedAttr = await run<boolean>(
    `document.querySelector('${unpinSel}')?.getAttribute("aria-pressed") === "true"`,
  );
  const pinnedList = await run<string[]>(`window.colt.invoke("session.listPinned", undefined)`);
  // 再点一次取消：只验「设得上去」不验「能撤下来」，会把「toggle 只会置位」这类 bug 放过去
  const unpinClick = await run<boolean>(
    `(() => { const el = document.querySelector('${unpinSel}'); if (el) el.click(); return el !== null; })()`,
  );
  await sleep(400);
  const unpinnedAttr = await run<boolean>(
    `document.querySelector('${pinSel}')?.getAttribute("aria-pressed") === "false"`,
  );
  const unpinnedList = await run<string[]>(`window.colt.invoke("session.listPinned", undefined)`);

  checks.push([`图钉入口可见且点得到（命中=${pinHit}）`, pinHit === "ok" && pinClick]);
  checks.push(["点图钉后按钮显示为已钉住（aria-pressed=true）", pinnedAttr]);
  checks.push(["点图钉后主进程回读得到该会话（listPinned 含有它）", pinnedList.includes(other.id)]);
  checks.push([
    "再点一次能取消钉住（按钮与主进程都复位）",
    unpinClick && unpinnedAttr && !unpinnedList.includes(other.id),
  ]);

  for (const [name, ok] of checks) log(`  ${ok ? "✓" : "✗"} ${name}`);
  log(`通过 ${checks.filter(([, ok]) => ok).length}/${checks.length}`);
}

/**
 * 审批模式冒烟：验证三条路径
 *   1. 只读命令自动放行，不弹审批
 *   2. 写入类操作被拦下，出现待审条目
 *   3. 用户批准后工具真的执行，文件真的改动
 */
