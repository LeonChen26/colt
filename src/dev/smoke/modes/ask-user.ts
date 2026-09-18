// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 冒烟模式：ask-user
 *
 * 验证「模型提问 → 卡片 → 作答 / 跳过 / 超时」这条链路，**不跑模型、不计费**。
 *
 * 为什么必须有一条真渲染层的冒烟：这条链路的失败模式几乎都是**静默**的——
 * 事件名写错、订阅时机不对、答案键名对不上，单测全绿而界面上一张卡都不出现
 * （或出现了但按钮点不出东西）。所以判据全部落在「DOM 里真的有这张卡」与
 * 「主进程真的收到了那个答案载荷」上，不看 class。
 *
 * 驱动方式与 dock 一致：提问走**产品里同一条路**——`sessionManager.questions.enqueue()`
 * 正是 worker 发来 `askUserRequest` 时主进程调用的那个函数，之后 store 推 `userquestion.pending`
 * 事件由渲染层订阅。作答同理，用主进程打桩（`questions.answer`）读回载荷，
 * 而不是去猜渲染层发了什么。
 *
 * 已知边界（写明，免得被当成覆盖到了）：worker 侧 `before_tool` 跳过 `ask_user` 的那条守卫
 * 要模型真的调用工具才会走到，这里测不到；它由 `tests/ask-user.test.ts` 的
 * 「不进只读白名单」与 `entry.ts` 里的注释共同钉住，端到端的全权模式回归仍需打模型。
 * 第 7 段走的是**主动 dispose**（`sessionManager.close`）那条收尾路径；
 * **意外崩溃**（未标 disposeReason 就退出）那一支仍未覆盖——要它得真把 worker 杀掉，
 * 两条路径的清理调用是同一处写法（见 `session-manager.ts` 的两处 `cancelAll`）。
 */
import { BrowserWindow } from "electron";
import { createSession } from "../../../main/db/repo";
import { sessionManager } from "../../../main/session-manager";
import type { AskUserQuestion } from "@shared/worker-protocol";
import { sleep, uncaughtErrors } from "../context";

/** 两题：一题单选、一题多选——多选的「、」拼接是模型看到的最终字符串，必须一起验 */
const QUESTIONS: AskUserQuestion[] = [
  {
    question: "用哪个库做状态管理？",
    header: "状态管理",
    options: [
      { label: "Zustand", description: "轻、样板代码少" },
      { label: "Redux", description: "生态大、约束强" },
    ],
  },
  {
    question: "要一起改哪些文件？",
    header: "改动范围",
    multiSelect: true,
    options: [
      { label: "store.ts", description: "" },
      { label: "view.tsx", description: "" },
      { label: "api.ts", description: "" },
    ],
  },
];

export async function runAskUser(
  window: BrowserWindow,
  projectId: string,
  sessionsDir: string,
  log: (message: string) => void,
  run: <T>(expression: string) => Promise<T>,
): Promise<void> {
  const session = createSession(projectId, sessionsDir);
  log(`会话：${session.id}`);

  const checks: [string, boolean][] = [];

  /** 渲染层里那张卡的状态（不依赖 class，只用 data 钩子与可见文本） */
  interface CardProbe {
    cards: number;
    options: string[];
    pressed: string[];
    submitDisabled: boolean | null;
    skipDisabled: boolean | null;
    hasAlwaysAllow: boolean;
    text: string;
  }
  const probeCard = `(() => {
    const cards = [...document.querySelectorAll("[data-question-card]")];
    const card = cards[0];
    if (!card) {
      return { cards: 0, options: [], pressed: [], submitDisabled: null, skipDisabled: null, hasAlwaysAllow: false, text: "" };
    }
    const opts = [...card.querySelectorAll("[data-question-option]")];
    const submit = card.querySelector("[data-question-submit]");
    const skip = card.querySelector("[data-question-skip]");
    return {
      cards: cards.length,
      options: opts.map((b) => b.getAttribute("data-question-option")),
      pressed: opts.filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.getAttribute("data-question-option")),
      submitDisabled: submit ? submit.disabled : null,
      skipDisabled: skip ? skip.disabled : null,
      hasAlwaysAllow: card.textContent.includes("始终允许"),
      text: card.textContent,
    };
  })()`;

  /** 点一个选项（用真实 click，走 React 的合成事件；直接改 DOM 属性不算点过） */
  const clickOption = (label: string): string =>
    `(() => {
      const b = [...document.querySelectorAll("[data-question-option]")]
        .find((x) => x.getAttribute("data-question-option") === ${JSON.stringify(label)});
      if (!b || b.disabled) return false;
      b.click();
      return true;
    })()`;

  const clickSubmit = `(() => {
    const b = document.querySelector("[data-question-submit]");
    if (!b || b.disabled) return false;
    b.click();
    return true;
  })()`;

  const clickSkip = `(() => {
    const b = document.querySelector("[data-question-skip]");
    if (!b || b.disabled) return false;
    b.click();
    return true;
  })()`;

  const pendingCount = (): Promise<number> =>
    run<number>(
      `window.colt.invoke("userquestion.list", ${JSON.stringify({ sessionId: session.id })}).then((l) => l.length)`,
    );

  try {
    window.reload();
    await sleep(4000);

    // 渲染层显示的是 session.list 的第一条（updated_at DESC），也就是刚建的这个
    const list = await run<{ id: string }[]>(
      `window.colt.invoke("session.list", ${JSON.stringify({ projectId })})`,
    );
    if (list[0]?.id !== session.id) {
      log(`活动会话不是本会话（${list[0]?.id}），无法断言界面`);
      checks.push(["渲染层显示的是本会话", false]);
      return;
    }

    // ---- 1. 真实入队 → 卡片出现 ----
    sessionManager.questions.enqueue(session.id, "smoke-ask-1", QUESTIONS, 60_000);
    let probe: CardProbe = { cards: 0, options: [], pressed: [], submitDisabled: null, skipDisabled: null, hasAlwaysAllow: false, text: "" };
    for (let i = 0; i < 10; i += 1) {
      probe = await run<CardProbe>(probeCard);
      if (probe.cards > 0) break;
      await sleep(400);
    }
    checks.push([`提问卡出现在消息流里（找到 ${probe.cards} 张）`, probe.cards === 1]);
    checks.push(["卡片列出了两题的全部 5 个选项", probe.options.length === 5]);
    checks.push([
      "卡片写的是问题本身（不是「需要你的许可」那种审批文案）",
      probe.text.includes("用哪个库做状态管理？") && !probe.text.includes("需要你的许可"),
    ]);
    // 提问一旦带上「始终允许」，用户点下去等于永久静默提问——那是死控件，不该有
    checks.push(["没有「始终允许」按钮", probe.hasAlwaysAllow === false]);
    checks.push(["未答完时「提交」不可点（不会提交半份答案）", probe.submitDisabled === true]);
    log(`  卡片选项：${probe.options.join(" / ")}`);

    // ---- 2. 选项是活的：点了要真的选中 ----
    const picked = await run<boolean>(clickOption("Zustand"));
    await sleep(200);
    const afterPick = await run<CardProbe>(probeCard);
    checks.push(["点选项后真的被选中（aria-pressed）", picked && afterPick.pressed.includes("Zustand")]);
    checks.push(["只答了一题时仍不可提交", afterPick.submitDisabled === true]);

    // 多选：连点两个，两个都要在
    await run<boolean>(clickOption("store.ts"));
    await run<boolean>(clickOption("api.ts"));
    await sleep(200);
    const afterMulti = await run<CardProbe>(probeCard);
    checks.push([
      "多选可同时选中两个",
      afterMulti.pressed.includes("store.ts") && afterMulti.pressed.includes("api.ts"),
    ]);
    checks.push(["答完之后「提交」可点", afterMulti.submitDisabled === false]);

    // ---- 3. 提交：主进程收到的载荷要与选择一致 ----
    //
    // 在 `sessionManager` 上打桩记账（同 dock 的 `/compact` 那套）。与 dock 不同的是这里
    // **要转发**给真实现：待答队列是否真的出队、卡片是否真的收起，都发生在真实现里，
    // 而这次转发没有任何代价——它只是把一条 `askUserResult` 发给空闲的 worker，
    // 既不调模型也不写会话历史。
    const answerCalls: { toolCallId: string; answers: Record<string, string> }[] = [];
    const realAnswer = sessionManager.questions.answer.bind(sessionManager.questions);
    sessionManager.questions.answer = (sessionId, toolCallId, answers) => {
      answerCalls.push({ toolCallId, answers });
      realAnswer(sessionId, toolCallId, answers);
    };
    const submitted = await run<boolean>(clickSubmit);
    await sleep(600);
    sessionManager.questions.answer = realAnswer;
    const captured = answerCalls[0];
    checks.push(["点了「提交」且渲染层真的发出了作答", submitted && captured !== undefined]);
    checks.push([
      `答案键是问题原文、值是所选 label（实为 ${JSON.stringify(captured?.answers ?? null)}）`,
      captured?.answers["用哪个库做状态管理？"] === "Zustand",
    ]);
    checks.push([
      "多选以「、」相连回传（模型读到的就是这一串）",
      captured?.answers["要一起改哪些文件？"] === "store.ts、api.ts",
    ]);
    checks.push(["作答后待答队列已出队", (await pendingCount()) === 0]);

    // 卡片随落定消失：答案由随后的工具结果承载，不留一张过期的悬空卡
    const gone = await run<CardProbe>(probeCard);
    checks.push(["落定后卡片立即消失（不留悬空卡）", gone.cards === 0]);

    // ---- 4. 跳过：明确的不回答，且与「中断」是两档 ----
    const skipCalls: string[] = [];
    const realSkip = sessionManager.questions.skip.bind(sessionManager.questions);
    sessionManager.questions.skip = (sessionId, toolCallId) => {
      skipCalls.push(toolCallId);
      realSkip(sessionId, toolCallId);
    };
    sessionManager.questions.enqueue(session.id, "smoke-ask-2", [QUESTIONS[0]], 60_000);
    await sleep(800);
    const beforeSkip = await run<CardProbe>(probeCard);
    const skippedClick = await run<boolean>(clickSkip);
    await sleep(600);
    sessionManager.questions.skip = realSkip;
    checks.push(["跳过按钮可见且可点", beforeSkip.cards === 1 && skippedClick]);
    // 走的必须是 skip（→ skipped），不是 cancelAll（→ cancelled）：前者告诉模型「按假设继续」，
    // 后者告诉它「对话断了」，对模型是两件完全不同的事
    checks.push(["点「跳过」走的是 skip 这一档（不是当作中断）", skipCalls[0] === "smoke-ask-2"]);
    checks.push(["跳过后队列已出队", (await pendingCount()) === 0]);

    // ---- 5. 超时：不作答也会自己收尾，不会永远挂着 ----
    sessionManager.questions.enqueue(session.id, "smoke-ask-3", [QUESTIONS[0]], 1_200);
    await sleep(400);
    const beforeTimeout = await run<CardProbe>(probeCard);
    await sleep(2_500);
    const afterTimeout = await run<CardProbe>(probeCard);
    checks.push(["超时前卡片在", beforeTimeout.cards === 1]);
    checks.push(["超时后卡片收起、队列清空（模型不会干等）", afterTimeout.cards === 0 && (await pendingCount()) === 0]);

    // ---- 6. 全权模式下提问仍然要弹（这条链路最贵的一个陷阱）----
    sessionManager.approvals.setMode("full-access", session.id);
    sessionManager.questions.enqueue(session.id, "smoke-ask-4", [QUESTIONS[0]], 60_000);
    await sleep(800);
    const fullAccess = await run<CardProbe>(probeCard);
    checks.push([
      "full-access 模式下提问照样弹卡（审批策略管不到提问）",
      fullAccess.cards === 1,
    ]);
    sessionManager.questions.cancelAll(session.id);
    await sleep(400);
    const afterCancel = await run<CardProbe>(probeCard);
    checks.push(["中断会话后卡片清掉、队列清空", afterCancel.cards === 0 && (await pendingCount()) === 0]);

    // ---- 7. worker 被回收：提问队列必须跟着清（与审批对称）----
    //
    // 审批在 worker 消失时会被 `clearPending` 收掉，提问原先漏了这一处：卡片会留到 5 分钟超时，
    // 且该会话一直被算作「有人在等」——任务栏会一直闪（一个持续撒谎的信号）。
    // 提问挂着时 worker 仍是「空闲」的（本模式从没发过 prompt），所以 close 能走通到 #disposeWorker。
    sessionManager.questions.enqueue(session.id, "smoke-ask-5", [QUESTIONS[0]], 60_000);
    await sleep(800);
    const beforeClose = await run<CardProbe>(probeCard);
    const closed = sessionManager.close(session.id);
    await sleep(400);
    const afterClose = await run<CardProbe>(probeCard);
    checks.push([
      "worker 被回收后卡片清掉、队列清空（不留幽灵卡）",
      beforeClose.cards === 1 && closed && afterClose.cards === 0 && (await pendingCount()) === 0,
    ]);

    checks.push(["全程未抛未捕获异常", uncaughtErrors.length === 0]);
  } finally {
    log("[ask-user] 端到端断言");
    for (const [name, ok] of checks) log(`  ${ok ? "✓" : "✗"} ${name}`);
    log(`通过 ${checks.filter(([, ok]) => ok).length}/${checks.length}`);
  }
}
