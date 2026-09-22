// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 冒烟模式：rm-workspace
 *
 * 「移除工作区」（规则 ③-D）的端到端验证，三段：
 *
 * 1. **运行中 → 整次移除被拒绝**。这条判据要一个 `sessionManager.isRunning() === true`
 *    的会话，而那个状态的**唯一真源**是 worker 发来的 `view.running`（`session-manager.ts`
 *    的 `case "view"`）——没有任何公开钩子能直接置位；`dock` 那种「推受控视图」只改渲染层
 *    手里那份，主进程侧仍是 false（所以 dock 里根本验不到）。让真 worker 跑起来又要真调模型
 *    （计费 + 依赖这台机器上恰好配了可用密钥），于是挂 `scripts/running-worker.cjs`——
 *    假 worker：发 ready 后立刻声明「我在跑」，收到 abort 再声明「跑完了」。
 *
 * 2. **假 worker 对「别人的会话」零写入**。渲染层挂载时会自动打开当前项目的第一条会话，
 *    那条很可能就是**用户的真实会话**；假 worker 若照发 ready + view，就会把假的
 *    kernelSessionId 与假的标题写进用户数据（见 running-worker.cjs 文件头）。这条用一段
 *    **不含归属标记**的靶子把那条路故意走一遍，断言「open 直接失败 + 靶子一字未动」。
 *
 * 3. **界面链路**（这一段与假 worker 无关，**永远跑**）：点侧栏那个入口 → 原生确认框 →
 *    后端 → 侧栏跟着变。前两段都走 IPC，验不到渲染层那 60 行状态收尾（列表 / 展开态 /
 *    选中项目切换 / 草稿丢弃），而「点了到底有没有反应」正是最容易出错的地方。
 *    原生确认框会阻塞自动化，故把 `dialog.showMessageBox` 打桩成「点了确认」。
 *
 * 前提自己建立（AGENTS §五⑬）：靶子项目都用**本模式自己的目录**（归属标记在路径里）、
 * 临时「免密钥」provider，不碰本机既有配置，也不产生计费（假 worker 不发请求）。
 * 缺了假 worker 注入时第 1/2 段**明说跳过**，不交一份看着通过的日志（照抄 crash 模式）。
 */
import { BrowserWindow, dialog } from "electron";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createSession, getSession, listSessions, upsertProject } from "../../../main/db/repo";
import { isDev } from "../../../main/lib/app-mode";
import { sessionManager } from "../../../main/session-manager";
import { sleep } from "../context";

/** 临时 provider 的 id / 模型引用：为这条用例现造、跑完即删，不该留在用户的设置里 */
const FAKE_PROVIDER_ID = "smoke-rm-workspace-fake";
const FAKE_MODEL_REF = `${FAKE_PROVIDER_ID}/fake-model`;
/** 归属标记：只有路径含它的会话才归本用例所有（与 running-worker.cjs 的门禁同一串） */
const OWNED = "smoke-rm-workspace";

export async function runRmWorkspace(
  window: BrowserWindow,
  projectId: string,
  sessionsDir: string,
  log: (message: string) => void,
  run: <T>(expression: string) => Promise<T>,
): Promise<void> {
  const checks: [string, boolean][] = [];
  const skips: string[] = [];
  const push = (name: string, ok: boolean): void => {
    checks.push([name, ok]);
    log(`  ${ok ? "✓" : "✗"} ${name}`);
  };
  const waitFor = async (
    check: () => Promise<boolean>,
    want: boolean,
    label: string,
  ): Promise<boolean> => {
    for (let i = 0; i < 50; i += 1) {
      if ((await check()) === want) return true;
      await sleep(200);
    }
    log(`  （等待超时：${label}）`);
    return false;
  };

  const sessionsRoot = dirname(sessionsDir);
  /** 造一个本项目下的靶子工作区（目录名自带归属标记） */
  const makeWorkspace = (leaf: string): { id: string; root: string } => {
    const root = join(sessionsRoot, leaf);
    mkdirSync(root, { recursive: true });
    return { id: upsertProject(root).id, root };
  };
  /** 会话身份快照：假 worker 若真写进去了，这几项就对不上 */
  const identity = (sessionId: string): string => {
    const session = getSession(sessionId);
    return JSON.stringify({
      title: session?.title ?? null,
      kernel: session?.kernelSessionId ?? null,
      count: session?.messageCount ?? null,
    });
  };
  const rowExists = (id: string): Promise<boolean> =>
    run<boolean>(`document.querySelector('[data-project-row="${id}"]') !== null`);
  const openWithFakeModel = (sessionId: string): string =>
    `window.colt.invoke("session.open", ${JSON.stringify({ sessionId, model: FAKE_MODEL_REF })})`;

  const injected = isDev && Boolean(process.env.COLT_WORKER_OVERRIDE);
  if (!injected) {
    skips.push(
      "「运行中 → 整次移除被拒绝」与「假 worker 对别人的会话零写入」——两者都依赖 scripts/running-worker.cjs",
    );
    log(
      "跳过：未装「假 worker」注入，上面两段验不了任何东西。" +
        `当前 isDev=${isDev}、COLT_WORKER_OVERRIDE=${JSON.stringify(process.env.COLT_WORKER_OVERRIDE)}；` +
        "要验请设 COLT_WORKER_OVERRIDE=<仓库>/scripts/running-worker.cjs。界面链路照常验。",
    );
  }

  if (injected) {
    // 免密钥的本地 provider：让 session.open 过得了「需要密钥就必须配」那道闸
    // （`#spawnWorker`），又不必碰本机既有配置；假 worker 从不发请求，故无计费。
    await run(
      `window.colt.invoke("providers.save", ${JSON.stringify({
        id: FAKE_PROVIDER_ID,
        name: "冒烟占位（免密钥）",
        baseUrl: "http://127.0.0.1:9/v1",
        models: [{ id: "fake-model", name: "冒烟占位模型", contextWindow: 8192 }],
        requiresKey: false,
      })})`,
    );

    try {
      // ---- 第 1 段：运行中的会话让整次移除被拒绝 ----
      const busy = makeWorkspace(`${OWNED}-busy`);
      const session = createSession(busy.id, join(sessionsRoot, busy.id));
      log(`运行中靶子：${busy.id}／会话 ${session.id}`);
      await run(openWithFakeModel(session.id));
      // ready 返回后那条 running:true 才随后到达，故轮询等它落地
      const running = await waitFor(
        async () => sessionManager.isRunning(session.id),
        true,
        "假 worker 的 running 视图落地",
      );
      push("前置：会话真的处于运行中（假 worker 的 running 视图已落地）", running);

      const kernelSessionId = getSession(session.id)?.kernelSessionId ?? null;
      push("前置：ready 里那个 kernelSessionId 已被主进程落库", kernelSessionId !== null);
      // 落一份 JSONL 探针：内核按 kernelSessionId 命名，这里照抄——删项目时要连它一起清
      const jsonl = join(sessionsRoot, busy.id, `20260101_${kernelSessionId}.jsonl`);
      mkdirSync(dirname(jsonl), { recursive: true });
      writeFileSync(jsonl, "{}\n", "utf8");
      push("前置：JSONL 探针已落盘（否则下面那条否定断言会必然为真）", existsSync(jsonl));

      const blocked = await run<{ threw: boolean; message: string }>(
        `window.colt.invoke("project.delete", ${JSON.stringify({ projectId: busy.id })})
           .then(() => ({ threw: false, message: "" }))
           .catch((error) => ({ threw: true, message: String(error && error.message) }))`,
      );
      push("运行中时拒绝移除（不是静默成功）", blocked.threw);
      push(
        "拒绝时点明是哪条会话在跑（用户知道该先中止哪一条）",
        blocked.message.includes("冒烟占位") && blocked.message.includes("正在运行"),
      );
      const listed = await run<boolean>(
        `window.colt.invoke("project.list", undefined)
           .then((list) => list.some((item) => item.id === ${JSON.stringify(busy.id)}))`,
      );
      push("拒绝**无副作用**：项目登记还在（检查排在任何删除之前）", listed);
      push("拒绝**无副作用**：会话行还在", listSessions(busy.id).length === 1);
      push("拒绝**无副作用**：落盘 JSONL 还在", existsSync(jsonl));

      // 跑完（收到 abort 后的 running:false）→ 同一条会话能删了
      await run(`window.colt.invoke("session.abort", ${JSON.stringify({ sessionId: session.id })})`);
      const finished = await waitFor(
        async () => sessionManager.isRunning(session.id),
        false,
        "abort 后运行态落地为 false",
      );
      push("中止后不再是运行中（否则下面那条绿可能只是恰好没跑到）", finished);

      await run(`window.colt.invoke("project.delete", ${JSON.stringify({ projectId: busy.id })})`);
      const gone = await run<boolean>(
        `window.colt.invoke("project.list", undefined)
           .then((list) => list.some((item) => item.id === ${JSON.stringify(busy.id)}))`,
      );
      push("跑完之后删得掉：项目登记已消失", !gone);
      push("跑完之后删得掉：会话行已清", listSessions(busy.id).length === 0);
      push("跑完之后删得掉：JSONL 一并清掉", !existsSync(jsonl));

      // ---- 第 2 段：假 worker 对「别人的会话」零写入 ----
      // 靶子的路径**故意不含归属标记**，正是用户在假 worker 眼里的样子。
      // 前提先自证：这条会话确实不是「自己人」。
      const alien = makeWorkspace("probe-not-owned");
      const alienSession = createSession(alien.id, join(sessionsRoot, alien.id));
      push("前置：这条靶子的 cwd 不含归属标记（所以才叫「别人的会话」）", !alien.root.includes(OWNED));
      const alienBefore = identity(alienSession.id);

      const alienOpen = await run<{ threw: boolean; message: string }>(
        `${openWithFakeModel(alienSession.id)}
           .then(() => ({ threw: false, message: "" }))
           .catch((error) => ({ threw: true, message: String(error && error.message) }))`,
      );
      push("假 worker 不认这条会话：open 直接失败（而不是把它当成自己的去 ready/view）", alienOpen.threw);
      push(
        "零写入：它的标题 / kernelSessionId / 消息数一字未动（ready 与 view 都没发出去）",
        identity(alienSession.id) === alienBefore,
      );

      await run(`window.colt.invoke("project.delete", ${JSON.stringify({ projectId: alien.id })})`);
      rmSync(alien.root, { recursive: true, force: true });
    } finally {
      // 临时 provider 自己清掉：它是为这条用例造的，留着会污染用户的设置页
      await run(
        `window.colt.invoke("providers.remove", ${JSON.stringify({ id: FAKE_PROVIDER_ID })}).catch(() => undefined)`,
      );
    }
  }

  // ---- 第 3 段：界面链路（不依赖假 worker）----
  // 靶子项目故意**零会话**：渲染层切到它只会建草稿（草稿不 fork worker），
  // 于是它自己那一行的入口不会因为「有会话在跑」而变灰，也不会有 worker 卷进来。
  const clean = makeWorkspace(`${OWNED}-clean`);
  log(`界面靶子项目：${clean.id}`);

  try {
    // 侧栏的项目列表只在挂载时拉一次（没有推送），新造的项目得靠**重新加载**才会出现
    window.reload();
    await sleep(2500);
    const appeared = await waitFor(() => rowExists(clean.id), true, "重载后侧栏出现靶子项目");
    push("前置：重载后侧栏里真的出现了靶子项目那一行", appeared);

    // 原生确认框会阻塞自动化（没人能点它）：打桩成「点了确认」。这是本模式唯一一处
    // 改主进程行为的地方，用完立刻还原（`dialog.confirm` 走的就是它，见 ipc 的同名通道）。
    const realShowMessageBox = dialog.showMessageBox;
    dialog.showMessageBox = (async () => ({
      response: 0,
      checkboxChecked: false,
    })) as unknown as typeof dialog.showMessageBox;
    try {
      const clicked = await run<boolean>(
        `(() => {
           const row = document.querySelector('[data-project-row="${clean.id}"]');
           const button = row && row.querySelector('[data-project-remove]');
           if (!button) return false;
           const rect = button.getBoundingClientRect();
           // 「在 DOM 里」不等于「点得到」：小目标入口还要确认它真落在可视区、那一层就是它
           const at = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
           if (!at || (at !== button && !button.contains(at))) return false;
           button.click();
           return true;
         })()`,
      );
      push("界面入口在可视区且命中测试通过（按它自己的 data-project-remove 认，不靠层级猜）", clicked);

      const gone = await waitFor(() => rowExists(clean.id), false, "点完之后侧栏那一行消失");
      push("点了确实有变化：侧栏那一行消失（不是点了没反应）", gone);

      const ids = await run<string[]>(
        'window.colt.invoke("project.list", undefined).then((list) => list.map((item) => item.id))',
      );
      push("断开登记：库里也没有它了", !ids.includes(clean.id));
      push("只断开这一个：本模式的主角项目没被牵连", ids.includes(projectId));
    } finally {
      dialog.showMessageBox = realShowMessageBox;
    }
  } finally {
    rmSync(clean.root, { recursive: true, force: true });
    const failed = checks.filter(([, ok]) => !ok).length;
    log(`通过 ${checks.length - failed}/${checks.length}`);
    if (skips.length > 0) log(`跳过 ${skips.length} 项：${skips.join("；")}`);
  }
}
