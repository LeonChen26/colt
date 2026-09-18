/**
 * 冒烟模式：perf —— 长会话的**渲染**开销（不调模型、不计费）
 *
 * 量的是一件事：**消息很多时界面会不会卡**。做法是把同一份受控视图按不同条数
 * 推给真实渲染层，期间用 rAF 采样帧间隔，看**最长那一帧卡了多久**——
 * 用户能感知的就是这个数，而不是「挂了几个 DOM 节点」。
 *
 * 为什么必须真跑渲染层：这个开销全在 React 提交 + 浏览器排版/绘制里。
 * 纯逻辑单测碰不到；主进程侧读数（视图多大、多少条）也只是**输入**，
 * 换算不出「卡多久」——第 1 步已经把 payload 砍下来了，但没人量过渲染那一段。
 *
 * 顺便量第二件事：**同一份视图被反复重推**的代价（流式期间主进程每 50ms 推一次全量快照，
 * 见 `worker/entry.ts` 的 `scheduleFlush`）——这条是"运行中会不会卡"的直接来源。
 */
import { BrowserWindow } from "electron";
import { createSession } from "../../../main/db/repo";
import type { ConversationView, ViewMessage, ViewToolResult } from "@shared/worker-protocol";
import { DEFAULT_THINKING_LEVEL } from "@shared/thinking-level";
import { sleep } from "../context";

/** 造一份「看起来像真实长会话」的视图：有用户轮、有带工具调用的助手轮、有工具结果 */
function bigView(sessionId: string, count: number): ConversationView {
  const messages: ViewMessage[] = [];
  const toolResults: ViewToolResult[] = [];
  for (let i = 0; i < count; i++) {
    if (i % 14 === 0) {
      messages.push({
        id: `m${i}`,
        role: "user",
        text: `第 ${i} 条用户消息：请检查这一部分实现，注意边界条件与错误处理，并说明你的判断依据。`,
        toolCalls: [],
        timestamp: 1_700_000_000_000 + i * 1000,
      });
      continue;
    }
    const callId = `call_${i}`;
    messages.push({
      id: `m${i}`,
      role: "assistant",
      // 混入 Markdown 与代码，贴近真实回复的渲染成本
      text:
        i % 3 === 0
          ? `已完成第 ${i} 步。这里有一段**加粗**与 \`inline code\`：\n\n- 第一点\n- 第二点\n\n\`\`\`ts\nconst x = ${i};\n\`\`\`\n`
          : "",
      toolCalls: [
        {
          id: callId,
          name: "read",
          args: JSON.stringify({ path: `src/worker/lib/file-${i}.ts` }),
          durationMs: 5 + (i % 20),
        },
      ],
      thought: i % 5 === 0 ? "先看清结构再动手，避免改错层级……" : undefined,
      timestamp: 1_700_000_000_000 + i * 1000,
    });
    toolResults.push({
      id: callId,
      output: `文件 file-${i}.ts 的正文：\n${"x".repeat(300)}`,
      isError: false,
    });
  }
  return {
    sessionId,
    model: "perf/model",
    imageInput: false,
    thinkingLevel: DEFAULT_THINKING_LEVEL,
    skills: [],
    messages,
    toolResults,
    fileChanges: [],
    streamingText: null,
    thought: null,
    runningTools: [],
    running: false,
    lastRun: null,
    queuedCount: 0,
    stats: {
      messageCount: count,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      contextUsed: 0,
    },
  };
}

export async function runPerf(
  window: BrowserWindow,
  projectId: string,
  sessionsDir: string,
  log: (message: string) => void,
  run: <T>(expression: string) => Promise<T>,
): Promise<void> {
  createSession(projectId, sessionsDir);
  window.reload();
  await sleep(4000);

  const list = await run<{ id: string }[]>(
    `window.colt.invoke("session.list", ${JSON.stringify({ projectId })})`,
  );
  const sessionId = list[0]?.id;
  if (sessionId === undefined) {
    log("会话列表为空，无法测量");
    return;
  }
  log(`活动会话：${sessionId}`);

  // rAF 采样器：记录每两帧的间隔。主线程被渲染占满时，这个间隔会明显拉长。
  await run(`(() => {
    window.__perf = { gaps: [], last: 0, on: false };
    window.__perfStart = () => {
      window.__perf.gaps = [];
      window.__perf.last = performance.now();
      window.__perf.on = true;
      const tick = () => {
        if (!window.__perf.on) return;
        const now = performance.now();
        window.__perf.gaps.push(now - window.__perf.last);
        window.__perf.last = now;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };
    window.__perfStop = () => { window.__perf.on = false; return window.__perf.gaps; };
    return true;
  })()`);

  const domNodes = (): Promise<number> =>
    run<number>(`document.querySelector("[data-conv-scroll]")?.querySelectorAll("*").length ?? 0`);

  const report = async (label: string): Promise<void> => {
    const gaps = await run<number[]>(`window.__perfStop()`);
    if (gaps.length === 0) {
      log(`${label}：没采到帧（渲染层可能没在绘制）`);
      return;
    }
    const sorted = [...gaps].sort((a, b) => a - b);
    const max = sorted[sorted.length - 1] ?? 0;
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    const over32 = gaps.filter((gap) => gap > 32).length;
    log(
      `${label}：最长帧 ${max.toFixed(0)}ms / p95 ${p95.toFixed(0)}ms / >32ms 的帧 ${over32}/${gaps.length}`,
    );
  };

  // ---- 一、条数扫描：一次推一份全量视图，看渲染阻塞多久 ----
  log("[一] 单次全量推送（不同条数）");
  for (const count of [40, 200, 370, 800]) {
    const view = bigView(sessionId, count);
    const payloadKb = JSON.stringify(view).length / 1024;
    await run(`window.__perfStart()`);
    window.webContents.send("session.view", view);
    await sleep(2500);
    const dom = await domNodes();
    log(`  ${count} 条（payload ${payloadKb.toFixed(0)}KB，DOM 节点 ${dom} 个）`);
    await report(`    →`);
  }

  // ---- 二、流式期间的全量重推：每 50ms 推一次同一份视图 ----
  // 正是 worker 的 scheduleFlush 行为：视图是全量快照，历史越长每次搬得越多。
  //
  // 采样前先**空推一次并等它落定**：否则这一轮会连带量到「从上一组条数切到这一组的挂载」，
  // 那个开销只发生一次、与「重推贵不贵」无关，却总是全场最大的那一帧（实测 370 条时约 530ms），
  // 会把真正要看的数盖住。
  log("[二] 模拟流式重推（每 50ms 一次全量，共 40 次；先热身一次不计入）");
  for (const count of [40, 370]) {
    const base = bigView(sessionId, count);
    /** 真实流式的样子：历史不动，**正在写的那一条**在长 */
    const grow = (round: number): ConversationView => ({
      ...base,
      messages: base.messages.map((message, index) =>
        index === base.messages.length - 1
          ? { ...message, text: `${message.text}${"流".repeat(round)}` }
          : message,
      ),
    });
    /** 对照组：内容**一个字节都不变**（每次都是新对象）。这是「稳定投影」的纯度检验——
     *  没有它的话，这一组和「只动最后一条」一样贵，因为新对象让所有消息都换了 props。 */
    const identical = (): ConversationView => ({
      ...base,
      messages: base.messages.map((message) => ({ ...message })),
    });
    const cases: { label: string; make: (round: number) => ConversationView }[] = [
      { label: "只动最后一条", make: grow },
      { label: "内容完全不变", make: () => identical() },
    ];
    for (const item of cases) {
      window.webContents.send("session.view", item.make(0));
      await sleep(1200);
      await run(`window.__perfStart()`);
      for (let round = 0; round < 40; round++) {
        window.webContents.send("session.view", item.make(round));
        await sleep(50);
      }
      await report(`  ${count} 条 × 40 次（${item.label}）`);
    }
  }

  // ---- 三、空历史的重推：把「列表本身的成本」从「容器每次重渲染的固定成本」里分出来 ----
  // 若这一组的数与几十上百条时**差不多**，说明剩下那点开销与消息列表无关——
  // 那么虚拟化 / 折叠这类「少渲染几条」的手段都动不了它，别把力气花在那里。
  log("[三] 空历史重推（只看容器自身的固定开销）");
  {
    const empty = bigView(sessionId, 0);
    window.webContents.send("session.view", empty);
    await sleep(1200);
    await run(`window.__perfStart()`);
    for (let round = 0; round < 40; round++) {
      window.webContents.send("session.view", { ...empty });
      await sleep(50);
    }
    await report("  0 条 × 40 次");
  }
}
