// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 冒烟模式：todo —— 待办清单的跨进程链路与界面，**不跑模型、不计费**。
 *
 * 为什么必须有一条真渲染层的冒烟：这条链路的失败模式几乎全是**静默**的——
 * 工具名与白名单对不上、宿主能力忘了分发、写入没失效缓存、视图契约加了字段而下游没跟上、
 * 「没有清单」与「有清单但空」画成同一个样子。这些都不会报错：单测全绿、typecheck 全绿，
 * 界面上一段计划都不出现（或出现了但计数是假的）。所以判据全部落在**产品自己那条路**上：
 *
 * - 驱动写入用 `hostBridge.handle({capability:"todo"})` —— 这正是 worker 发来 `toolRpc`
 *   时主进程调用的那个函数（不是另写一条旁路）；
 * - 读结果分三层看：**库**（`listSessionTodos`）、**主进程那份视图**（`sessionManager.getView`）、
 *   **渲染层真的收到的那份**（DOM）。只读主进程那份会得出「数据明明是好的」这种必然误导的
 *   结论（`AGENTS.md` 记过这个坑）；
 * - 界面断言只认 `data-todo-*` 与可见文本，不认 class。
 *
 * ⚠️ **明确不覆盖**（写明，免得被当成验过了）：
 * 1. **镜像 → `transform_context` 的注入**：那要模型真的发起一次请求才走得到（注入只作用于
 *    该次请求的提示词），本模式不调模型 ⇒ 只有 `COLT_SMOKE_MODE=todo-e2e` 能覆盖。
 *    纯函数那半（截断 / 空清单不产出 / 已完成折一行）由 `tests/todo-store.test.ts` 逐条钉住。
 * 2. **worker 意外崩溃那一支的收尾**：与 `ask-user` 同款缺口，只有恢复循环覆盖。
 * 3. **并发调用**：靠「同步函数、不 await」在结构上排除（见 `main/todo-store.ts`），
 *    没有用例去制造并发。
 */
import { BrowserWindow } from "electron";
import { createSession, listSessionTodos } from "../../../main/db/repo";
import { sessionManager } from "../../../main/session-manager";
import { hostBridge } from "../../../main/host";
import { DEFAULT_THINKING_LEVEL } from "@shared/thinking-level";
import type { ConversationView } from "@shared/worker-protocol";
import { sleep, uncaughtErrors } from "../context";

export async function runTodo(
  window: BrowserWindow,
  projectId: string,
  sessionsDir: string,
  log: (message: string) => void,
  run: <T>(expression: string) => Promise<T>,
): Promise<void> {
  const session = createSession(projectId, sessionsDir);
  log(`会话：${session.id}`);
  const checks: [string, boolean][] = [];

  /**
   * 与 worker 的 `todo` 工具**同一条路**：这就是 worker 发来 toolRpc 时主进程调用的那个函数。
   * 校验失败时它**抛错**（内核据此把工具结果标成 isError），故另给一个读回报错的糖。
   */
  const call = (action: string, params: Record<string, unknown> = {}): Promise<{ text: string }> =>
    hostBridge.handle({ sessionId: session.id, capability: "todo", action, params });

  const callError = (action: string, params: Record<string, unknown>): Promise<string> =>
    call(action, params).then(
      () => "",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

  /** 计划段与工作区页签的状态（只用 data 钩子与可见文本，不认 class） */
  interface PlanProbe {
    section: boolean;
    progress: string;
    rows: { id: string; status: string; text: string; waiting: boolean }[];
    doneToggle: string | null;
    doneShown: number;
    hasLiveSection: boolean;
    activeLabel: string;
  }
  const planProbe = (): Promise<PlanProbe> =>
    run<PlanProbe>(`(() => {
      const aside = [...document.querySelectorAll("aside")].find((a) =>
        a.querySelector('button[aria-label="折叠工作区"], button[aria-label="展开工作区"]'));
      const rows = [...document.querySelectorAll("[data-todo-id]")].map((el) => ({
        id: el.getAttribute("data-todo-id") ?? "",
        status: el.getAttribute("data-todo-status") ?? "",
        text: (el.querySelector("[data-todo-subject]")?.textContent ?? "").trim(),
        waiting: (el.textContent ?? "").includes("等待："),
      }));
      const toggle = document.querySelector("[data-todo-done-toggle]");
      return {
        section: document.querySelector("[data-todo-section]") !== null,
        progress: (document.querySelector("[data-todo-progress]")?.textContent ?? "").trim(),
        rows,
        doneToggle: toggle ? (toggle.textContent ?? "").trim() : null,
        doneShown: rows.filter((r) => r.status === "completed").length,
        hasLiveSection: (aside?.innerText ?? "").includes("进行中的动作"),
        activeLabel: (
          aside?.querySelector('[data-dock-tab][aria-pressed="true"]')?.textContent ?? ""
        ).trim(),
      };
    })()`);

  /** 读下钻状态：层、面包屑文本、底部「返回」文本（⑦-G 的层用 data-drill 认） */
  const drillProbe = (): Promise<{ layer: string; crumbText: string; backText: string }> =>
    run<{ layer: string; crumbText: string; backText: string }>(`(() => {
      const root = document.querySelector("[data-drill]");
      return {
        layer: root ? (root.getAttribute("data-drill") ?? "") : "",
        crumbText: (document.querySelector('[data-drill-crumb="follow"]')?.textContent ?? "").trim(),
        // 只取那个**标签 span**：整枚按钮的 textContent 还含右侧的「ESC」提示，
        // 直接读按钮会把提示也读进来（这是「探针量错了地方」，不是文案不对）
        backText: (document.querySelector("[data-drill-back] span")?.textContent ?? "").trim(),
      };
    })()`);

  const clickLedger = (): Promise<boolean> =>
    run<boolean>(`(() => {
      const el = document.querySelector("[data-follow-ledger]");
      if (!el) return false;
      el.click();
      return true;
    })()`);

  /** 命中测试：小目标按钮「在 DOM 里」不等于「用户点得到」（`AGENTS.md` §五⑥） */
  const hitDoneToggle = (): Promise<boolean> =>
    run<boolean>(`(() => {
      const el = document.querySelector("[data-todo-done-toggle]");
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit !== null && (hit === el || el.contains(hit));
    })()`);

  const clickDoneToggle = (): Promise<boolean> =>
    run<boolean>(`(() => {
      const el = document.querySelector("[data-todo-done-toggle]");
      if (!el) return false;
      el.click();
      return true;
    })()`);

  /** 等界面上的计划段达到某个条件（视图推送 → 渲染是异步的） */
  const waitPlan = async (
    predicate: (probe: PlanProbe) => boolean,
    timeoutMs = 8000,
  ): Promise<PlanProbe> => {
    const deadline = Date.now() + timeoutMs;
    let probe = await planProbe();
    while (!predicate(probe) && Date.now() < deadline) {
      await sleep(300);
      probe = await planProbe();
    }
    return probe;
  };

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

    // 等 worker 就绪：视图推送（`changed` → `#emitView`）与镜像推送（`push`）都要求
    // 「entry 存在且已有第一份视图」，否则界面不会更新。判据取主进程读到的视图。
    let ready = false;
    const readyDeadline = Date.now() + 60_000;
    while (Date.now() < readyDeadline) {
      if (sessionManager.getView(session.id)) {
        ready = true;
        break;
      }
      await sleep(500);
    }
    checks.push(["渲染层自动打开本会话且 worker 就绪", ready]);
    if (!ready) return;

    // ---- 1. 真实往返：工具调用 → 库 → 主进程视图 → 渲染层 ----
    const created = await call("create", {
      subject: "给 FollowPanel 加计划段",
      activeForm: "正在加计划段",
    });
    log(`create 返回首行：${created.text.split("\n")[0]}`);
    const inDb = listSessionTodos(session.id);
    checks.push(["写入后库里有（真源落库）", inDb.length === 1 && inDb[0]!.subject.includes("计划段")]);
    const inMainView = sessionManager.getView(session.id)?.todos ?? [];
    checks.push(["主进程那份视图里也有（#withDbChanges 回填）", inMainView.length === 1]);
    const firstPlan = await waitPlan((probe) => probe.section);
    checks.push(["渲染层真的收到了：计划段出现（跨进程走到底）", firstPlan.section]);
    checks.push(["计数是 0/1（已完成 0 项 · 共 1 项）", firstPlan.progress === "0/1"]);
    checks.push([
      "待办那条显示的是 subject（还没开工，不该显示 activeForm）",
      firstPlan.rows.some((row) => row.status === "pending" && row.text.includes("加计划段")),
    ]);

    // ---- 2. 进行中：显示 activeForm；同一时刻只允许一条 ----
    const id = inDb[0]!.id;
    await call("create", { subject: "更新文档", activeForm: "正在更新文档" });
    await call("update", { id, status: "in_progress" });
    const running = await waitPlan((probe) => probe.rows.some((row) => row.status === "in_progress"));
    checks.push([
      "进行中那条显示 activeForm（这是它存在的唯一理由）",
      running.rows.some((row) => row.status === "in_progress" && row.text.includes("正在加计划段")),
    ]);
    const second = listSessionTodos(session.id).find((item) => item.id !== id)!;
    await call("update", { id: second.id, status: "in_progress" });
    const switched = listSessionTodos(session.id);
    checks.push([
      "同一时刻只允许一条 in_progress：新开工的把上一条退回待办",
      switched.find((item) => item.id === id)!.status === "pending" &&
        switched.find((item) => item.id === second.id)!.status === "in_progress",
    ]);

    // ---- 3. 已完成折成一行，点开才铺开（⑦-H：给结论不给流水）----
    await call("update", { id: second.id, status: "completed" });
    const folded = await waitPlan((probe) => probe.doneToggle !== null);
    checks.push([
      `已完成折成一行「已完成 N 项」（实为「${folded.doneToggle}」）`,
      folded.doneToggle === "已完成 1 项" && folded.doneShown === 0,
    ]);
    checks.push(["那条已完成的不逐条铺开（当前渲染的条目里没有它）", folded.rows.length === 1]);
    checks.push(["折叠按钮真的点得到（命中测试）", await hitDoneToggle()]);
    await clickDoneToggle();
    const expanded = await waitPlan((probe) => probe.doneShown === 1);
    checks.push([
      "点开后才铺开，且能看到它本身（已完成那条不消失）",
      expanded.doneShown === 1 && expanded.rows.some((row) => row.text.includes("更新文档")),
    ]);

    // ---- 4. 依赖：被挡住的条目要看得出来它在等 ----
    const waiting = await call("create", {
      subject: "写 todo 冒烟",
      blockedBy: [id],
    });
    log(`依赖条目的返回：${waiting.text.split("\n")[1] ?? ""}`);
    const blockedProbe = await waitPlan((probe) => probe.rows.some((row) => row.waiting));
    checks.push(["依赖未满足的条目在界面上标出「等待：」", blockedProbe.rows.some((row) => row.waiting)]);
    const refused = await callError("update", { id: lastTodoId(session.id), status: "in_progress" });
    checks.push([
      "被挡住的条目不许开工，且报错说清在等谁（可见失败，不是静默）",
      refused.includes("还在等"),
    ]);

    // ---- 5. 空态两层：没有清单 → 整段不渲染；有清单但此刻空闲 → 计划段在 ----
    // （v1.53 起右栏不再有「进行中的动作」段：此刻动作只在 ④，空闲判据在 ⑥）
    const idleWithPlan = await planProbe();
    checks.push(["有清单但此刻空闲：计划段照常显示", idleWithPlan.section]);
    checks.push([
      "右栏不再重复列此刻动作（「进行中的动作」段已移除，v1.53）",
      !idleWithPlan.hasLiveSection,
    ]);
    await call("clear");
    const cleared = await waitPlan((probe) => !probe.section);
    checks.push(["清空后「没有清单」→ 计划段整段不渲染（不占位）", !cleared.section]);
    checks.push(["清空后库里也是空的（不是幽灵清单）", listSessionTodos(session.id).length === 0]);

    // ---- 6. 页签更名（v1.48）：默认视图叫「任务摘要」 ----
    checks.push([
      `默认页签标签是「任务摘要」（实为「${cleared.activeLabel}」）`,
      cleared.activeLabel === "任务摘要",
    ]);

    // ---- 7. worker 被回收 / 重启后清单仍在（真源在库的唯一保证）----
    await call("create", { subject: "重启后仍应看得见", activeForm: "正在重启" });
    sessionManager.close(session.id);
    // worker 没了：这一笔**只**落库，界面那份不会更新（`changed` 找不到 entry）
    const beforeReopen = await call("create", { subject: "离线时写的" });
    log(`离线写入：${beforeReopen.text.split("\n")[0]}`);
    checks.push(["worker 不在时写入仍落库（真源不是 worker 内存）", listSessionTodos(session.id).length === 2]);
    await sleep(500);
    await run(
      `window.colt.invoke("session.open", ${JSON.stringify({
        sessionId: session.id,
        cwd: process.env.COLT_SMOKE_CWD ?? process.cwd(),
      })})`,
    );
    let restored = false;
    const restoreDeadline = Date.now() + 60_000;
    while (Date.now() < restoreDeadline) {
      const view = sessionManager.getView(session.id);
      if (view && view.todos.length === 2) {
        restored = true;
        break;
      }
      await sleep(500);
    }
    checks.push(["worker 重启后清单完整重建（真源在库，不在进程内存）", restored]);
    const afterRestart = await waitPlan((probe) => probe.rows.length === 2);
    checks.push(["重启后界面也重新画出这两条", afterRestart.rows.length === 2]);

    // ---- 8. 下钻的面包屑与「返回」文案同名（改名不能只改页签）----
    // 用受控视图驱动：需要「有改动」才能点总账进清单层（这一段与真实 worker 无关，
    // 放在最后——它会整份替换渲染层手里那份视图，之后不再依赖真实视图）。
    const controlled: ConversationView = {
      sessionId: session.id,
      model: "smoke/model",
      imageInput: false,
      thinkingLevel: DEFAULT_THINKING_LEVEL,
      skills: [],
      messages: [],
      toolResults: [],
      subagents: [],
      fileChanges: [
        {
          id: "smoke-todo-change",
          path: "todo-smoke.txt",
          kind: "write",
          patch: null,
          addedLines: 2,
          removedLines: 0,
          timestamp: Date.now(),
          netAddedLines: 2,
          netRemovedLines: 0,
        },
      ],
      todos: listSessionTodos(session.id),
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
    window.webContents.send("session.view", controlled);
    await sleep(400);
    const opened = await clickLedger();
    await sleep(400);
    const drill = await drillProbe();
    checks.push(["点总账进得去清单层（下钻的入口还在）", opened && drill.layer === "list"]);
    checks.push([
      `面包屑第一段写「任务摘要」（实为「${drill.crumbText}」）`,
      drill.crumbText === "任务摘要",
    ]);
    checks.push([
      `清单层底部的返回文案同名（实为「${drill.backText}」）`,
      drill.backText === "返回「任务摘要」",
    ]);

    checks.push(["全程未抛未捕获异常", uncaughtErrors.length === 0]);
  } catch (error) {
    log(`用例异常：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    checks.push(["用例未抛异常", false]);
  } finally {
    log("[todo] 端到端断言");
    for (const [name, ok] of checks) log(`  ${ok ? "✓" : "✗"} ${name}`);
    log(`通过 ${checks.filter(([, ok]) => ok).length}/${checks.length}`);
  }
}

/** 取清单里最后一条的 id（依赖用例要在创建后拿到它的 id） */
function lastTodoId(sessionId: string): string {
  const todos = listSessionTodos(sessionId);
  return todos[todos.length - 1]!.id;
}
