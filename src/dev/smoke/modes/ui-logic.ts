// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 冒烟模式：ui-logic —— 界面**逻辑漏洞**的回归。
 *
 * 它验的不是「功能能不能用」（那是各功能模式的事），而是**「坏了会被当成产品 bug、但他处没覆盖」的那几条**。
 * 本模式最初是为**实证缺陷存在**而写的（`docs/UI-TEST-CASES.md` §二 / §六）；
 * 那批缺陷修掉之后，它转为**回归断言**——期望值现在是「修好之后应该是什么样」：
 *
 *   D1  失败提示**贴着输入卡片**、不在消息滚动区里 → 长会话滚到底也看得见
 *   D2  运行中敲 `/compact`：**输入保留**（不被吃掉）、命令仍不执行、提示可见
 *   D3  粘贴非图片与拖入**同一套反馈**（都给出「已跳过非图片文件」）
 *   D4  附件超上限（4 张）时**如实说跳过了几张**
 *   D7  搜索浮层：ESC 在**任何焦点下**都关得掉，点外部也关，且「搜索」按钮自身不会因此变成死控件
 *   D10 起手态**不再被一个 error 赶走**（提示与布局解耦）
 *
 * 定位与出处：`docs/UI-TEST-CASES.md` §二（缺陷假设）与 §六（实证 + 复核结果）。
 * **不打模型**：`compact` / `prompt` 两个入口都打桩（**只记账、不转发**，v1.41 的教训），
 * 而 `/skill <未知名>` 在本地就拦下了（不发 IPC）。模式末尾有断言坐实「全程实发 prompt 0 条」。
 * 用法：`COLT_SMOKE=ui-logic.png COLT_SMOKE_MODE=ui-logic npm run dev`
 *
 * ⚠️ 写本模式踩过的坑（都是「必然为真」的假绿灯与接线问题，见 `docs/UI-TEST-CASES.md` §6.4/§6.6）：
 * 前提失败时不要执行该段；选择器只认元素自己的标记；设位置与量位置写在同一个表达式里；
 * 打桩统一在 `finally` 还原（提前还原会让后续用例真走 worker，红得离真相很远）。
 */
import type { BrowserWindow } from "electron";
import { createSession } from "../../../main/db/repo";
import { sessionManager } from "../../../main/session-manager";
import { DEFAULT_THINKING_LEVEL } from "@shared/thinking-level";
import type { ConversationView } from "@shared/worker-protocol";
import { sleep, uncaughtErrors } from "../context";

/** 1×1 透明 PNG（构造图片附件用） */
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

export async function runUiLogic(
  window: BrowserWindow,
  projectId: string,
  sessionsDir: string,
  log: (message: string) => void,
  run: <T>(expression: string) => Promise<T>,
): Promise<void> {
  const session = createSession(projectId, sessionsDir);
  const checks: [string, boolean][] = [];
  const notes: string[] = [];

  // 本模式「不打模型」的契约：两个会真发请求的入口都打桩，**只记账、不转发**
  // （v1.41 的教训：桩若转调真实现，测试文本会成为真 prompt，既计费又写进真实会话历史）。
  const compactCalls: string[] = [];
  const promptCalls: string[] = [];
  const realCompact = sessionManager.compactOrReconnect.bind(sessionManager);
  const realPrompt = sessionManager.promptOrReconnect.bind(sessionManager);
  sessionManager.compactOrReconnect = async (id: string) => {
    compactCalls.push(id);
  };
  sessionManager.promptOrReconnect = async (_id: string, text: string) => {
    promptCalls.push(text);
  };

  const viewBase: ConversationView = {
    sessionId: session.id,
    model: "smoke/model",
    imageInput: false,
    thinkingLevel: DEFAULT_THINKING_LEVEL,
    skills: [], // 「知道，且为空」：/skill 的本地拦截该生效
    subagents: [],
    messages: [],
    toolResults: [],
    todos: [],
    fileChanges: [],
    streamingText: null,
    thought: null,
    runningTools: [],
    running: false,
    runningOperation: null,
    lastRun: null,
    queuedCount: 0,
    stats: {
      messageCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      contextUsed: 0,
    },
  };
  const smokeView = (over: Partial<ConversationView>): ConversationView => ({
    ...viewBase,
    ...over,
  });
  const push = async (over: Partial<ConversationView>): Promise<void> => {
    window.webContents.send("session.view", smokeView(over));
    await sleep(400);
  };

  /** 足够长的消息列表：让窗口（50 条）真的撑出滚动条 */
  const longMessages = Array.from({ length: 60 }, (_, i) => ({
    id: `smoke-long-${i}`,
    role: "assistant" as const,
    text: `第 ${i} 条消息：` + "这是一段用来把会话区撑高的文本。".repeat(12),
    toolCalls: [],
  }));

  const typeAndEnter = (text: string): Promise<boolean> =>
    run<boolean>(`(() => {
      const ta = document.querySelector("textarea");
      if (!ta) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(ta, ${JSON.stringify(text)});
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      return true;
    })()`);

  const inputValue = (): Promise<string> =>
    run<string>(`(document.querySelector("textarea") || {}).value ?? ""`);

  /** 提示的位置：在不在滚动容器里、在不在视野内（D1 的两条判据） */
  const alertGeom = (): Promise<{ present: boolean; inScrollArea: boolean; inViewport: boolean; top: number }> =>
    run(`(() => {
      const err = document.querySelector("[data-conv-error]");
      const scroll = document.querySelector("[data-conv-scroll]");
      if (!err) return { present: false, inScrollArea: false, inViewport: false, top: 0 };
      const r = err.getBoundingClientRect();
      return {
        present: true,
        inScrollArea: !!(scroll && scroll.contains(err)),
        inViewport: r.bottom > 0 && r.top < window.innerHeight,
        top: Math.round(r.top),
      };
    })()`);

  const scrollToBottom = (): Promise<{ height: number; client: number }> =>
    run(`(() => {
      const view = document.querySelector("[data-conv-scroll]");
      if (!view) return { height: 0, client: 0 };
      view.scrollTop = view.scrollHeight;
      return { height: Math.round(view.scrollHeight), client: Math.round(view.clientHeight) };
    })()`);

  /** 搜索浮层与「+」菜单的开关状态 */
  const panelExists = (): Promise<boolean> =>
    run<boolean>(`!!document.querySelector("[data-conv-history]")`);
  const openSearch = (): Promise<boolean> =>
    run<boolean>(`(() => {
      const btns = [...document.querySelectorAll("button")];
      const btn = btns.find((b) => (b.textContent || "").trim() === "搜索");
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
  const closePanelIfOpen = async (): Promise<void> => {
    await run(`(() => {
      const panel = document.querySelector("[data-conv-history]");
      if (!panel) return true;
      const btn = panel.querySelector("[data-conv-history-close]");
      if (btn) btn.click();
      return false;
    })()`);
    await sleep(250);
  };
  const menuOpen = (): Promise<boolean> => run<boolean>(`!!document.querySelector("[data-dock-add]")`);

  const clearAttachments = async (): Promise<number> => {
    for (let i = 0; i < 8; i += 1) {
      const removed = await run<boolean>(
        `(() => { const b = document.querySelector('[aria-label="移除图片"]'); if (!b) return false; b.click(); return true; })()`,
      );
      if (!removed) break;
      await sleep(120);
    }
    return run<number>(`document.querySelectorAll('[aria-label="移除图片"]').length`);
  };

  const dropImages = (n: number): Promise<{ count: number; notice: string }> =>
    run<{ count: number; notice: string }>(`(async () => {
      const card = document.querySelector("[data-conv-card]");
      if (!card) return { count: -1, notice: "no-card" };
      const b64 = ${JSON.stringify(TINY_PNG)};
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      const dt = new DataTransfer();
      for (let i = 0; i < ${n}; i += 1) dt.items.add(new File([bytes], "probe-" + i + ".png", { type: "image/png" }));
      const ev = new DragEvent("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(ev, "dataTransfer", { value: dt });
      card.dispatchEvent(ev);
      await new Promise((r) => setTimeout(r, 900));
      return {
        count: document.querySelectorAll('[aria-label="移除图片"]').length,
        notice: (document.querySelector("[data-conv-attach-notice]") || {}).textContent || "",
      };
    })()`);

  try {
    // 让渲染层真的打开这条会话（同 dock 模式：reload 后它自动打开 list 的第一条）
    window.reload();
    await sleep(4000);
    const list = await run<{ id: string }[]>(
      `window.colt.invoke("session.list", ${JSON.stringify({ projectId })})`,
    );
    const sessionId = list[0]?.id;
    checks.push(["渲染层打开了本条会话", sessionId === session.id]);

    // ============ D10：起手态不再被一个 error 赶走 ============
    // （放在最前：本段要求「还没有任何错误」，别被后段的 error 干扰）
    await push({ messages: [], running: false });
    const startBefore = await run<{ start: boolean; err: boolean }>(`(() => ({
      start: !!document.querySelector("[data-conv-start]"),
      err: !!document.querySelector("[data-conv-error]"),
    }))()`);
    checks.push(["（前提）空会话处于起手态、且没有错误", startBefore.start === true && startBefore.err === false]);
    if (startBefore.start) {
      await typeAndEnter("/skill no-such-skill-probe");
      await sleep(600);
      const after = await run<{ start: boolean; err: boolean }>(`(() => ({
        start: !!document.querySelector("[data-conv-start]"),
        err: !!document.querySelector("[data-conv-error]"),
      }))()`);
      notes.push(`起手态敲 /skill 错名 → 错误提示=${after.err}，起手态仍在=${after.start}`);
      checks.push(["D10：错误提示出现了（前提）", after.err === true]);
      checks.push(["D10：**起手态仍在**——提示不再影响布局（原先会被 error 赶走）", after.start === true]);
      // error 仍然是渲染层本地 state（不会被推视图清掉）；关键区别是它**不再改变布局**
      await push({ messages: [], running: false });
      const stillStart = await run<boolean>(`!!document.querySelector("[data-conv-start]")`);
      checks.push(["D10：再推一次「无消息」视图后起手态依然在", stillStart === true]);
    }

    // ============ D2 + D1：运行中敲 /compact（输入不被吃、提示看得见）============
    await push({ messages: longMessages, running: true });
    const scrolled = await scrollToBottom();
    await sleep(300);
    checks.push([
      `（前提）长会话真的撑出滚动条（scrollHeight=${scrolled.height} > clientHeight=${scrolled.client}）`,
      scrolled.height > scrolled.client + 200,
    ]);
    const compactBefore = compactCalls.length;
    await typeAndEnter("/compact");
    await sleep(600);
    const afterInput = await inputValue();
    const alert = await alertGeom();
    notes.push(
      `运行中敲 /compact → 输入框=${JSON.stringify(afterInput)}；派发=${compactCalls.length - compactBefore}；` +
        `提示存在=${alert.present}，在滚动区内=${alert.inScrollArea}，在视野内=${alert.inViewport}（top=${alert.top}）`,
    );
    checks.push(["D2：运行中敲 /compact → **输入保留**（不再被吃掉）", afterInput === "/compact"]);
    checks.push(["D2：命令仍然没有派发（运行中确实不执行）", compactCalls.length === compactBefore]);
    checks.push(["D1：错误提示出现", alert.present]);
    checks.push(["D1：提示**不在消息滚动区里**（搬到输入列了）", alert.inScrollArea === false]);
    checks.push(["D1：滚到底时提示**仍然在视野内**", alert.inViewport === true]);
    // 对照：把会话区滚到最顶也不影响它（因为它压根不在那个容器里）
    await run(`(() => { const v = document.querySelector("[data-conv-scroll]"); if (v) v.scrollTop = 0; return true; })()`);
    await sleep(300);
    const alertAtTop = await alertGeom();
    checks.push(["D1 对照：会话区滚到顶后提示位置不变（与滚动无关）", alertAtTop.inViewport === true]);

    // ---- 稳定性：重复 3 次 ----
    const rounds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const before = compactCalls.length;
      await typeAndEnter("/compact");
      await sleep(400);
      rounds.push(`${(await inputValue()) === "/compact" ? "留" : "丢"}/${compactCalls.length - before}`);
    }
    // 图标按钮在运行中置灰：与「命令路径保留输入」互为对照（同一件事两条入口都不执行）
    const compactButtonDisabled = await run<boolean>(
      `(() => { const b = document.querySelector('[data-slash-command="compact"]'); return !!b && b.disabled; })()`,
    );
    notes.push(`重复 3 次（输入态/派发数）=${rounds.join(", ")}；图标按钮 disabled=${compactButtonDisabled}`);
    checks.push(["D2：重复 3 次都「输入保留 / 不派发」（稳定）", rounds.length === 3 && rounds.every((r) => r === "留/0")]);
    checks.push(["D2 对照：图标按钮在运行中置灰（两条入口一致地不执行）", compactButtonDisabled === true]);

    // ============ D3：粘贴与拖入同一套反馈 ============
    await push({ messages: longMessages, running: false });
    await clearAttachments();
    // 先把上段的 error 清掉（换会话才清不掉；这里用一次成功操作清，便于观察 attachNotice）
    await typeAndEnter("/compact");
    await sleep(700);
    await clearAttachments();
    const pastePdf = await run<{ count: number; notice: string; input: string }>(`(async () => {
      const ta = document.querySelector("textarea");
      const dt = new DataTransfer();
      dt.items.add(new File(["pdf-bytes"], "probe.pdf", { type: "application/pdf" }));
      const ev = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(ev, "clipboardData", { value: dt });
      ta.dispatchEvent(ev);
      await new Promise((r) => setTimeout(r, 500));
      return {
        count: document.querySelectorAll('[aria-label="移除图片"]').length,
        notice: (document.querySelector("[data-conv-attach-notice]") || {}).textContent || "",
        input: ta.value,
      };
    })()`);
    const dropPdf = await run<{ count: number; notice: string }>(`(async () => {
      const card = document.querySelector("[data-conv-card]");
      const dt = new DataTransfer();
      dt.items.add(new File(["pdf-bytes"], "probe.pdf", { type: "application/pdf" }));
      const ev = new DragEvent("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(ev, "dataTransfer", { value: dt });
      card.dispatchEvent(ev);
      await new Promise((r) => setTimeout(r, 500));
      return {
        count: document.querySelectorAll('[aria-label="移除图片"]').length,
        notice: (document.querySelector("[data-conv-attach-notice]") || {}).textContent || "",
      };
    })()`);
    notes.push(
      `粘贴 .pdf → 提示=${JSON.stringify(pastePdf.notice)}（附件 ${pastePdf.count} 张、输入框=${JSON.stringify(pastePdf.input)}）；` +
        `拖入 .pdf → 提示=${JSON.stringify(dropPdf.notice)}`,
    );
    checks.push([
      "D3：粘贴非图片**给出提示**（与拖入同一套反馈）",
      pastePdf.notice.includes("已跳过非图片文件") && pastePdf.count === 0,
    ]);
    checks.push(["D3 对照：拖入非图片同样给提示", dropPdf.notice.includes("已跳过非图片文件")]);
    checks.push(["D3：粘贴非图片不影响输入框内容（没顺手改用户输入）", pastePdf.input === ""]);

    // ============ D4：超上限如实说跳过了几张 ============
    await push({ messages: longMessages, running: false });
    await clearAttachments();
    const five = await dropImages(5);
    notes.push(`拖入 5 张 → 附件 ${five.count} 张，提示=${JSON.stringify(five.notice)}`);
    checks.push(["D4：仍收下 4 张（上限没变）", five.count === 4]);
    checks.push([
      "D4：**如实说明跳过了 1 张**（不再静默丢弃）",
      five.notice.includes("最多放 4 张") && five.notice.includes("已跳过 1 张"),
    ]);
    // 另一条路径：已有 3 张再拖 2 张 → 只能进 1 张，也要说
    await clearAttachments();
    const first3 = await dropImages(3);
    const then2 = await dropImages(2);
    notes.push(`先 3 张（提示=${JSON.stringify(first3.notice)}）再 2 张 → ${then2.count} 张，提示=${JSON.stringify(then2.notice)}`);
    checks.push(["D4 另一条路径：3 + 2 仍为 4 张，且说清跳过了 1 张", first2Ok(first3, then2)]);

    // ============ D6：命中很多时如实计数（不再静默截断）============
    await push({
      messages: Array.from({ length: 120 }, (_, i) => ({
        id: `smoke-hit-${i}`,
        role: "assistant" as const,
        text: `命中关键词 第 ${i} 条`,
        toolCalls: [],
      })),
      running: false,
    });
    await closePanelIfOpen();
    await openSearch();
    await sleep(400);
    await run(`(() => {
      const q = document.querySelector("[data-conv-history-query]");
      if (!q) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(q, "命中关键词");
      q.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    await sleep(500);
    const hitStats = await run<{ shown: number; more: string }>(`(() => ({
      shown: document.querySelectorAll("[data-conv-history-hit]").length,
      more: (document.querySelector("[data-conv-history-more]") || {}).textContent || "",
    }))()`);
    notes.push(`搜索 120 条命中 → 列出 ${hitStats.shown} 条，底部提示=${JSON.stringify(hitStats.more)}`);
    checks.push([
      "D6：列出前 50 条并**如实说明共多少条**（不再静默截断）",
      hitStats.shown === 50 && hitStats.more.includes("120"),
    ]);
    await closePanelIfOpen();

    // ============ D7：搜索浮层的关闭出口 ============
    await push({ messages: longMessages, running: false });
    await closePanelIfOpen();
    const opened = await openSearch();
    await sleep(400);
    checks.push(["（前提）搜索浮层能打开", opened && (await panelExists())]);

    // ① 焦点在查询框内 → ESC 关闭
    await run(`(() => { const q = document.querySelector("[data-conv-history-query]"); if (q) q.focus(); return true; })()`);
    await run(`document.querySelector("[data-conv-history-query]").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await sleep(300);
    checks.push(["① 焦点在查询框内：ESC 关闭浮层", (await panelExists()) === false]);

    // ② 焦点移出浮层（blur）后 → ESC **仍然**关闭（修复点：监听挂到了 document）
    await openSearch();
    await sleep(400);
    await run(`(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return document.activeElement === document.body; })()`);
    await run(`document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await sleep(300);
    checks.push(["D7：焦点不在浮层内时 ESC **也**关得掉（原先关不掉）", (await panelExists()) === false]);

    // ③ 点浮层外 → 关闭（新增的「点外部关闭」，与「+」菜单同一套契约）
    await openSearch();
    await sleep(400);
    await run(`(() => {
      const view = document.querySelector("[data-conv-scroll]");
      if (view) view.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      return true;
    })()`);
    await sleep(300);
    checks.push(["D7：点浮层外关闭浮层（与「+」菜单契约一致）", (await panelExists()) === false]);

    // ④ 关键回归：点「搜索」按钮自己仍然关得掉（它是 toggle，别被「点外部关闭」抵消成死控件）
    await openSearch();
    await sleep(400);
    const openByButton = await panelExists();
    await run(`(() => {
      const btns = [...document.querySelectorAll("button")];
      const btn = btns.find((b) => (b.textContent || "").trim() === "搜索");
      if (!btn) return false;
      btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      btn.click();
      return true;
    })()`);
    await sleep(400);
    const closedByButton = (await panelExists()) === false;
    checks.push(["D7：点「搜索」按钮把它关掉（toggle 没被外部点击关闭抵消）", openByButton && closedByButton]);

    // ⑤ 对照：「+」菜单同样支持 ESC / 点外部（两处契约一致）
    const menuBtnClicked = await run<boolean>(`(() => {
      const btn = document.querySelector("button[data-dock-menu-root]");
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    await sleep(300);
    const menuWasOpen = await menuOpen();
    await run(`document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await sleep(300);
    notes.push(`「+」菜单：点了=${menuBtnClicked}、打开=${menuWasOpen}、ESC 后仍在=${await menuOpen()}`);
    checks.push(["对照：「+」菜单 ESC 能关（与搜索浮层同一套契约）", menuWasOpen === true && (await menuOpen()) === false]);

    log(`uncaughtErrors: ${uncaughtErrors.length}`);
    checks.push(["全程未抛未捕获异常", uncaughtErrors.length === 0]);
    checks.push([`全程没有真实 prompt 发出（实发 ${promptCalls.length} 条）`, promptCalls.length === 0]);
  } finally {
    sessionManager.compactOrReconnect = realCompact;
    sessionManager.promptOrReconnect = realPrompt;
    for (const line of notes) log(`  实测：${line}`);
    let pass = 0;
    for (const [name, ok] of checks) {
      if (ok) pass += 1;
      log(`${ok ? "✓" : "✗"} ${name}`);
    }
    log(`通过 ${pass}/${checks.length}`);
  }
}

/** 3 + 2 那条路径的判据（抽出来只为让断言行短一点） */
function first2Ok(first3: { count: number; notice: string }, then2: { count: number; notice: string }): boolean {
  return first3.count === 3 && first3.notice === "" && then2.count === 4 && then2.notice.includes("跳过 1 张");
}
