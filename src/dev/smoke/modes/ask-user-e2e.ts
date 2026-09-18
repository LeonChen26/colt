// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 冒烟模式：ask-user-e2e
 *
 * `ask_user` 的**真实模型**端到端（打模型、计费，2 次调用左右）。
 *
 * 为什么必须有一条打模型的：这条链路里有两段**只有模型真的调用工具才走得到**——
 * ① worker 侧 `before_tool` 跳过 `ask_user` 的那条闸门守卫；
 * ② 「模型看见工具 → 发起问卷 → 答案回到模型 → 模型继续」这条往返。
 * 免费的 `ask-user` 模式（23 条）是从 `sessionManager.questions.enqueue()` **直接入队**，
 * 验的是入队之后的一切（卡片 / 选项 / 载荷 / 超时 / 回收）；**入队之前**那一段只有这里能验。
 *
 * 判据一律取自**主进程**（`getView` / `questions` / `approvals`）：渲染层是并发参与者
 * （挂载即自动打开 list[0] 的会话），把断言挂在它身上会把用例变成环境题。界面那一侧
 * 由免费模式覆盖——两边分工明确，别在这里重复一遍。
 *
 * 最贵的一条断言是 **full-access 下提问照样弹**：这正是「提问不复用审批通道」的
 * 唯一行为判据（`DESIGN-ask-user.md` §3）。若有人把 `ask_user` 并进只读白名单、
 * 或拆掉 `before_tool` 里那句跳过，模型会收到一个静默的「已通过」而不是答案——
 * 本用例当场变红（免费模式抓不到这一条：它自己直接入队，根本不经过闸门）。
 */
import { app, BrowserWindow } from "electron";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createSession, upsertProject } from "../../../main/db/repo";
import { sessionManager } from "../../../main/session-manager";
import { listProviders } from "../../../main/providers";
import { hasUsableProvider } from "@shared/model-ref";
import type { AskUserQuestion, ConversationView } from "@shared/worker-protocol";
import { sleep, uncaughtErrors } from "../context";

/**
 * 训练一个稳定触发的 prompt：把问题与选项都点名。
 *
 * 为什么不写「一个含糊需求、看模型自己会不会问」：本用例验的是**机制**（工具可见性、
 * 闸门、往返），不是模型的判断力；把问卷内容写死，断言才有确定的比对物。
 * 模型仍需自己把它翻成 schema（`header` / `options[].label/description`），这一步是真题。
 */
const PROMPT =
  "先不要动手改任何文件。请**用 ask_user 工具**问我一个问题：" +
  "标题「依赖策略」，问题「这次要不要顺便升级依赖版本？」，" +
  "两个选项：「要升级」与「先不动」，各自写一句说明。" +
  "等我回答之后再继续，并在最终回复里明确说出我选了什么。";

export async function runAskUserE2e(
  window: BrowserWindow,
  log: (message: string) => void,
  run: <T>(expression: string) => Promise<T>,
): Promise<void> {
  const fixtureDir = join(process.cwd(), "out", "smoke-ask-user-e2e-fixture");
  mkdirSync(fixtureDir, { recursive: true });
  // 与 memory-e2e 同一条路：把 worker 的生死交给渲染层（它挂载时自动打开「当前项目」
  // 的最新会话），而**不是**自己拿 session.open 去抢——冒烟直连会话 IPC 时渲染层是
  // 并发参与者：StrictMode 的挂载→卸载→重挂载会把就绪前的 worker 当场杀掉
  // （`AGENTS.md` §五末条）。所以这里刻意**不**把仓库项目顶回 list[0]。
  const project = upsertProject(fixtureDir);
  const session = createSession(project.id, join(app.getPath("userData"), "sessions", project.id));
  log(`夹具项目：${fixtureDir}`);
  log(`会话：${session.id}（项目：${project.name}）`);

  const checks: [string, boolean][] = [];

  /** 主进程直读视图：不绕渲染层（那条路受界面状态影响） */
  const getView = (): ConversationView | undefined => sessionManager.getView(session.id);

  /**
   * 等模型发起提问。
   *
   * 不能只用「等 running 变 false」：提问期间 lane **正是**阻塞在工具里（`running` 恒为 true），
   * 那才是正常态。所以这里等的是 `questions` 非空。
   * 另加一条**快速失败**：只有先看见 running=true、随后又 false，才算「本轮结束了却没提问」
   * ——否则会在 prompt 刚发出去、run 还没起来的那一刻误判成失败。
   */
  const waitQuestion = async (timeoutMs: number): Promise<string> => {
    const deadline = Date.now() + timeoutMs;
    let sawRunning = false;
    for (;;) {
      const pending = sessionManager.questions.list(session.id);
      if (pending.length > 0) return pending[0]!.toolCallId;
      const view = getView();
      if (view?.running === true) sawRunning = true;
      if (sawRunning && view !== undefined && !view.running) {
        const errored = view.toolResults.filter((item) => item.isError);
        log(`本轮终态：${JSON.stringify(view.lastRun)}`);
        for (const item of errored) log(`  工具报错：${item.output.slice(0, 400)}`);
        throw new Error("模型没有发起提问就结束了本轮（多半是没调用 ask_user）");
      }
      if (Date.now() > deadline) throw new Error(`等待模型提问超时（${timeoutMs}ms）`);
      await sleep(1000);
    }
  };

  /** 等一轮运行落定；判据同 memory-e2e：不在运行中，且出现了本轮的新助手消息或终态异常 */
  const waitSettled = async (before: number, timeoutMs: number): Promise<ConversationView> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const view = getView();
      if (view && !view.running) {
        const failed = view.lastRun !== null && view.lastRun.status !== "completed";
        const answered =
          view.messages.length > before &&
          view.messages.some((m, i) => i >= before && m.role === "assistant");
        if (failed || answered) {
          if (failed) log(`运行终态异常：${view.lastRun?.status}（${view.lastRun?.error ?? ""}）`);
          return view;
        }
      }
      if (Date.now() > deadline) throw new Error("等待运行结束超时");
      await sleep(2000);
    }
  };

  /** 从视图取最后一条助手回答 */
  const lastAnswer = (view: ConversationView): string => {
    for (let i = view.messages.length - 1; i >= 0; i -= 1) {
      const m = view.messages[i]!;
      if (m.role === "assistant" && m.text.trim() !== "") return m.text;
    }
    return "";
  };

  try {
    // 前置检查：没有可用模型时显式失败——真实调用验证不该静默跑成一场空（同 memory-e2e）
    if (!hasUsableProvider(listProviders())) {
      checks.push(["前置：存在已配密钥的模型服务（没有就无法真实调用）", false]);
      log("没有已配密钥的模型服务。请先在设置里配好一个服务再跑本模式。");
      return;
    }
    checks.push(["前置：存在已配密钥的模型服务", true]);

    window.reload();
    await sleep(4000);
    // 等渲染层自动打开夹具会话、worker 就绪（视图出现即就绪）
    const readyDeadline = Date.now() + 60_000;
    let opened = false;
    while (Date.now() < readyDeadline) {
      if (getView()) {
        opened = true;
        break;
      }
      await sleep(1000);
    }
    checks.push(["渲染层自动打开夹具会话（worker 就绪）", opened]);
    if (!opened) return;

    // 对抗条件：全权模式下提问**照样**要弹。审批在这档会静默放行，提问一旦流进审批通道，
    // 模型收到的就是「已通过」——这里跑的就是那个最贵的失败场景。
    await run(
      `window.colt.invoke("approval.mode.set", ${JSON.stringify({
        sessionId: session.id,
        mode: "full-access",
      })})`,
    );
    log("审批模式已设为 full-access（对抗条件）");

    const before = getView()?.messages.length ?? 0;
    await run(
      `window.colt.invoke("session.prompt", ${JSON.stringify({
        sessionId: session.id,
        text: PROMPT,
        cwd: fixtureDir,
      })})`,
    );
    log("已发出 prompt，等模型调用 ask_user…");

    const toolCallId = await waitQuestion(150_000);
    const request = sessionManager.questions.list(session.id).find((item) => item.toolCallId === toolCallId);
    if (request === undefined) throw new Error("提问刚出现又消失了（疑似被超时或中断收走）");
    const asked: AskUserQuestion[] = request.questions;

    checks.push(["模型真的调用了 ask_user（问卷进了待答队列）", asked.length > 0]);
    // 闸门：提问绝不能出现在审批队列里。这是「不复用审批通道」在当时那一瞬的物证
    checks.push([
      "提问没有流进审批通道（全权模式下也没被静默放行）",
      sessionManager.approvals.listPending(session.id).length === 0,
    ]);
    // worker 侧校验若没过会抛错（工具结果标 isError），根本走不到入队这一步
    checks.push([
      "问卷过了 worker 侧校验（每题都有正文与 ≥2 个带 label 的选项）",
      asked.every(
        (q) => q.question.trim() !== "" && q.options.length >= 2 && q.options.every((o) => o.label !== ""),
      ),
    ]);
    const askedText = asked.map((q) => q.question).join(" / ");
    const askedLabels = asked.flatMap((q) => q.options.map((o) => o.label));
    log(`  模型问：${askedText}`);
    log(`  选项：${askedLabels.join(" / ")}`);
    checks.push(["问的是 prompt 里点名的那一题（内容对得上）", askedText.includes("升级")]);

    // 作答：按键是**问题原文**（formatAnswers 就按它取值），值取「要升级」优先
    const target = asked[0]!;
    const chosen =
      target.options.find((o) => o.label.includes("升级"))?.label ?? target.options[0]!.label;
    const answers: Record<string, string> = {};
    for (const q of asked) {
      const option = q.options.find((o) => o.label === chosen) ?? q.options[0]!;
      answers[q.question] = q.multiSelect === true ? [option.label].join("、") : option.label;
    }
    await run(
      `window.colt.invoke("userquestion.answer", ${JSON.stringify({
        sessionId: session.id,
        toolCallId,
        answers,
      })})`,
    );
    await sleep(500);
    checks.push(["作答后待答队列已出队", sessionManager.questions.list(session.id).length === 0]);

    const view = await waitSettled(before, 180_000);
    // 往返的**确定性**判据落在工具结果上：模型可能不复述选项，但 formatAnswers 的产物是确定的
    const result = view.toolResults.find((item) => item.id === toolCallId);
    checks.push([
      "答案作为 ask_user 的工具结果回到模型（含「用户已回答」与所选 label）",
      result !== undefined &&
        result.isError === false &&
        result.output.includes("用户已回答") &&
        result.output.includes(chosen),
    ]);
    const answer = lastAnswer(view);
    log(`模型最终回复：${answer}`);
    checks.push(["模型接着往下做了（本轮 completed 且给出了新的助手消息）", view.lastRun?.status === "completed" && answer !== ""]);
    checks.push(["最终回复里认下了所选项（如实接住答案，而不是另起炉灶）", answer.includes(chosen)]);
    checks.push(["全程未抛未捕获异常", uncaughtErrors.length === 0]);
  } finally {
    // 免费用例不关会话（保持与其它模式一致），这里显式关掉：worker 里挂着真模型调用，
    // 别把它留给下一轮。运行中会被主进程拒绝，那就交给空闲回收。
    try {
      await run(
        `window.colt.invoke("session.close", ${JSON.stringify({ sessionId: session.id })})`,
      );
    } catch (error) {
      log(`关闭会话失败（无害）：${error instanceof Error ? error.message : String(error)}`);
    }
    log("[ask-user-e2e] 端到端断言");
    for (const [name, ok] of checks) log(`  ${ok ? "✓" : "✗"} ${name}`);
    log(`通过 ${checks.filter(([, ok]) => ok).length}/${checks.length}`);
  }
}
