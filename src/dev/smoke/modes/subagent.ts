// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 冒烟模式：subagent（子代理的呈现链路，**不跑模型、不计费**）。
 *
 * 为什么不打模型也能验：子代理在视图里的形态只由 `ConversationView.subagents` 决定，
 * 而 `session.view` 是渲染层的**唯一数据入口**——从主进程推一份受控视图即可驱动全部
 * 呈现逻辑（同 `dock` / `todo` 的做法）。这样验的是「界面把这份数据画对了吗」，
 * 而「模型会不会用这个工具」属于 e2e（`COLT_SMOKE_MODE=subagent-e2e`，**打模型、已实测**）。
 *
 * 覆盖（决策三 D5 / 决策七 D9 / 决策四 D6 的界面侧）：
 *   1. ④ 的卡**特化**：`子代理 · <名字>` + 状态；展开是**有界预览**（如实说「最近 N / 共 M 步」）；
 *   2. **此刻动作只在 ④**：右栏「任务摘要」不再列它（v1.53 删去「进行中的动作」段），
 *      且「中止」也在 ④ 的卡面上（不再重复一个「N 个动作进行中」的列表）；
 *   3. **不自动展开右栏**（决策三：子代理是模型自己发起的，routine 起来会反复撑开右栏）；
 *   4. 已结束的子代理**不再给「中止」**（已结束的卡上不放点了没反应的按钮）、④ 的卡仍在
 *      （卡的寿命跟着 transcript）；
 *   5. 点 ④ 卡上的「在右栏查看完整过程」→ **下钻到子代理流**（面包屑 + ESC 逐层回退）；
 *      完整流**按需拉**（`session.subagentTranscript`），拉不到时**如实说**而不是白屏；
 *   6. 中止按钮**真的落在可视区**（小目标入口要做命中测试，别只查「在不在 DOM 里」）。
 *
 * 明确不覆盖（写明，免得被当成验过了）：
 *   - 「`subagent` 调用不弹卡、它内部的写弹卡」是决策四 D6 的**执行侧**，本模式不打模型 ⇒
 *     未覆盖；它由 `COLT_SMOKE_MODE=subagent-e2e`（打模型、计费）覆盖，运行手册见
 *     `docs/NEXT-PHASE.md` §5 3-f、`docs/DESIGN-subagents.md` §12。
 *   - **分支树排除与导航守卫**是 worker 侧会话级数据（`session.findEntries` + `harness.lanes()`），
 *     受控视图驱动不到它；纯函数侧由 `tests/lane-ownership.test.ts` 覆盖。
 *   - 子代理**生命周期**里的时序语义（并发上限的占位、崩溃恢复不 resume 子 lane、超时中止）
 *     同样不在本模式内：它们要么需要真 worker，要么只能由单测与人工核对。
 */
import { BrowserWindow } from "electron";
import { createSession } from "../../../main/db/repo";
import type {
  ConversationView,
  ViewMessage,
  ViewRunningTool,
  ViewSubagent,
} from "@shared/worker-protocol";
import { DEFAULT_THINKING_LEVEL } from "@shared/thinking-level";
import { sleep, uncaughtErrors } from "../context";

/** 造一条「运行中的工具」（子代理尾部里会出现它，④ 卡的预览也靠它说「在干什么」） */
const runningTool = (): ViewRunningTool => ({
  id: "smoke-sub-tool",
  name: "read",
  args: JSON.stringify({ path: "src/worker/lib/subagent.ts" }),
  output: "",
  startedAt: Date.now() - 1_000,
});

/**
 * 造一个子代理总账。
 * `stepCount` 故意大于视图上限（12），用来钉住「截断但**如实给总步数**」。
 */
const makeSubagent = (
  id: string,
  toolCallId: string,
  status: ViewSubagent["status"],
  stepCount: number,
): ViewSubagent => {
  const steps: ViewMessage[] = Array.from(
    { length: Math.min(stepCount, 12) },
    (_, index) => ({
      id: `${id}-step-${index}`,
      role: "assistant" as const,
      text: `第 ${index + 1} 步`,
      toolCalls: [],
      timestamp: 1,
    }),
  );
  return {
    id,
    toolCallId,
    name: "researcher",
    title: "查一下 read 工具在哪注册",
    status,
    startedAt: Date.now() - 5_000,
    ...(status === "running" ? {} : { endedAt: Date.now() }),
    tail: {
      streamingText: null,
      thought: null,
      runningTools: status === "running" ? [runningTool()] : [],
      recentSteps: steps,
      stepCount,
    },
    stats: { inputTokens: 120, outputTokens: 40, costUsd: 0.012 },
  };
};

export async function runSubagent(
  window: BrowserWindow,
  projectId: string,
  sessionsDir: string,
  log: (message: string) => void,
  run: <T>(expression: string) => Promise<T>,
): Promise<void> {
  const session = createSession(projectId, sessionsDir);
  log(`会话：${session.id}`);

  const checks: [string, boolean][] = [];

  const runningId = "sub:researcher:smoke0001";
  const runningCallId = "smoke-sub-call-1";

  /** 一条 ④ 的工具卡（`name: "subagent"` 才会被特化） */
  const subagentCall = (toolCallId: string): ViewMessage["toolCalls"][number] => ({
    id: toolCallId,
    name: "subagent",
    args: JSON.stringify({
      agent: "researcher",
      task: "在 src/worker/lib 下定位 read 工具的注册点，给出文件路径与关键行",
      title: "查一下 read 工具在哪注册",
    }),
    durationMs: 1_200,
  });

  const viewBase: ConversationView = {
    sessionId: session.id,
    model: "smoke/model",
    imageInput: false,
    thinkingLevel: DEFAULT_THINKING_LEVEL,
    skills: [],
    subagents: [],
    messages: [
      {
        id: "smoke-sub-msg-1",
        role: "assistant",
        text: "我委派一个子代理去查。",
        toolCalls: [subagentCall(runningCallId)],
        timestamp: 1,
      },
    ],
    toolResults: [],
    todos: [],
    fileChanges: [],
    streamingText: null,
    thought: null,
    // 把那条 `subagent` 工具也放进 runningTools：④ 里那张子代理卡就是由它渲染的
    // （流式区按 runningTools 出卡），少了它这条断言就没有被测对象。
    runningTools: [
      {
        id: runningCallId,
        name: "subagent",
        args: subagentCall(runningCallId).args,
        output: "",
        startedAt: Date.now() - 5_000,
      },
    ],
    running: true,
    runningOperation: "run",
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
  const push = (over: Partial<ConversationView>): void => {
    window.webContents.send("session.view", smokeView(over));
  };

  /** 右栏（⑦）的状态：折叠与否、文本 */
  const dockProbe = `(() => {
    const aside = [...document.querySelectorAll("aside")].find((a) =>
      a.querySelector('button[aria-label="折叠工作区"], button[aria-label="展开工作区"]'));
    if (!aside) return { present: false, collapsed: null, text: "" };
    return {
      present: true,
      collapsed: aside.querySelector('button[aria-label="展开工作区"]') !== null,
      text: aside.innerText ?? "",
    };
  })()`;

  const clickBySelector = (selector: string): Promise<boolean> =>
    run<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.click();
      return true;
    })()`);

  const clickDockTab = (label: string): Promise<boolean> =>
    run<boolean>(`(() => {
      const el = [...document.querySelectorAll("[data-dock-tab]")]
        .find((b) => (b.textContent ?? "").trim() === ${JSON.stringify(label)});
      if (!el) return false;
      el.click();
      return true;
    })()`);

  /** 展开 ④ 里那张子代理卡（点它那一行的按钮）——按可见文案找，不按层级猜 */
  const expandSubagentCard = (): Promise<boolean> =>
    run<boolean>(`(() => {
      const span = [...document.querySelectorAll("span")]
        .find((s) => (s.textContent ?? "").trim() === "子代理 · researcher");
      const btn = span ? span.closest("button") : null;
      if (!btn) return false;
      btn.click();
      return true;
    })()`);

  /** ④ 卡的状态徽标（`data-subagent-card-status` 只在 `name === "subagent"` 且认领到时才有） */
  const cardProbe = `(() => {
    const el = document.querySelector("[data-subagent-card-status]");
    const preview = document.querySelector("[data-subagent-preview]");
    return {
      status: el ? el.getAttribute("data-subagent-card-status") : null,
      text: el ? (el.textContent ?? "").trim() : "",
      cardText: el ? (el.closest("[data-tool-card]")?.textContent ?? "") : "",
      preview: preview ? (preview.textContent ?? "") : null,
    };
  })()`;

  /** 小目标入口的命中测试：它得**真的落在可视区且那一层就是它**（AGENTS.md §3.6/§五⑥） */
  const hitTest = (selector: string): Promise<boolean> =>
    run<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit === el || (hit !== null && hit.closest(${JSON.stringify(selector)}) === el);
    })()`);

  const escape = (): Promise<boolean> =>
    run<boolean>(`(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      return true;
    })()`);

  /**
   * 把 ④ 卡上的下钻入口滚进视口。
   *
   * 「点得到」在真实使用里的意思是「用户看得见才点」，而中栏是一列可滚的卡片，入口不一定
   * 落在视区里——不滚过去命中测试必然为假，那验的不是产品而是「用例忘了滚」
   * （AGENTS.md §五⑬：环境前提要显式建立）。滚过去之后的命中测试才有意义：它能抓出
   * 「被别的层盖住、点了到别处」这类真缺陷。
   */
  const showOpenButton = (id: string): Promise<unknown> =>
    run(`(() => {
      const el = document.querySelector('[data-subagent-open="${id}"]');
      if (el) el.scrollIntoView({ block: "center" });
      return null;
    })()`);

  /** 同上：把 ④ 卡面上的「中止」滚进视口，命中测试才有意义 */
  const scrollToAbort = (id: string): Promise<unknown> =>
    run(`(() => {
      const el = document.querySelector('[data-subagent-abort="${id}"]');
      if (el) el.scrollIntoView({ block: "center" });
      return null;
    })()`);

  try {
    window.reload();
    await sleep(4000);

    const list = await run<{ id: string }[]>(
      `window.colt.invoke("session.list", ${JSON.stringify({ projectId })})`,
    );
    if (list[0]?.id !== session.id) {
      log(`活动会话不是本会话（${list[0]?.id}），无法断言界面`);
      checks.push(["渲染层显示的是本会话", false]);
      return;
    }

    // ---- 0. 先推一份「没有子代理」的视图，确保右栏在「任务摘要」且展开 ----
    push({ subagents: [], running: false, runningTools: [] });
    await sleep(400);
    await clickDockTab("任务摘要");
    await sleep(300);

    // ---- 1. 不自动展开右栏（决策三 D5：子代理是模型自己发起的，不抢焦）----
    log("[决策三] 折叠右栏后推一个「有子代理在跑」的视图，预期**不**自动展开");
    await clickBySelector('button[aria-label="折叠工作区"]');
    await sleep(300);
    const beforePush = await run<{ collapsed: boolean | null }>(dockProbe);
    push({ subagents: [makeSubagent(runningId, runningCallId, "running", 20)] });
    await sleep(600);
    const afterPush = await run<{ collapsed: boolean | null }>(dockProbe);
    checks.push([
      "子代理启动**不**自动展开右栏（不抢焦；被看到已由 ④ 的卡保证）",
      beforePush.collapsed === true && afterPush.collapsed === true,
    ]);
    await clickBySelector('button[aria-label="展开工作区"]');
    await sleep(400);

    // ---- 2. ④ 的卡特化 + 有界预览 ----
    log("[④] 子代理卡特化 + 展开看到有界预览");
    const card = await run<{ status: string | null; cardText: string }>(cardProbe);
    checks.push([
      `④ 里出现**特化**的子代理卡（状态 ${card.status}，文案「子代理 · researcher」）`,
      card.status === "running" && card.cardText.includes("子代理 · researcher"),
    ]);
    const expanded = await expandSubagentCard();
    await sleep(400);
    const preview = await run<{ preview: string | null }>(cardProbe);
    checks.push(["点卡展开后出现有界预览", expanded && preview.preview !== null]);
    checks.push([
      "预览**如实**说明截断（「最近 12 步（共 20 步）」，不静默砍掉）",
      (preview.preview ?? "").includes("最近 12 步（共 20 步）"),
    ]);
    checks.push([
      "预览里画出了最近几步的内容",
      (preview.preview ?? "").includes("第 1 步"),
    ]);

    // ---- 3. 此刻动作只在 ④；「中止」也搬到了 ④ 的卡面上（v1.53）----
    log("[④/⑦] 此刻动作只在 ④ 的卡上；右栏不再重复列，「中止」也在卡上");
    await clickDockTab("任务摘要");
    await sleep(400);
    const dock = await run<{ text: string }>(dockProbe);
    checks.push([
      "右栏不再重复列此刻动作（「进行中的动作」段已移除，v1.53）",
      !dock.text.includes("进行中的动作"),
    ]);
    // 「中止」现在长在 ④ 的卡面上。中栏是一列可滚的卡片，先把它滚进视口——
    // 否则命中测试验的是「用例忘了滚」，不是产品（AGENTS.md §五⑬）。
    await scrollToAbort(runningId);
    await sleep(200);
    checks.push([
      "④ 子代理卡上给了「中止」入口，且它**真的落在可视区**",
      await hitTest(`[data-subagent-abort="${runningId}"]`),
    ]);
    // 点一次中止：worker 侧对一个不存在的 lane 是空操作，只要求不抛、不崩
    const abortedClick = await clickBySelector(`[data-subagent-abort="${runningId}"]`);
    await sleep(300);
    checks.push(["点「中止」不抛异常（会话没真跑，worker 侧按空操作收下）", abortedClick]);

    // ---- 3.5 运行中下钻：这一层走**实时通道**（有界），而不是拉一次就静止的快照 ----
    // 判据是「有实时容器、且**没有**一次性快照容器」——两者是互斥的两个真源，见 SubagentStream
    log("[下钻·运行中] 还在跑时点开 → 这一层跟着实时刷新（有界），并如实说明");
    await showOpenButton(runningId);
    await sleep(300);
    await clickBySelector(`[data-subagent-open="${runningId}"]`);
    await sleep(500);
    const live = await run<{ live: string | null; text: string; stream: boolean }>(`(() => {
      const el = document.querySelector("[data-subagent-live]");
      return {
        live: el ? el.getAttribute("data-subagent-live") : null,
        text: el ? (el.textContent ?? "") : "",
        stream: document.querySelector("[data-subagent-stream]") !== null,
      };
    })()`);
    checks.push([
      "运行中下钻走**实时**通道（不是「拉回来就静止」的快照）",
      live.live === runningId && !live.stream,
    ]);
    checks.push([
      "并**如实说明**这一层是实时但有界的（不假装完整）",
      live.text.includes("实时刷新") && live.text.includes("最近几步"),
    ]);
    await escape(); // 退出下钻，免得挡住下面 ④ 卡的断言
    await sleep(400);

    // ---- 4. 已结束：④ 的卡保留、状态转完成，且不再给「中止」 ----
    log("[已结束] 子代理跑完后：④ 的卡保留、状态转完成，中止入口消失");
    push({
      subagents: [makeSubagent(runningId, runningCallId, "completed", 20)],
      running: false,
      runningTools: [],
    });
    await sleep(600);
    const afterDone = await run<{ abort: string | null }>(
      `(() => { const el = document.querySelector("[data-subagent-abort]");
        return { abort: el ? el.getAttribute("data-subagent-abort") : null }; })()`,
    );
    checks.push([
      "已结束的子代理不再给「中止」（已结束的卡上不放点了没反应的按钮）",
      afterDone.abort === null,
    ]);
    const doneCard = await run<{ status: string | null; cardText: string }>(cardProbe);
    checks.push([
      `④ 的卡仍在、状态转为完成（实为 ${doneCard.status}）`,
      doneCard.cardText.includes("子代理 · researcher") && doneCard.status === "completed",
    ]);

    // ---- 5. 点 ④ 卡 → 下钻到子代理流；完整流按需拉，拉不到如实说 ----
    log("[⑦下钻] 点「在右栏查看完整过程」→ 子代理流层；完整流按需拉");
    // 深看入口要排在预览**之前**：预览有十来步，把它排在末尾等于把唯一的深看出口埋掉
    const order = await run<{ openFirst: boolean }>(`(() => {
      const open = document.querySelector('[data-subagent-open="${runningId}"]');
      const preview = document.querySelector("[data-subagent-preview]");
      if (!open || !preview) return { openFirst: false };
      const after = open.compareDocumentPosition(preview) & Node.DOCUMENT_POSITION_FOLLOWING;
      return { openFirst: after !== 0 };
    })()`);
    checks.push(["深看入口排在预览**之前**（不被十来步预览埋掉）", order.openFirst]);
    // 小目标入口先滚进视口，再验命中（判据与理由见 showOpenButton）
    await showOpenButton(runningId);
    await sleep(300);
    const openVisible = await hitTest(`[data-subagent-open="${runningId}"]`);
    const opened = await clickBySelector(`[data-subagent-open="${runningId}"]`);
    await sleep(800);
    const drill = await run<{ layer: string; crumb: boolean; panel: string; back: boolean }>(`(() => {
      const root = document.querySelector("[data-drill]");
      return {
        layer: root ? (root.getAttribute("data-drill") ?? "") : "",
        crumb: document.querySelector('[data-drill-crumb="subagent"]') !== null,
        back: document.querySelector("[data-drill-back]") !== null,
        panel: (document.querySelector("[data-drill-subagent]")?.textContent ?? "").trim(),
      };
    })()`);
    checks.push(["④ 卡上的下钻入口**真的落在可视区**（不只是「在 DOM 里」）", openVisible]);
    checks.push([
      `下钻落到**子代理流层**（层=${drill.layer}）`,
      opened && drill.layer === "subagent",
    ]);
    checks.push(["面包屑上标出这是子代理流", drill.crumb]);
    checks.push(["层底有「返回上一级」的出口", drill.back]);
    checks.push([
      "没有真实过程时**如实说**（不是白屏、也不是假装有内容）",
      drill.panel.includes("还没有留下过程记录"),
    ]);

    // ESC 逐层回退：回到「任务摘要」
    await escape();
    await sleep(500);
    const afterEsc = await run<{ drill: boolean }>(`(() => ({
      drill: document.querySelector("[data-drill]") !== null,
    }))()`);
    checks.push(["ESC 逐层回退回到「任务摘要」（下钻层消失）", afterEsc.drill === false]);

    // ---- 6. 按需拉的通道：查一个不存在的子代理 → 空数组而不是报错 ----
    log("[IPC] session.subagentTranscript 查一个不存在的子代理 → 空数组（界面按「没有内容」呈现）");
    const empty = await run<{ messages: unknown[]; toolResults: unknown[] }>(
      `window.colt.invoke("session.subagentTranscript", ${JSON.stringify({
        sessionId: session.id,
        id: "sub:ghost:nope",
      })})`,
    );
    checks.push([
      "不存在的子代理回空（不是错误通道——「没有内容」与「失败」是两件事）",
      Array.isArray(empty.messages) && empty.messages.length === 0,
    ]);

    checks.push(["全程未抛未捕获异常", uncaughtErrors.length === 0]);
  } catch (error) {
    checks.push([`未抛未捕获异常（实际：${String(error)}）`, false]);
    log(`异常：${String(error)}`);
  } finally {
    log("[subagent] 端到端断言");
    for (const [name, ok] of checks) log(`  ${ok ? "✓" : "✗"} ${name}`);
    log(`通过 ${checks.filter(([, ok]) => ok).length}/${checks.length}`);
  }
}
