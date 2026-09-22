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
 * v1.65 起卡片多了两个形态，各自都要有判据：**多题翻页**（一次只渲染当前题，
 * 「第 N / M 题」+ 上/下一题；翻回去时先前的选择必须还在）与**自由输入**（每题常驻一个
 * 输入框，与选项**合并**回传）。自填那条必须真派发 `input` 事件——React 受控 input 直接
 * 改 `value` 是收不到的，会「看着有字、组件的 state 是空的」（见 `typeAnswer` 的注释）。
 * 回车另有一条**只在中文环境下才会暴露**的判据：输入法合成中的回车是「确认候选词」，
 * 不能拿来翻页 / 提交——用 `KeyboardEventInit.isComposing` 显式构造来验（见 `pressEnter`）。
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
    /** 当前题的选项 label——多题时**只有当前题**在 DOM 里（平铺才是「一屏太长」的根因） */
    options: string[];
    pressed: string[];
    submitDisabled: boolean | null;
    skipDisabled: boolean | null;
    hasAlwaysAllow: boolean;
    text: string;
    /** 「第 N / M 题」；单题不出翻页控件，故为 null */
    page: string | null;
    prevDisabled: boolean | null;
    nextDisabled: boolean | null;
    /** 自由输入框的当前值；框不在时（不该发生）为 null */
    inputValue: string | null;
  }
  const EMPTY_PROBE: CardProbe = {
    cards: 0,
    options: [],
    pressed: [],
    submitDisabled: null,
    skipDisabled: null,
    hasAlwaysAllow: false,
    text: "",
    page: null,
    prevDisabled: null,
    nextDisabled: null,
    inputValue: null,
  };
  const probeCard = `(() => {
    const cards = [...document.querySelectorAll("[data-question-card]")];
    const card = cards[0];
    if (!card) return ${JSON.stringify(EMPTY_PROBE)};
    const opts = [...card.querySelectorAll("[data-question-option]")];
    const submit = card.querySelector("[data-question-submit]");
    const skip = card.querySelector("[data-question-skip]");
    const prev = card.querySelector("[data-question-prev]");
    const next = card.querySelector("[data-question-next]");
    const page = card.querySelector("[data-question-page]");
    const input = card.querySelector("[data-question-input]");
    return {
      cards: cards.length,
      options: opts.map((b) => b.getAttribute("data-question-option")),
      pressed: opts.filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.getAttribute("data-question-option")),
      submitDisabled: submit ? submit.disabled : null,
      skipDisabled: skip ? skip.disabled : null,
      hasAlwaysAllow: card.textContent.includes("始终允许"),
      text: card.textContent,
      page: page ? page.textContent.trim() : null,
      prevDisabled: prev ? prev.disabled : null,
      nextDisabled: next ? next.disabled : null,
      inputValue: input ? input.value : null,
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

  /** 翻页：控件不存在或已禁用时返回 false——断言据此分清「点不动」与「没点」 */
  const clickPage = (dir: "prev" | "next"): Promise<boolean> =>
    run<boolean>(
      `(() => {
        const b = document.querySelector(${JSON.stringify(`[data-question-${dir}]`)});
        if (!b || b.disabled) return false;
        b.click();
        return true;
      })()`,
    );

  /**
   * 往自由输入框打字。
   *
   * React 的受控 input **直接改 `value` 收不到**，得走原型上的 setter 再派发 input 事件
   * ——否则输入框看着有字、组件的 state 还是空的，提交时答案里没有那段文字（静默）。
   */
  const typeAnswer = (text: string): Promise<boolean> =>
    run<boolean>(
      `(() => {
        const input = document.querySelector("[data-question-input]");
        if (!input || input.disabled) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(input, ${JSON.stringify(text)});
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      })()`,
    );

  /**
   * 在自由输入框里敲回车。
   *
   * `composing` 用来模拟**输入法正在合成**（`KeyboardEventInit.isComposing`）——中文输入法里
   * 回车是「确认候选词」，产品要先看这个标记再决定翻页 / 提交。这条在英文环境下测不出来，
   * 只能靠派发事件显式构造。若这个构造不被识别，下面的「页码不动」那条会直接变红。
   */
  const pressEnter = (composing: boolean): Promise<boolean> =>
    run<boolean>(
      `(() => {
        const input = document.querySelector("[data-question-input]");
        if (!input || input.disabled) return false;
        input.focus();
        input.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Enter", bubbles: true, cancelable: true, isComposing: ${composing},
        }));
        return true;
      })()`,
    );

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

    // ---- 1. 真实入队 → 卡片出现；多题时**一次只渲染一题** ----
    sessionManager.questions.enqueue(session.id, "smoke-ask-1", QUESTIONS, 60_000);
    let probe: CardProbe = EMPTY_PROBE;
    for (let i = 0; i < 10; i += 1) {
      probe = await run<CardProbe>(probeCard);
      if (probe.cards > 0) break;
      await sleep(400);
    }
    checks.push([`提问卡出现在消息流里（找到 ${probe.cards} 张）`, probe.cards === 1]);
    checks.push([
      `首屏只渲染第 1 题（DOM 里是它的 2 个选项，实为 ${probe.options.length} 个：${probe.options.join("/")}）`,
      probe.options.length === 2 && probe.options.includes("Zustand") && probe.options.includes("Redux"),
    ]);
    // 「全在一页太长」的根因就是平铺——所以第 2 题的选项**此刻不该在 DOM 里**
    checks.push(["第 2 题的选项此刻不在 DOM 里（平铺会两题同屏）", !probe.options.includes("store.ts")]);
    checks.push([`页码写「第 1 / 2 题」（实为 ${JSON.stringify(probe.page)}）`, probe.page === "第 1 / 2 题"]);
    checks.push([
      "卡片写的是问题本身（不是「需要你的许可」那种审批文案）",
      probe.text.includes("用哪个库做状态管理？") && !probe.text.includes("需要你的许可"),
    ]);
    // 提问一旦带上「始终允许」，用户点下去等于永久静默提问——那是死控件，不该有
    checks.push(["没有「始终允许」按钮", probe.hasAlwaysAllow === false]);
    checks.push(["第 1 题上「上一题」不可点（翻到头就别摆一个点不动的按钮）", probe.prevDisabled === true]);
    checks.push(["第 1 题上「下一题」可点", probe.nextDisabled === false]);
    checks.push([
      `每题都有自由输入框、初始为空（实为 ${JSON.stringify(probe.inputValue)}）`,
      probe.inputValue === "",
    ]);
    checks.push(["未答完时「提交」不可点（不会提交半份答案）", probe.submitDisabled === true]);
    log(`  卡片选项：${probe.options.join(" / ")}`);

    // ---- 2. 选项是活的 + 翻页：翻过去只剩那一题，翻回来选择还在 ----
    const picked = await run<boolean>(clickOption("Zustand"));
    await sleep(200);
    const afterPick = await run<CardProbe>(probeCard);
    checks.push(["点选项后真的被选中（aria-pressed）", picked && afterPick.pressed.includes("Zustand")]);
    checks.push(["只答了一题时仍不可提交", afterPick.submitDisabled === true]);

    const wentNext = await clickPage("next");
    await sleep(250);
    const page2 = await run<CardProbe>(probeCard);
    checks.push([
      `点「下一题」翻到第 2 题（页码 ${JSON.stringify(page2.page)}，选项 ${page2.options.join("/")}）`,
      wentNext &&
        page2.page === "第 2 / 2 题" &&
        ["store.ts", "view.tsx", "api.ts"].every((label) => page2.options.includes(label)) &&
        !page2.options.includes("Zustand"),
    ]);
    checks.push(["最后一题上「下一题」不可点", page2.nextDisabled === true]);

    // 多选：连点两个，两个都要在
    await run<boolean>(clickOption("store.ts"));
    await run<boolean>(clickOption("api.ts"));
    await sleep(200);
    const afterMulti = await run<CardProbe>(probeCard);
    checks.push([
      "多选可同时选中两个",
      afterMulti.pressed.includes("store.ts") && afterMulti.pressed.includes("api.ts"),
    ]);

    // 回翻：第 1 题的选中必须还在——翻页不能把答案弄丢
    const wentBack = await clickPage("prev");
    await sleep(250);
    const backTo1 = await run<CardProbe>(probeCard);
    checks.push([
      "翻回第 1 题时先前的选择还在（翻页不丢答案）",
      wentBack && backTo1.page === "第 1 / 2 题" && backTo1.pressed.includes("Zustand"),
    ]);
    // 回车（翻页）：先派发一次**合成中**的回车（输入法确认候选词），页码必须不动；
    // 再派发真正的回车，才该翻到第 2 题
    const composingEnter = await pressEnter(true);
    await sleep(200);
    const afterComposing = await run<CardProbe>(probeCard);
    checks.push([
      `输入法合成中的回车不算确认、页码不动（仍在 ${JSON.stringify(afterComposing.page)}）`,
      composingEnter && afterComposing.page === "第 1 / 2 题",
    ]);
    const enterAdvance = await pressEnter(false);
    await sleep(250);
    const backTo2 = await run<CardProbe>(probeCard);
    checks.push([
      "在输入框里按回车翻到第 2 题（且两题都答过后才可提交）",
      enterAdvance && backTo2.page === "第 2 / 2 题" && backTo2.submitDisabled === false,
    ]);

    // ---- 3. 自由输入与选项**合并**回传；提交载荷要与作答一致 ----
    //
    // 让第 2 题同时有「两个选项 + 一段自填」——这正是「合并」口径的判据
    // （自填不清空已选，拼成「store.ts、api.ts、顺便改 README」）。
    const typed = await typeAnswer("顺便改 README");
    await sleep(200);
    const afterTyped = await run<CardProbe>(probeCard);
    checks.push([
      `自填的文字真的进了输入框（实为 ${JSON.stringify(afterTyped.inputValue)}）`,
      typed && afterTyped.inputValue === "顺便改 README",
    ]);
    checks.push([
      "自填**不清空**已选（是合并，不是二选一）",
      afterTyped.pressed.includes("store.ts") && afterTyped.pressed.includes("api.ts"),
    ]);

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
      "多选 + 自填合并成「选中项、选中项、自填」回传（模型读到的就是这一串）",
      captured?.answers["要一起改哪些文件？"] === "store.ts、api.ts、顺便改 README",
    ]);
    checks.push(["作答后待答队列已出队", (await pendingCount()) === 0]);

    // 卡片随落定消失：答案由随后的工具结果承载，不留一张过期的悬空卡
    const gone = await run<CardProbe>(probeCard);
    checks.push(["落定后卡片立即消失（不留悬空卡）", gone.cards === 0]);

    // ---- 4. 边界输入：单题不出翻页控件、只输入也能作答；空问卷不许白屏 ----
    //
    // 选项是模型的建议、不是封闭集，所以「直接写」必须能提交（`composeAnswer` 的
    // 「自填可独立作答」那条规则）；单题也不该白摆一行「第 1 / 1 题」。
    const singleCalls: { answers: Record<string, string> }[] = [];
    const realAnswerSingle = sessionManager.questions.answer.bind(sessionManager.questions);
    sessionManager.questions.answer = (sessionId, toolCallId, answers) => {
      singleCalls.push({ answers });
      realAnswerSingle(sessionId, toolCallId, answers);
    };
    sessionManager.questions.enqueue(session.id, "smoke-ask-2", [QUESTIONS[0]], 60_000);
    await sleep(800);
    const single = await run<CardProbe>(probeCard);
    checks.push([
      "单题时不出翻页控件（页码 / 上下一题都不在）",
      single.cards === 1 && single.page === null && single.prevDisabled === null && single.nextDisabled === null,
    ]);
    checks.push(["单题未答时不可提交", single.submitDisabled === true]);
    await typeAnswer("用 Jotai");
    await sleep(200);
    const singleTyped = await run<CardProbe>(probeCard);
    checks.push(["单题：只输入文字即算答过（不必先点选项）", singleTyped.submitDisabled === false]);
    // 单题即末页：这里的回车要**提交**（「点按钮提交」已在上面的两题流程里验过）
    const singleSubmit = await pressEnter(false);
    await sleep(600);
    sessionManager.questions.answer = realAnswerSingle;
    checks.push([
      `单题：末页按回车即提交，回传的就是自填的那句话（实为 ${JSON.stringify(singleCalls[0]?.answers ?? null)}）`,
      singleSubmit && singleCalls[0]?.answers["用哪个库做状态管理？"] === "用 Jotai",
    ]);

    // 空问卷：worker 的校验强制 1~4 题，产品路径走不到，但卡片必须**早退**而不是崩
    // （`questions[-1]` → 读 `.header` → 整棵渲染树白屏）。判据取「卡片 0 张 **且**
    // 主界面仍在」——只看前者的话，「树整个崩掉、什么都查不到」也会算通过（见 AGENTS §五⑫）。
    sessionManager.questions.enqueue(session.id, "smoke-ask-empty", [], 60_000);
    await sleep(500);
    const empty = await run<{ cards: number; uiAlive: boolean }>(
      `({
        cards: document.querySelectorAll("[data-question-card]").length,
        uiAlive: document.querySelector("[data-conv-card]") !== null,
      })`,
    );
    sessionManager.questions.cancelAll(session.id);
    await sleep(300);
    checks.push([
      `空问卷不画卡、也不白屏（卡片 ${empty.cards} 张，主界面${empty.uiAlive ? "仍在" : "**没了**"}）`,
      empty.cards === 0 && empty.uiAlive,
    ]);

    // ---- 5. 跳过：明确的不回答，且与「中断」是两档 ----
    const skipCalls: string[] = [];
    const realSkip = sessionManager.questions.skip.bind(sessionManager.questions);
    sessionManager.questions.skip = (sessionId, toolCallId) => {
      skipCalls.push(toolCallId);
      realSkip(sessionId, toolCallId);
    };
    sessionManager.questions.enqueue(session.id, "smoke-ask-3", [QUESTIONS[0]], 60_000);
    await sleep(800);
    const beforeSkip = await run<CardProbe>(probeCard);
    const skippedClick = await run<boolean>(clickSkip);
    await sleep(600);
    sessionManager.questions.skip = realSkip;
    checks.push(["跳过按钮可见且可点", beforeSkip.cards === 1 && skippedClick]);
    // 走的必须是 skip（→ skipped），不是 cancelAll（→ cancelled）：前者告诉模型「按假设继续」，
    // 后者告诉它「对话断了」，对模型是两件完全不同的事
    checks.push(["点「跳过」走的是 skip 这一档（不是当作中断）", skipCalls[0] === "smoke-ask-3"]);
    checks.push(["跳过后队列已出队", (await pendingCount()) === 0]);

    // ---- 6. 超时：不作答也会自己收尾，不会永远挂着 ----
    sessionManager.questions.enqueue(session.id, "smoke-ask-4", [QUESTIONS[0]], 1_200);
    await sleep(400);
    const beforeTimeout = await run<CardProbe>(probeCard);
    await sleep(2_500);
    const afterTimeout = await run<CardProbe>(probeCard);
    checks.push(["超时前卡片在", beforeTimeout.cards === 1]);
    checks.push(["超时后卡片收起、队列清空（模型不会干等）", afterTimeout.cards === 0 && (await pendingCount()) === 0]);

    // ---- 7. 全权模式下提问仍然要弹（这条链路最贵的一个陷阱）----
    sessionManager.approvals.setMode("full-access", session.id);
    sessionManager.questions.enqueue(session.id, "smoke-ask-5", [QUESTIONS[0]], 60_000);
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

    // ---- 8. worker 被回收：提问队列必须跟着清（与审批对称）----
    //
    // 审批在 worker 消失时会被 `clearPending` 收掉，提问原先漏了这一处：卡片会留到 5 分钟超时，
    // 且该会话一直被算作「有人在等」——任务栏会一直闪（一个持续撒谎的信号）。
    // 提问挂着时 worker 仍是「空闲」的（本模式从没发过 prompt），所以 close 能走通到 #disposeWorker。
    sessionManager.questions.enqueue(session.id, "smoke-ask-6", [QUESTIONS[0]], 60_000);
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
