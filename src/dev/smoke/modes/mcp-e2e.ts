// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 冒烟模式：mcp-e2e
 *
 * MCP 工具链路的**真实模型**端到端（打模型、计费，2 次调用左右）。
 *
 * 为什么必须有一条打模型的：免费路径（单测 + 将来的免模型冒烟）能验「工具包得出来、
 * 配置解析得对」，但有三段**只有模型真的调用工具才走得到**——
 * ① 模型在系统提示词里**真的看得见** MCP 工具清单（`AgentHarness.create` 那步接线）；
 * ② `before_tool` 闸门对 `mcp__` 工具的裁决（未知工具 → 弹卡，不静默放行）；
 * ③ 批准 → stdio 往返 → 结果作为工具结果回到模型、模型接着往下做。
 * 判据与 ask-user-e2e 同原则：一律取自**主进程**（待审队列 / 视图 / 事件库），
 * 渲染层是并发参与者，不把断言挂在它身上。
 *
 * 夹具：往 `out/smoke-mcp-e2e-fixture/.colt/mcp.json` 写一份声明（server 名 `fixture`），
 * 指向 `tests/helpers/mcp-fixture-server.mjs`——与单测同一个 stdio 夹具（echo/add/fail）。
 * server 进程用 **`ELECTRON_RUN_AS_NODE` 让 electron 按 Node 跑**（AGENTS.md 那个环境变量
 * 坑的正面用法）：冒烟环境的 PATH 未必有 node，而 electron 二进制一定存在；
 * 这正是「进程启动方式依赖环境」该显式化的那一类前提（AGENTS.md §五⑬）。
 *
 * 对抗条件刻意选**审批档（approval）而不是全权**：MCP 的全部安全语义就是
 * 「天然过 before_tool、弹卡等人批」，在全权模式下验等于把闸门卸了再验桥。
 */
import { app, BrowserWindow } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSession, listSessionEvents, upsertProject } from "../../../main/db/repo";
import { sessionManager } from "../../../main/session-manager";
import { listProviders } from "../../../main/providers";
import { hasUsableProvider } from "@shared/model-ref";
import type { ConversationView } from "@shared/worker-protocol";
import { sleep, uncaughtErrors } from "../context";

/** MCP 工具名：server 名（mcp.json 里声明的键）+ 夹具工具名，与 mcpToolName 同源 */
const MCP_TOOL = "mcp__fixture__echo";

export async function runMcpE2e(
  window: BrowserWindow,
  log: (message: string) => void,
  run: <T>(expression: string) => Promise<T>,
): Promise<void> {
  const fixtureDir = join(process.cwd(), "out", "smoke-mcp-e2e-fixture");
  mkdirSync(join(fixtureDir, ".colt"), { recursive: true });
  // ELECTRON_RUN_AS_NODE：electron 按 Node 解释器跑夹具 server——不依赖 PATH 里有 node。
  writeFileSync(
    join(fixtureDir, ".colt", "mcp.json"),
    JSON.stringify(
      {
        mcpServers: {
          fixture: {
            command: process.execPath,
            args: [join(process.cwd(), "tests", "helpers", "mcp-fixture-server.mjs")],
            env: { ELECTRON_RUN_AS_NODE: "1" },
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  // 与 ask-user-e2e 同一条路：worker 的生死交给渲染层（挂载时自动打开「当前项目」
  // 的最新会话），不抢 session.open；也刻意不把仓库项目顶回 list[0]。
  const project = upsertProject(fixtureDir);
  const session = createSession(project.id, join(app.getPath("userData"), "sessions", project.id));
  log(`夹具项目：${fixtureDir}（已写 .colt/mcp.json）`);
  log(`会话：${session.id}（项目：${project.name}）`);

  const checks: [string, boolean][] = [];

  /** 主进程直读视图：不绕渲染层（那条路受界面状态影响） */
  const getView = (): ConversationView | undefined => sessionManager.getView(session.id);

  /** 等一轮运行落定；判据同 ask-user-e2e */
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

  /**
   * 等模型发起 MCP 工具调用（以「待审队列出现该工具」为信号）。
   * 提问/审批期间 lane 阻塞在工具里（running 恒 true）是正常态，不能拿它当终态。
   * 快速失败：先见过 running=true、随后又 false，说明本轮结束了却没调用。
   */
  const waitApproval = async (timeoutMs: number): Promise<string> => {
    const deadline = Date.now() + timeoutMs;
    let sawRunning = false;
    for (;;) {
      const pending = sessionManager.approvals.listPending(session.id);
      const hit = pending.find((item) => item.toolName === MCP_TOOL);
      if (hit !== undefined) return hit.toolCallId;
      const view = getView();
      if (view?.running === true) sawRunning = true;
      if (sawRunning && view !== undefined && !view.running) {
        const errored = view.toolResults.filter((item) => item.isError);
        log(`本轮终态：${JSON.stringify(view.lastRun)}`);
        for (const item of errored) log(`  工具报错：${item.output.slice(0, 400)}`);
        throw new Error("模型没有调用 MCP 工具就结束了本轮（多半是工具清单没进提示词）");
      }
      if (Date.now() > deadline) throw new Error(`等待 MCP 工具调用超时（${timeoutMs}ms）`);
      await sleep(1000);
    }
  };

  try {
    // 前置检查：没有可用模型时显式失败（同 memory-e2e / ask-user-e2e）
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

    // 装载结果如实告知：worker init 时连接 fixture server，security 类 notice 落 session_events。
    // 这条同时是「loadMcpTools 在真 worker 里真连上了」的物证（单测只验装载函数本身）。
    const eventsDeadline = Date.now() + 30_000;
    let mcpEvent: string | null = null;
    while (Date.now() < eventsDeadline) {
      const hit = listSessionEvents(session.id).find(
        (item) => item.message.includes("MCP") && item.message.includes("fixture"),
      );
      if (hit) {
        mcpEvent = hit.message;
        break;
      }
      await sleep(500);
    }
    checks.push(["装载如实告知：事件流里有 MCP 连接记录（真 worker 连上了 fixture server）", mcpEvent !== null]);
    if (mcpEvent !== null) log(`  事件：${mcpEvent}`);

    // 对抗条件：审批档。MCP 的安全语义就是「未知工具弹卡等人批」，在全权档验等于卸了闸门验桥。
    await run(
      `window.colt.invoke("approval.mode.set", ${JSON.stringify({
        sessionId: session.id,
        mode: "approval",
      })})`,
    );
    log("审批模式已设为 approval（弹卡等人批，正是要验的那条闸门）");

    // 训练一个稳定触发的 prompt：点名工具与参数， nonce 作为「真往返过」的确定性比对物——
    // 模型必须真的调用工具才看得到 echo:<nonce> 这个结果（toolResults 来自内核的真实执行）。
    const nonce = `colt-mcp-${Math.random().toString(16).slice(2, 10)}`;
    const prompt =
      `先不要改任何文件。请**使用工具 ${MCP_TOOL}**，参数 text 填「${nonce}」。` +
      "拿到工具返回后，把返回内容原样复述给我，然后停下来。";
    const before = getView()?.messages.length ?? 0;
    await run(
      `window.colt.invoke("session.prompt", ${JSON.stringify({ sessionId: session.id, text: prompt })})`,
    );
    log("已发出 prompt，等模型调用 MCP 工具…");

    const toolCallId = await waitApproval(150_000);
    const request = sessionManager.approvals
      .listPending(session.id)
      .find((item) => item.toolCallId === toolCallId);
    checks.push(["模型真的调用了 MCP 工具（待审队列出现 mcp__fixture__echo）", request !== undefined]);
    checks.push([
      "调用进了审批闸门：未知 MCP 工具是「弹卡等人批」，不是静默放行/直接拒绝",
      request !== undefined && request.risk === "moderate" && request.reason.trim() !== "",
    ]);
    if (request !== undefined) log(`  审批请求：risk=${request.risk}，依据=${request.reason}`);

    // 渲染侧：卡真的画出来了，且点得到「允许一次」——批准走真实 UI 路径，而非替 IPC 作答。
    // 工具身份已由主进程断言（request.toolName）钉死，DOM 这半只验「卡可见、按钮可点」，
    // 不靠摘要文案猜（摘要是审批分析模型写的，内容不固定）。
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
    log(`  审批卡：${card}`);
    await sleep(500);
    checks.push([
      "点「允许一次」后待审清空（批准真的到了闸门）",
      card === "clicked" && sessionManager.approvals.listPending(session.id).length === 0,
    ]);

    const view = await waitSettled(before, 180_000);
    // 确定性判据落在工具结果上：echo:<nonce> 只可能来自夹具 server 的真实 stdio 往返
    const result = view.toolResults.find((item) => item.id === toolCallId);
    checks.push([
      "MCP 结果作为工具结果回到模型（echo:<nonce>，来自真实 stdio 往返）",
      result !== undefined && result.isError === false && result.output.includes(`echo:${nonce}`),
    ]);
    if (result !== undefined) log(`  工具结果：${result.output.slice(0, 200)}`);
    const lastText = ((): string => {
      for (let i = view.messages.length - 1; i >= 0; i -= 1) {
        const m = view.messages[i]!;
        if (m.role === "assistant" && m.text.trim() !== "") return m.text;
      }
      return "";
    })();
    log(`模型最终回复：${lastText.slice(0, 200)}`);
    checks.push(["模型接着往下做了（本轮 completed 且给出了新的助手消息）", view.lastRun?.status === "completed" && lastText !== ""]);
    checks.push(["全程未抛未捕获异常", uncaughtErrors.length === 0]);
  } finally {
    // 真模型调用别留给空闲回收；运行中会被主进程拒绝，那就交给回收
    try {
      await run(
        `window.colt.invoke("session.close", ${JSON.stringify({ sessionId: session.id })})`,
      );
    } catch (error) {
      log(`关闭会话失败（无害）：${error instanceof Error ? error.message : String(error)}`);
    }
    log("[mcp-e2e] 端到端断言");
    for (const [name, ok] of checks) log(`  ${ok ? "✓" : "✗"} ${name}`);
    log(`通过 ${checks.filter(([, ok]) => ok).length}/${checks.length}`);
  }
}
