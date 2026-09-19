// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 冒烟模式：subagent-e2e
 *
 * 子代理链路的**真实模型**端到端（打模型；云端服务时计费，本地 Ollama 不计费）。
 *
 * 免费的 `subagent` 模式（22 条）推受控视图，验的是**呈现**；这里验的是 NEXT-PHASE
 * §3.2 ⑤ 里三个「只有模型真的调用工具才走得到」的执行侧事实：
 * ① **清单可见**：模型在系统提示词里真的看得见 `<available_subagents>`——看得见才会
 *    按名调用 `subagent(agent: "demo")`；
 * ② **免闸门 / 内部写弹卡**：`subagent` 工具调用本身不进审批队列（免闸），而它派生
 *    的子 lane 里那次 `write` **照常进闸门**——且审批请求带「来自 demo」的归属
 *    （`request.subagent`）；
 * ③ **fresh 隔离**：子代理开局只有 task 那一段——主对话里的密语绝不出现在子代理
 *    transcript 里（判据是「缺席」，确定性：隔离 ⟹ 看不见 ⟹ 说不出来）。
 *
 * 流程：prompt A 让主对话记住一个随机密语（把 nonce 钉进主 transcript，防「缺席」
 * 断言变空洞）；prompt B 点名调用 demo 子代理、task 里让它 write 一个文件。
 * 批准确走真实 UI（「允许一次」+ 命中测试）；write 的真实产物（文件落盘 + 内容）
 * 也从审批请求的实际入参里验，不猜模型选了什么文件名。
 *
 * 小模型的服从是概率事件（0.6b 实测过三种失败形态：不调工具、子代理假装写了、
 * 绕过委派自己直接 write），所以「发 prompt B → 等内部 write」整条可重试至多 3 次：
 * 主 lane 绕过委派的直接 write 会被**拒掉并在理由里指路**，断言一条不放水。
 *
 * 夹具：`<fixture>/.agents/agents/demo.md`（frontmatter 白名单 `write, read`），
 * 与生产发现路径同构（`agent-defs.ts` 的 `<cwd>/.agents/agents/`）。
 */
import { app, BrowserWindow } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSession, upsertProject } from "../../../main/db/repo";
import { sessionManager } from "../../../main/session-manager";
import { listProviders } from "../../../main/providers";
import { hasUsableProvider } from "@shared/model-ref";
import type { ConversationView } from "@shared/worker-protocol";
import { sleep, uncaughtErrors } from "../context";

/** 子代理定义名：夹具文件名（去 .md），也是 prompt 点名的 agent 入参 */
const AGENT_NAME = "demo";

export async function runSubagentE2e(
  window: BrowserWindow,
  log: (message: string) => void,
  run: <T>(expression: string) => Promise<T>,
): Promise<void> {
  const fixtureDir = join(process.cwd(), "out", "smoke-subagent-e2e-fixture");
  mkdirSync(join(fixtureDir, ".agents", "agents"), { recursive: true });
  writeFileSync(
    join(fixtureDir, ".agents", "agents", `${AGENT_NAME}.md`),
    [
      "---",
      "description: 冒烟夹具子代理：按 task 写文件并回报结论",
      "tools: write, read",
      "---",
      "",
      "你是冒烟夹具子代理。严格按 task 要求行事，做完后用一两句话回报做了什么。",
      "",
    ].join("\n"),
    "utf8",
  );
  // 与 ask-user-e2e / mcp-e2e 同一条路：worker 的生死交给渲染层（挂载自动打开「当前项目」
  // 最新会话），不抢 session.open；刻意不把仓库项目顶回 list[0]。
  const project = upsertProject(fixtureDir);
  const session = createSession(project.id, join(app.getPath("userData"), "sessions", project.id));
  log(`夹具项目：${fixtureDir}（已写 .agents/agents/${AGENT_NAME}.md）`);
  log(`会话：${session.id}（项目：${project.name}）`);

  const checks: [string, boolean][] = [];
  const getView = (): ConversationView | undefined => sessionManager.getView(session.id);

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

  const lastAnswer = (view: ConversationView): string => {
    for (let i = view.messages.length - 1; i >= 0; i -= 1) {
      const m = view.messages[i]!;
      if (m.role === "assistant" && m.text.trim() !== "") return m.text;
    }
    return "";
  };

  /**
   * 等子 lane 的 write 调用进审批队列（内部写弹卡的信号）。
   * 只认**带 subagent 归属**的 write——小模型（0.6b）常绕过委派、自己在主 lane 直接
   * write；那是「没调 subagent」的失败形态，不是内部写弹卡。见到就**拒掉**（理由里
   * 指路），让模型在同一会话里有机会纠正，别把测试钉死在错路上。
   * 主 lane 正阻塞在 subagent 工具里（running 恒 true）是正常态；快速失败同 mcp-e2e。
   */
  const waitInnerWrite = async (timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    let sawRunning = false;
    const rejectedBypass = new Set<string>();
    for (;;) {
      const pending = sessionManager.approvals.listPending(session.id);
      const hit = pending.find(
        (item) => item.toolName === "write" && item.subagent !== undefined,
      );
      if (hit !== undefined) return hit;
      // 主 lane 绕过委派的直接 write：拒掉并指路（同 resolve 就是界面上点「拒绝」）
      for (const item of pending) {
        if (item.toolName !== "write" || item.subagent !== undefined) continue;
        if (rejectedBypass.has(item.toolCallId)) continue;
        rejectedBypass.add(item.toolCallId);
        log(`  主 lane 绕过委派直接 write，已拒绝并指路：${item.toolCallId}`);
        sessionManager.approvals.resolve({
          sessionId: session.id,
          toolCallId: item.toolCallId,
          approved: false,
          reason:
            `不要自己直接写文件。请用 subagent 工具委派 ${AGENT_NAME} 子代理去做这件事，` +
            "task 里写清要它创建什么文件。",
        });
      }
      const view = getView();
      if (view?.running === true) sawRunning = true;
      if (sawRunning && view !== undefined && !view.running) {
        const errored = view.toolResults.filter((item) => item.isError);
        log(`本轮终态：${JSON.stringify(view.lastRun)}`);
        for (const item of errored) log(`  工具报错：${item.output.slice(0, 400)}`);
        throw new Error("主 lane 结束了却没等到子代理的 write 审批（多半是 subagent 没被调用）");
      }
      if (Date.now() > deadline) throw new Error(`等待内部 write 审批超时（${timeoutMs}ms）`);
      await sleep(1000);
    }
  };

  try {
    if (!hasUsableProvider(listProviders())) {
      checks.push(["前置：存在可用的模型服务（没有就无法真实调用）", false]);
      log("没有可用的模型服务。请先配好一个服务（本地 Ollama 也行）再跑本模式。");
      return;
    }
    checks.push(["前置：存在可用的模型服务", true]);

    window.reload();
    await sleep(4000);
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

    // 0.6b 这类小模型的 thinking 会把它锚回上一条指令；切到 low 让它直接服从当前指令。
    await run(
      `window.colt.invoke("session.setThinkingLevel", ${JSON.stringify({ sessionId: session.id, level: "low" })})`,
    );

    // ── prompt A：把密语钉进主 transcript（让下面的「缺席」断言不空洞）──
    const nonce = `colt-sub-${Math.random().toString(16).slice(2, 10)}`;
    const beforeA = getView()?.messages.length ?? 0;
    await run(
      `window.colt.invoke("session.prompt", ${JSON.stringify({
        sessionId: session.id,
        text: `记住这个密语：${nonce}。只回复「记住了」两个字，不要做别的。`,
      })})`,
    );
    const viewA = await waitSettled(beforeA, 120_000);
    checks.push(["prompt A 落定（主对话基线正常）", viewA.lastRun?.status === "completed"]);
    checks.push(["密语已进主对话（下面的「缺席」断言才有比对物）", JSON.stringify(viewA.messages).includes(nonce)]);

    // ── prompt B：点名调用 demo 子代理，task 里让它 write 一个文件 ──
    // 小模型（0.6b）服从是概率事件：整条「发 prompt B → 等内部 write」可重试，
    // 断言一条不放水。attempt 之间主 lane 必须已落定。
    const beforeB = getView()?.messages.length ?? 0;
    const entriesBeforeB = getView()?.subagents.length ?? 0;
    let inner: Awaited<ReturnType<typeof waitInnerWrite>> | undefined;
    for (let attempt = 1; attempt <= 3 && inner === undefined; attempt += 1) {
      if (attempt > 1) log(`第 ${attempt} 次尝试 prompt B（上次子代理没真的调 write）…`);
      await run(
        `window.colt.invoke("session.prompt", ${JSON.stringify({
          sessionId: session.id,
          text:
            `现在做一件新的事情，与上一条无关。不要直接回答我，必须调用工具：` +
            `用 subagent 工具：agent 填 ${AGENT_NAME}，task 填「不要只描述，必须调用 write 工具` +
            `真实创建文件 hello.txt，内容就一行：from-subagent。调用完 write 后回复 done」。` +
            "拿到子代理的结果后，原样复述它的话，然后停下来。",
        })})`,
      );
      log("已发出 prompt B，等子代理发起内部 write…");
      try {
        inner = await waitInnerWrite(180_000);
      } catch (error) {
        const endedWithoutWrite =
          error instanceof Error && error.message.includes("主 lane 结束了却没等到");
        if (!endedWithoutWrite || attempt === 3) throw error;
      }
    }
    if (inner === undefined) throw new Error("prompt B 三次尝试都没等到子代理的内部 write");
    log(`  内部 write 审批：${inner.toolCallId}，入参 ${inner.argsJson.slice(0, 200)}`);
    // ② 的两半：subagent 免闸（pending 里没有它），内部 write 照常进闸
    checks.push([
      "subagent 调用免闸门（此刻 pending 里没有 subagent，它已被调用）",
      sessionManager.approvals.listPending(session.id).every((item) => item.toolName !== "subagent"),
    ]);
    checks.push([
      "子 lane 的内部 write 照常进审批闸门（内部写弹卡）",
      inner.toolName === "write" && inner.reason.trim() !== "",
    ]);
    checks.push([
      "内部调用带「来自 demo」归属（request.subagent，④ 卡 chip 的数据源）",
      inner.subagent !== undefined && inner.subagent.name === AGENT_NAME,
    ]);
    // ① 清单可见的物证：模型按名调用了 demo——此刻视图里应已有这个子代理的活条目
    // （重试会留下旧条目，只认本次 prompt B 之后新出现的、且正在跑的那个）
    const runningEntry = getView()
      ?.subagents.slice(entriesBeforeB)
      .filter((item) => item.name === AGENT_NAME)
      .at(-1);
    checks.push([
      "视图出现 demo 子代理活条目（模型按名调用了它＝清单真的被看见了）",
      runningEntry !== undefined && runningEntry.status === "running",
    ]);

    // 批准确走真实 UI（同 mcp-e2e：命中测试 + 真点击）
    const card = await run<string>(`(() => {
      const btns = [...document.querySelectorAll("button")].filter(
        (b) => b.textContent !== null && b.textContent.includes("允许一次"),
      );
      if (btns.length !== 1) return "buttons:" + btns.length;
      const btn = btns[0];
      const rect = btn.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (hit === null || !btn.contains(hit)) return "not-hittable";
      btn.click();
      return "clicked";
    })()`);
    await sleep(500);
    checks.push([
      "点「允许一次」后待审清空（批准确到了子 lane 的闸门）",
      card === "clicked" && sessionManager.approvals.listPending(session.id).length === 0,
    ]);

    const viewB = await waitSettled(beforeB, 240_000);
    // 只认本次 prompt B 之后新出现的 demo 条目（重试会留下更早的旧条目）
    const entry = viewB.subagents
      .slice(entriesBeforeB)
      .filter((item) => item.name === AGENT_NAME)
      .at(-1);
    checks.push([
      "子代理跑完（视图条目 completed 且有时间戳）",
      entry !== undefined && entry.status === "completed" && entry.endedAt !== undefined,
    ]);
    if (entry !== undefined) log(`  子代理条目：${entry.status}，标题「${entry.title}」`);
    // 结果回主对话：subagent 工具结果非空非错（回传口径是子代理结论文本）
    const subResult = viewB.toolResults.find((item) => item.id === entry?.toolCallId);
    checks.push([
      "子代理结论作为工具结果回到主模型（非空、非错）",
      subResult !== undefined && subResult.isError === false && subResult.output.trim() !== "",
    ]);
    if (subResult !== undefined) log(`  回传结论：${subResult.output.slice(0, 200)}`);

    // ③ fresh 隔离：密语绝不出现在子代理 transcript（判据是「缺席」，确定性）
    if (entry !== undefined) {
      const transcript = await sessionManager.subagentTranscript(session.id, entry.id);
      const haystack = JSON.stringify(transcript);
      checks.push(["fresh 隔离：主对话密语不出现在子代理 transcript", !haystack.includes(nonce)]);
      log(`  子代理 transcript：${transcript.messages.length} 条消息`);
    } else {
      checks.push(["fresh 隔离：主对话密语不出现在子代理 transcript", false]);
    }

    // write 的真实产物：从审批请求的实际入参验（不猜模型选了什么文件名）
    try {
      const args = JSON.parse(inner.argsJson) as { path?: string; content?: string };
      const written = args.path !== undefined ? join(fixtureDir, args.path) : null;
      checks.push([
        "内部 write 真的落了盘（文件存在，内容 from-subagent）",
        written !== null &&
          existsSync(written) &&
          readFileSync(written, "utf8").includes("from-subagent"),
      ]);
      if (written !== null) log(`  落盘文件：${written}`);
    } catch {
      checks.push(["内部 write 真的落了盘（文件存在，内容 from-subagent）", false]);
    }

    checks.push(["模型接着往下做了（本轮 completed 且有新助手消息）", viewB.lastRun?.status === "completed" && lastAnswer(viewB) !== ""]);
    checks.push(["全程未抛未捕获异常", uncaughtErrors.length === 0]);
  } finally {
    try {
      await run(
        `window.colt.invoke("session.close", ${JSON.stringify({ sessionId: session.id })})`,
      );
    } catch (error) {
      log(`关闭会话失败（无害）：${error instanceof Error ? error.message : String(error)}`);
    }
    log("[subagent-e2e] 端到端断言");
    for (const [name, ok] of checks) log(`  ${ok ? "✓" : "✗"} ${name}`);
    log(`通过 ${checks.filter(([, ok]) => ok).length}/${checks.length}`);
  }
}
