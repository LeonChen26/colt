// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 冒烟模式：todo-e2e
 *
 * 待办清单的**真实模型**端到端（打模型、计费，3 次调用左右）。
 *
 * 为什么必须有一条打模型的：`todo` 模式（免模型，26 条）是从 `hostBridge.handle` **直接写入**，
 * 验的是「写入之后」的一切（库 / 视图 / 界面 / 重启）；**写入之前**那段只有这里能验：
 *
 * 1. **注入是否真的发生**：`renderTodoBlock` 的产物必须出现在**该次请求**的系统提示词里。
 *    单测只能钉住纯函数（拼出来是什么样），拼的这一步在 `worker/entry.ts` 的
 *    `transform_context` 里——内核不会替我们调用，漏接的话模型什么都看不到而全链路无报错。
 * 2. **工具是否真的可见**：模型能不能看见并调用 `todo`，走完 toolRpc → 主进程 → 数据库。
 * 3. **重启后补发**：`ready` 把库里的清单推给新 worker（`todoSnapshot`）——镜像推送在
 *    worker 不在时会被丢弃，这条「补发」是重启后模型仍看得见清单的唯一保证。
 *
 * 判据一律落在**模型最终答出来的内容**上，而不是「快照被收到了」：
 * 清单用例用**随机 token** 作为纸条，token 从不进入 transcript（由主进程旁路写入），
 * 模型只可能从注入块里看到它；答出来 = 注入确实到了模型手里。
 *
 * ⚠️ 与其它 e2e 一样，模型服从是概率事件：整条可重试；「没调工具就结束本轮」按失败记，
 * 不静默放过（`AGENTS.md` §四）。
 *
 * 界面那一侧**不在这里重复**（免费 `todo` 模式已覆盖）：本模式只看主进程视图与库。
 */
import { app, BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createSession, listSessionTodos, upsertProject } from "../../../main/db/repo";
import { hostBridge } from "../../../main/host";
import { sessionManager } from "../../../main/session-manager";
import { listProviders } from "../../../main/providers";
import { hasUsableProvider } from "@shared/model-ref";
import { TODO_TOOL_NAME } from "@shared/todo";
import type { ConversationView } from "@shared/worker-protocol";
import { sleep, uncaughtErrors } from "../context";

export async function runTodoE2e(
  window: BrowserWindow,
  log: (message: string) => void,
  run: <T>(expression: string) => Promise<T>,
): Promise<void> {
  const fixtureDir = join(process.cwd(), "out", "smoke-todo-e2e-fixture");
  mkdirSync(fixtureDir, { recursive: true });
  const project = upsertProject(fixtureDir);
  const session = createSession(project.id, join(app.getPath("userData"), "sessions", project.id));
  log(`夹具项目：${fixtureDir}`);
  log(`会话：${session.id}（项目：${project.name}）`);

  // 一次运行一个随机前缀：token 从不进入 transcript，模型只能从注入块里看到它
  const prefix = `PLAN-${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
  const tokenPending = `${prefix}-A`; // 待办条目的 subject（写入即推送 → 首请求可见）
  const tokenRunning = `${prefix}-B`; // 进行中条目的 activeForm（证明注入取的是 activeForm）
  const tokenTool = `${prefix}-C`; // 模型经 todo 工具新建的条目
  const tokenRestart = `${prefix}-D`; // worker 不在时写入，只能靠 ready 补发

  const checks: [string, boolean][] = [];
  /** 本轮里「不该出现的审批」：todo 出现 = 白名单失效；别的工具 = 模型跑偏 */
  const todoApprovals: string[] = [];
  const strayApprovals: string[] = [];

  const getView = (): ConversationView | undefined => sessionManager.getView(session.id);
  const call = (action: string, params: Record<string, unknown> = {}): Promise<{ text: string }> =>
    hostBridge.handle({ sessionId: session.id, capability: "todo", action, params });

  const lastAnswer = (view: ConversationView): string => {
    for (let i = view.messages.length - 1; i >= 0; i -= 1) {
      const message = view.messages[i]!;
      if (message.role === "assistant" && message.text.trim() !== "") return message.text;
    }
    return "";
  };

  /**
   * 兜住「模型没按指示、动了别的工具」：审批卡会一直等到超时（默认两分钟），
   * 那条路径既慢又只报一次超时，看不出真实原因。这里一律**拒绝并记账**，
   * 让模型收到明确的 block 后自己收尾；`todo` 若出现审批卡则单独记——那是产品缺陷。
   */
  const drainApprovals = (): void => {
    for (const request of sessionManager.approvals.listPending(session.id)) {
      if (request.toolName === TODO_TOOL_NAME) todoApprovals.push(request.toolCallId);
      else strayApprovals.push(request.toolName);
      sessionManager.resolveApproval({
        sessionId: session.id,
        toolCallId: request.toolCallId,
        approved: false,
        reason: "冒烟用例：本轮只允许 todo 工具",
      });
    }
  };

  /** 等一轮运行落定；判据同 memory-e2e：不在运行中，且出现了本轮的新助手消息或终态异常 */
  const waitRunSettled = async (before: number, timeoutMs: number): Promise<ConversationView> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      drainApprovals();
      const view = getView();
      if (view && !view.running) {
        const failed = view.lastRun !== null && view.lastRun.status !== "completed";
        const answered =
          view.messages.length > before &&
          view.messages.some((m, i) => i >= before && m.role === "assistant");
        if (failed || answered) {
          if (failed) {
            log(`运行终态异常：${view.lastRun?.status}（${view.lastRun?.error ?? ""}）`);
          }
          return view;
        }
      }
      if (Date.now() > deadline) throw new Error("等待运行结束超时");
      await sleep(2000);
    }
  };

  /** 发一轮真实 prompt（与用户同一条 IPC）并等它落定 */
  const askAndSettle = async (
    text: string,
    timeoutMs = 180_000,
  ): Promise<{ view: ConversationView; before: number; answer: string }> => {
    const before = getView()?.messages.length ?? 0;
    await run(
      `window.colt.invoke("session.prompt", ${JSON.stringify({ sessionId: session.id, text })})`,
    );
    const view = await waitRunSettled(before, timeoutMs);
    return { view, before, answer: lastAnswer(view) };
  };

  /** 本轮新增的工具调用（从视图投影里取，不另开旁路） */
  const newToolCalls = (view: ConversationView, before: number) =>
    view.messages
      .slice(before)
      .filter((message) => message.role === "assistant")
      .flatMap((message) => message.toolCalls);

  /** 等 worker 就绪：视图出现即 ready（与 ask-user-e2e 同一判据） */
  const waitReady = async (timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (getView()) return true;
      await sleep(1000);
    }
    return false;
  };

  try {
    // 前置检查：没有可用模型时显式失败——真实调用验证不该静默跑成一场空
    if (!hasUsableProvider(listProviders())) {
      checks.push(["前置：存在已配密钥的模型服务（没有就无法真实调用）", false]);
      log("没有已配密钥的模型服务。请先在设置里配好一个服务再跑本模式。");
      return;
    }
    checks.push(["前置：存在已配密钥的模型服务", true]);

    window.reload();
    await sleep(4000);
    const ready = await waitReady(60_000);
    checks.push(["渲染层自动打开夹具会话（worker 就绪）", ready]);
    if (!ready) return;

    // 留在**最严格的 approval 模式**：todo 只有真的在 READONLY_TOOLS 里才不会被拦。
    // 切 full-access 会把「白名单生效」这条证据一起放掉（§四：别把「表面改了」当成「行为变了」）。
    await run(
      `window.colt.invoke("approval.mode.set", ${JSON.stringify({
        sessionId: session.id,
        mode: "approval",
      })})`,
    );

    // ---- 1. 写入即推送 → 第一次请求就能在提示词里看见 ----
    // 两笔都由主进程旁路写入（与免费 todo 模式同一条路），token 不进 transcript：
    // 模型答得出来，只可能是注入块里看到了。
    await call("create", { subject: `核对注入 ${tokenPending}` });
    await call("create", { subject: "核对进行中条目", activeForm: `正在核对 ${tokenRunning}` });
    const seeded = listSessionTodos(session.id);
    await call("update", {
      id: seeded.find((item) => item.activeForm.includes(tokenRunning))!.id,
      status: "in_progress",
    });

    const tcInject = await askAndSettle(
      "测试开始。不要调用任何工具、不要读取任何文件。只根据你系统提示词里已有的待办清单回答：" +
        "把清单里每一条按原样逐字抄下来（包括进行中的那条，按它当前显示的文字写）。" +
        "每行一条，不要改写、不要补充。",
    );
    const injectCalls = newToolCalls(tcInject.view, tcInject.before);
    log(`TC-注入 回答：${tcInject.answer}`);
    checks.push([
      "注入：模型没有动用工具（动了就不是「注入可见」的证据）",
      injectCalls.length === 0,
    ]);
    checks.push([
      `注入：待办条目的原文到了模型手里（${tokenPending}）`,
      tcInject.answer.includes(tokenPending),
    ]);
    checks.push([
      `注入：进行中那条用的是 activeForm（${tokenRunning}）`,
      tcInject.answer.includes(tokenRunning),
    ]);

    // ---- 2. 模型真的看得见并调用 todo 工具（免审批 + 真往返）----
    const tcTool = await askAndSettle(
      "现在只使用 todo 工具，不要使用其它任何工具。请完成两件事：" +
        `① 新建一条待办，subject 必须逐字写成「工具写入 ${tokenTool}」；` +
        "② 然后按状态机顺序，先把它标成 in_progress、再标成 completed" +
        "（不允许从待办直接跳到已完成）。完成后用一句话告诉我结果。",
    );
    const toolCalls = newToolCalls(tcTool.view, tcTool.before);
    const toolResults = toolCalls.map((item) =>
      tcTool.view.toolResults.find((result) => result.id === item.id),
    );
    log(`TC-工具 回答：${tcTool.answer}`);
    for (const [index, item] of toolCalls.entries()) {
      const result = toolResults[index];
      log(
        `  工具 ${item.name} ${item.args.slice(0, 160)} → ` +
          `${result === undefined ? "无结果" : result.isError ? "错误" : "成功"}`,
      );
      if (result?.isError) log(`    ${result.output.slice(0, 300)}`);
    }
    checks.push([
      "模型真的调用了 todo（工具真的注册进了它的工具面）",
      toolCalls.some((item) => item.name === TODO_TOOL_NAME),
    ]);
    checks.push([
      "本轮只用了 todo（没有靠别的工具完成）",
      toolCalls.length > 0 && toolCalls.every((item) => item.name === TODO_TOOL_NAME),
    ]);
    // 只要求「至少一条成功」：校验失败走 throw 是**设计行为**（模型看到报错后按正确写法重发），
    // 把「自纠过程中的一次报错」判成产品缺陷，会把模型服从度当成宿主分发坏了。
    checks.push([
      "todo 至少有一条成功结果（参数校验与宿主分发真的通了）",
      toolResults.some((result) => result?.isError === false),
    ]);
    checks.push([
      "todo 没有触发审批卡（名字真的在只读白名单里）",
      todoApprovals.length === 0,
    ]);
    checks.push(["没有别的工具被审批拦下（模型没跑偏）", strayApprovals.length === 0]);
    checks.push([
      "工具结果回的是整份清单（模型据此决策下一次改哪条）",
      toolResults.some((result) => (result?.output ?? "").includes(tokenPending)),
    ]);
    const written = listSessionTodos(session.id).find((item) => item.subject.includes(tokenTool));
    checks.push(["模型写进库的待办在真源里（worker → host → DB 真往返）", written !== undefined]);
    checks.push(["模型按指示把它标成了 completed", written?.status === "completed"]);

    // ---- 3. worker 重启：ready 补发 → 镜像 → 注入 ----
    // 先把 worker 关掉再写入：镜像推送会被丢弃，新条目只能靠 `ready` 补发。
    const closed = await run<{ closed: boolean }>(
      `window.colt.invoke("session.close", ${JSON.stringify({ sessionId: session.id })})`,
    );
    checks.push(["重启前置：worker 已关掉", closed.closed === true]);
    await sleep(500);
    await call("create", { subject: `重启后补发 ${tokenRestart}` });
    checks.push([
      "worker 不在时写入仍落库（真源不是 worker 内存）",
      listSessionTodos(session.id).some((item) => item.subject.includes(tokenRestart)),
    ]);
    await run(
      `window.colt.invoke("session.open", ${JSON.stringify({ sessionId: session.id })})`,
    );
    const reopened = await waitReady(60_000);
    checks.push(["worker 重新就绪", reopened]);
    if (!reopened) return;
    checks.push([
      "重启后视图里有离线写入的那条（ready 读的是库里的最新一份）",
      (getView()?.todos ?? []).some((item) => item.subject.includes(tokenRestart)),
    ]);

    const tcRestart = await askAndSettle(
      "不要调用任何工具、不要读取任何文件，也不要参考对话历史里的工具结果。" +
        "只看你**系统提示词**里的待办清单，把里面每一条按原样逐字抄下来。" +
        "每行一条，不要改写、不要补充。",
    );
    log(`TC-重启 回答：${tcRestart.answer}`);
    checks.push([
      "重启后的第一次请求就看得见离线写入的条目（ready → 镜像 → 注入）",
      tcRestart.answer.includes(tokenRestart),
    ]);
    checks.push([
      "重启后模型也没有动用工具",
      newToolCalls(tcRestart.view, tcRestart.before).length === 0,
    ]);

    checks.push(["全程未抛未捕获异常", uncaughtErrors.length === 0]);
  } catch (error) {
    log(`用例异常：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    checks.push(["用例未抛异常", false]);
  } finally {
    // 显式关掉：worker 里挂着真模型调用，别把它留给下一轮
    try {
      await run(
        `window.colt.invoke("session.close", ${JSON.stringify({ sessionId: session.id })})`,
      );
    } catch (error) {
      log(`关闭会话失败（无害）：${error instanceof Error ? error.message : String(error)}`);
    }
    log("[todo-e2e] 端到端断言");
    for (const [name, ok] of checks) log(`  ${ok ? "✓" : "✗"} ${name}`);
    log(`通过 ${checks.filter(([, ok]) => ok).length}/${checks.length}`);
  }
}
