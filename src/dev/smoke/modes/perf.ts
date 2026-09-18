// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

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
 *
 * 第四节起是**断言**（不是量数）：长会话的「消息窗口」到底只挂了最近一段、追加时跟不跟着走、
 * 「载入更早」展开对不对——判据取每行的 `data-msg-row` 与界面上的「还有 N 条/轮」；
 * 第五节量「只看问答」的**单位**（折叠时窗口按轮计，见 `lib/message-window.ts` 的 `FOLD_CHUNK`）；
 * 第六节量点链与搜索的跳转。
 */
import { BrowserWindow } from "electron";
import { createSession } from "../../../main/db/repo";
import type { ConversationView, ViewMessage, ViewToolResult } from "@shared/worker-protocol";
import { DEFAULT_THINKING_LEVEL } from "@shared/thinking-level";
import { sleep } from "../context";

/**
 * 造一份「看起来像真实长会话」的视图：有用户轮、有带工具调用的助手轮、有工具结果。
 *
 * `plain` 用来把**同一批结构、只是正文不含 Markdown** 的那一档单独量出来：
 * 挂载开销到底落在「DOM 节点/排版」上还是「Markdown 解析 + 代码高亮」上，
 * 两者的对策完全不同（前者靠少挂节点，后者靠少解析）。不分开量就只能猜。
 */
function bigView(sessionId: string, count: number, plain = false): ConversationView {
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
      text: plain
        ? `已完成第 ${i} 步。`
        : i % 3 === 0
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

  /**
   * 读「消息窗口」的状态：挂了多少行、起点是第几条、要挂的条数有没有、容器贴没贴底。
   *
   * 全靠**行自己的标记** `data-msg-row` 认，不按层级去猜（`[data-conv-scroll] > div > div`
   * 这种写法一旦中间多套一层就量到别的地方——见 AGENTS.md §五 ⑫）。行 id 是 `m<下标>`，
   * 于是「第一条挂的 = 第几条」这个数直接从 DOM 读得出来，不必再让产品另报一份。
   *
   * `hiddenFromLabel` 特意从**界面文字**里抠出来：它要和实际挂载数对一遍——
   * 界面上的「还有 N 条」若是自己算的，就会和真实窗口各算一遍、迟早漂（本仓有过这类翻车）。
   */
  const windowState = (): Promise<{
    mounted: number;
    firstIndex: number | null;
    lastIndex: number | null;
    hasButton: boolean;
    hiddenFromLabel: number | null;
    atBottom: boolean;
  }> =>
    run(`(() => {
      const area = document.querySelector("[data-conv-scroll]");
      if (!area) return { mounted: -1, firstIndex: null, lastIndex: null, hasButton: false, hiddenFromLabel: null, atBottom: false };
      const rows = [...area.querySelectorAll("[data-msg-row]")];
      const indexOf = (node) => {
        const m = /^m(\\d+)$/.exec(node.getAttribute("data-msg-row") || "");
        return m ? Number(m[1]) : null;
      };
      const btn = area.querySelector("[data-conv-earlier]");
      const label = btn ? (btn.textContent || "").match(/还有\\s*(\\d+)\\s*条/) : null;
      return {
        mounted: rows.length,
        firstIndex: rows.length > 0 ? indexOf(rows[0]) : null,
        lastIndex: rows.length > 0 ? indexOf(rows[rows.length - 1]) : null,
        hasButton: btn !== null,
        hiddenFromLabel: label ? Number(label[1]) : null,
        atBottom: area.scrollHeight - area.scrollTop - area.clientHeight <= 8,
      };
    })()`);

  /** 把容器滚到底——用来**显式建立**「用户正停在最新处」这个前提（见 AGENTS.md §五 ⑬） */
  const scrollToBottom = (): Promise<boolean> =>
    run<boolean>(
      `(() => { const a = document.querySelector("[data-conv-scroll]"); if (!a) return false; a.scrollTop = a.scrollHeight; return true; })()`,
    );

  // ---- 一、条数扫描：一次推一份全量视图，看渲染阻塞多久 ----
  // 注意这一组现在**只挂窗口那一段**（消息窗口见第四节）：条数越大、`挂载` 那一列越能说明
  // 「打开长会话」的开销已被封顶。这条数与历史长度脱钩正是 (b) 要的效果。
  log("[一] 单次全量推送（不同条数）");
  const singleCases: { count: number; plain: boolean }[] = [
    { count: 40, plain: false },
    { count: 200, plain: false },
    { count: 370, plain: false },
    { count: 800, plain: false },
    { count: 370, plain: true },
  ];
  for (const item of singleCases) {
    const view = bigView(sessionId, item.count, item.plain);
    const payloadKb = JSON.stringify(view).length / 1024;
    await run(`window.__perfStart()`);
    window.webContents.send("session.view", view);
    await sleep(2500);
    const dom = await domNodes();
    const mounted = (await windowState()).mounted;
    const label = item.plain ? `${item.count} 条·正文无 Markdown` : `${item.count} 条`;
    log(
      `  ${label}（payload ${payloadKb.toFixed(0)}KB，挂载 ${mounted} 条，DOM 节点 ${dom} 个）`,
    );
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

  // ---- 四、消息窗口：长会话只挂最近一段，更早的按需展开 ----
  // 上面三组量的是「挂上去之后贵不贵」，这一组量「**到底挂了多少**」——窗口的全部意义就是
  // 挂载条数不再随历史增长。判据尽量从 DOM 里读（每行的 `data-msg-row`），唯一的例外是
  // 「还有 N 条」那句界面文字，那正是要拿它和实际挂载数对一遍的地方。
  log("[四] 消息窗口（长会话只挂最近一段 + 按需展开）");
  const checks: [string, boolean][] = [];
  /**
   * 夹具的节奏：每 14 条一个用户轮，**i=0 也是一轮**——m0、m14、…、m798，共 58 轮。
   * 期望值一律从夹具节奏现算，不写死（上一版写死 57，漏数了 i=0 那轮，红断言查出来才纠正）。
   * 四、五、六三节都要用它。
   */
  const EXPECT_TURNS = Math.ceil(800 / 14);
  const push = async (count: number): Promise<void> => {
    window.webContents.send("session.view", bigView(sessionId, count));
    await sleep(900);
  };
  const clickEarlier = (): Promise<boolean> =>
    run<boolean>(
      `(() => { const b = document.querySelector("[data-conv-earlier]"); if (b) b.click(); return b !== null; })()`,
    );

  await push(800);
  const w800 = await windowState();
  await push(200);
  const w200 = await windowState();
  await push(800);
  const wBack = await windowState();

  checks.push([
    `800 条只挂了 ${w800.mounted} 条（不是把 800 条全挂上）`,
    w800.mounted > 0 && w800.mounted < 200,
  ]);
  checks.push([
    `挂载条数不随历史增长：200 条与 800 条挂的一样多（${w200.mounted} vs ${w800.mounted}）`,
    w200.mounted === w800.mounted && w200.mounted > 0,
  ]);
  checks.push([
    `挂的是**最新**那一段：尾=${w800.lastIndex}（应 799），首=${w800.firstIndex}，首+挂=${(w800.firstIndex ?? -1) + w800.mounted}（应 800）`,
    w800.lastIndex === 799 && w800.firstIndex !== null && w800.firstIndex + w800.mounted === 800,
  ]);
  checks.push([
    `界面「还有 N 条」与实际没挂的条数一致（${w800.hiddenFromLabel} vs ${w800.firstIndex}）`,
    w800.hasButton && w800.hiddenFromLabel !== null && w800.hiddenFromLabel === w800.firstIndex,
  ]);
  checks.push([
    `切回 800 条仍只挂那一段（窗口不随切换乱掉）`,
    wBack.mounted === w800.mounted && wBack.lastIndex === 799,
  ]);

  // —— 跟随底部：没展开时窗口锚在**最新**，追加一条就整体前移一格 ——
  // 先显式把容器滚到底，把「用户正停在最新处」这个前提建立起来（否则窗口跟不跟随
  // 取决于上一次滚轮停在哪，结论会随环境变——见 AGENTS.md §五 ⑬）。
  await scrollToBottom();
  await sleep(300);
  await push(801);
  const wFollow = await windowState();
  checks.push([
    `流式追加时窗口跟着走：尾=${wFollow.lastIndex}（应 800），起点 ${w800.firstIndex} → ${wFollow.firstIndex}（应前移一格）`,
    wFollow.lastIndex === 800 &&
      wFollow.mounted === w800.mounted &&
      wFollow.firstIndex === (w800.firstIndex ?? -1) + 1,
  ]);
  checks.push([`追加后仍停在底部（窗口没把用户弹走）`, wFollow.atBottom]);

  // —— 按需展开：点一次往前补一段，起点前移、总数守恒 ——
  const clicked = await clickEarlier();
  await sleep(400);
  const wExpand1 = await windowState();
  checks.push([
    `点「载入更早」按一段往前展开（挂载 ${wFollow.mounted} → ${wExpand1.mounted}）`,
    clicked && wExpand1.mounted > wFollow.mounted,
  ]);
  checks.push([
    `展开后总数对得上：首=${wExpand1.firstIndex}，首+挂=${(wExpand1.firstIndex ?? -1) + wExpand1.mounted}（应 801）`,
    wExpand1.firstIndex !== null && wExpand1.firstIndex + wExpand1.mounted === 801,
  ]);

  await clickEarlier();
  await sleep(400);
  const wExpand2 = await windowState();
  checks.push([
    `再点一次继续往前展开（${wExpand1.mounted} → ${wExpand2.mounted}）`,
    clicked && wExpand2.mounted > wExpand1.mounted,
  ]);

  // —— 展开之后不再跟随：追加只把尾部加长，不挤掉正在读的那几行 ——
  await push(802);
  const wPinned = await windowState();
  checks.push([
    `显式展开后不再跟随：起点不动（${wExpand2.firstIndex} → ${wPinned.firstIndex}），尾部只加长（挂载 ${wExpand2.mounted} → ${wPinned.mounted}）`,
    wPinned.firstIndex === wExpand2.firstIndex &&
      wPinned.mounted === wExpand2.mounted + 1 &&
      wPinned.lastIndex === 801,
  ]);

  // —— 滚到顶自动补一段（「载入更早」按钮只是兜底，这条路才是主要用法）——
  // 先滚下去再滚回顶：`scrollTop` 得**先 > 24** 才算「用户是自己翻上来的」，
  // 否则刚挂载时 scrollTop 本来就是 0，会被误判成「滚到顶」、一进来就自动加载。
  await scrollToBottom();
  await sleep(300);
  const wBeforeTop = await windowState();
  await run(`(() => { const a = document.querySelector("[data-conv-scroll]"); if (a) a.scrollTop = 0; return true; })()`);
  await sleep(500);
  const wAfterTop = await windowState();
  checks.push([
    `滚到顶自动再补一段（挂载 ${wBeforeTop.mounted} → ${wAfterTop.mounted}，起点 ${wBeforeTop.firstIndex} → ${wAfterTop.firstIndex}）`,
    wBeforeTop.firstIndex !== null &&
      wAfterTop.firstIndex !== null &&
      wAfterTop.firstIndex < wBeforeTop.firstIndex &&
      wAfterTop.mounted > wBeforeTop.mounted,
  ]);
  // 补进来的那一段是**加在顶上**的：不补偿滚动位置的话，用户正在读的内容会被顶下去。
  checks.push([
    `补完仍停在原先那几行（顶上补进来的高度被补偿掉，滚动位置没回到 0）`,
    await run<boolean>(`document.querySelector("[data-conv-scroll]").scrollTop > 24`),
  ]);

  // ---- 五、「只看问答」：一轮的过程收成一行 ----
  // 判据分两层：**收了没有**（摘要行出现、行数变少），以及**有没有把东西弄丢**——
  // 折叠最容易犯的错不是没收，是把提问或最终回复一起收掉了（那就不是阅读视图，是丢内容）。
  // 夹具的节奏是「每 14 条一个用户轮」，据此能认出「提问行」与「轮末回复行」。
  log("[五] 只看问答（一轮的过程收成一行）");
  const foldState = (): Promise<{ rows: string[]; summaries: number; collapses: number }> =>
    run(`(() => {
      const area = document.querySelector("[data-conv-scroll]");
      if (!area) return { rows: [], summaries: 0, collapses: 0 };
      return {
        rows: [...area.querySelectorAll("[data-msg-row]")].map((n) => n.getAttribute("data-msg-row") || ""),
        summaries: area.querySelectorAll("[data-conv-steps-summary]").length,
        collapses: area.querySelectorAll("[data-conv-steps-collapse]").length,
      };
    })()`);
  const clickText = (text: string): Promise<boolean> =>
    run<boolean>(
      `(() => {
        const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === ${JSON.stringify(text)});
        if (b) b.click();
        return b !== null;
      })()`,
    );
  const clickNth = (selector: string, nth: number): Promise<boolean> =>
    run<boolean>(
      `(() => {
        const list = [...document.querySelectorAll(${JSON.stringify(selector)})];
        const el = list[${nth}];
        if (el) el.click();
        return el !== null;
      })()`,
    );
  /** 夹具里 m<下标>：每 14 条一个用户轮，轮末是这 14 条里的最后一条助手消息 */
  const isUserRow = (id: string): boolean => Number(id.slice(1)) % 14 === 0;
  const isTurnEndRow = (id: string): boolean => Number(id.slice(1)) % 14 === 13;
  /** 「载入更早」按钮上的文案：窗口**按什么单位数**是给人看的，这句就是物证 */
  const earlierLabel = (): Promise<string> =>
    run<string>(
      `(() => { const b = document.querySelector("[data-conv-earlier]"); return b === null ? "" : (b.textContent || "").trim(); })()`,
    );

  // 先离开顶端：贴着顶时补一次高度或滚动都可能触发「滚到顶自动加载」，行数会被搅动
  await scrollToBottom();
  await sleep(300);
  const unfolded = await foldState();
  const unfoldedUsers = unfolded.rows.filter(isUserRow);
  const unfoldedEnds = unfolded.rows.filter(isTurnEndRow);
  checks.push([
    `默认「完整」：一条过程都没收起来（摘要行 ${unfolded.summaries} 个）`,
    unfolded.summaries === 0 && unfolded.rows.length > 0,
  ]);

  const foldClicked = await clickText("只看问答");
  await sleep(500);
  const folded = await foldState();
  const foldedUsers = folded.rows.filter(isUserRow);
  checks.push([
    `点开「只看问答」后每轮收成一行（摘要行 ${folded.summaries} 个）`,
    foldClicked && folded.summaries > 0,
  ]);
  // 折叠换的是窗口的**单位**：一个窗口是 50 **轮**，不是 50 条。不换单位的话这里只挂出三四轮
  // （夹具里一轮 14 条），而点这个开关的人要的正是**多读几轮**——那就是这个开关的全部意义。
  const earlierText = await earlierLabel();
  checks.push([
    `折叠后窗口按**轮**计：「${earlierText}」，挂出 ${foldedUsers.length} 轮（展开态只有 ${unfoldedUsers.length} 轮）`,
    earlierText.includes("轮") &&
      foldedUsers.length > unfoldedUsers.length &&
      foldedUsers.length < EXPECT_TURNS,
  ]);
  // 折叠最容易犯的错不是没收，是把提问或最终回复一起收掉了（那就不是阅读视图，是丢内容）。
  // 判据取**包含关系**：折叠的窗口比展开的更靠前，展开态看到的那些行必须一条不少地还在。
  checks.push([
    `折叠没丢内容：展开态那 ${unfoldedUsers.length} 个提问与 ${unfoldedEnds.length} 个轮末回复都还在`,
    unfoldedUsers.length > 0 &&
      unfoldedEnds.length > 0 &&
      [...unfoldedUsers, ...unfoldedEnds].every((id) => folded.rows.includes(id)),
  ]);

  // 收起来的那一行必须是**可展开的入口**（规则 ④-C：卡片不可省略、不可简化成一行纯文本）
  const summaryClicked = await clickNth("[data-conv-steps-summary]", 0);
  await sleep(400);
  const expanded = await foldState();
  checks.push([
    `点开摘要行能看回过程（行数 ${folded.rows.length} → ${expanded.rows.length}）`,
    summaryClicked && expanded.rows.length > folded.rows.length,
  ]);
  checks.push([
    `展开只影响那一轮，别的轮仍收着（摘要行 ${folded.summaries} → ${expanded.summaries}，收起入口 ${expanded.collapses} 个）`,
    expanded.summaries === folded.summaries - 1 && expanded.collapses === 1,
  ]);

  const collapseClicked = await clickNth("[data-conv-steps-collapse]", 0);
  await sleep(400);
  const refolded = await foldState();
  checks.push([
    `再点「收起过程」回到一行摘要（行数 ${expanded.rows.length} → ${refolded.rows.length}）`,
    collapseClicked &&
      refolded.summaries === folded.summaries &&
      refolded.rows.length === folded.rows.length,
  ]);

  // 关掉开关要**完全复原**：它只是显示层的收纳，不许留下被藏起来的内容
  await clickText("只看问答");
  await sleep(500);
  const restored = await foldState();
  checks.push([
    `关掉开关完全复原（行数回到 ${unfolded.rows.length}，摘要行归零）`,
    restored.summaries === 0 && restored.rows.length === unfolded.rows.length,
  ]);

  // ---- 六、轮次点链与搜索：跳到某一轮 ----
  // 「翻历史」的另一半是**找**。判据分四层：① 点链（目录的常驻化）在离开顶部后浮现，
  // 可见点数是默认的 11、总点数等于轮数、当前点跟着滚动走；
  // ② 搜索只回命中；③ 点命中/点链上的点真的跳过去；
  // ④ 跳过去之后**没有**把中间几千条一起挂出来——
  // 沿用「一直挂到末尾」就等于把窗口废掉，这是这一步最容易做错的地方。
  log("[六] 轮次点链 / 搜历史（跳到某一轮）");
  const railState = (): Promise<{
    shell: boolean;
    shown: boolean;
    visible: number;
    total: number;
    current: number | null;
  }> =>
    run(`(() => {
      const shell = document.querySelector("[data-turn-rail-shell]");
      if (shell === null) return { shell: false, shown: false, visible: 0, total: 0, current: null };
      const dots = [...document.querySelectorAll("[data-turn-rail-dot]")];
      const viewport = document.querySelector("[data-turn-rail]");
      let visible = dots.length;
      if (viewport !== null) {
        const vrect = viewport.getBoundingClientRect();
        // 视口内可见的点数：rect 落在滚动视口内的才算「展示着」
        visible = dots.filter((n) => {
          const r = n.getBoundingClientRect();
          return r.top >= vrect.top - 1 && r.bottom <= vrect.bottom + 1;
        }).length;
      }
      const cur = document.querySelector("[data-turn-rail-dot][data-current]");
      const current = cur !== null ? Number(cur.getAttribute("data-turn")) : null;
      return {
        shell: true,
        shown: getComputedStyle(shell).opacity !== "0",
        visible,
        total: dots.length,
        current,
      };
    })()`);
  const historyState = (): Promise<{ open: boolean; hits: string[] }> =>
    run(`(() => {
      const panel = document.querySelector("[data-conv-history]");
      if (panel === null) return { open: false, hits: [] };
      return {
        open: true,
        hits: [...panel.querySelectorAll("[data-conv-history-hit]")].map((n) => n.getAttribute("data-conv-history-hit") || ""),
      };
    })()`);
  /** React 的受控 input：直接改 `value` 它收不到，得走原型上的 setter 再派发 input 事件 */
  const typeInto = (selector: string, text: string): Promise<boolean> =>
    run<boolean>(
      `(() => {
        const input = document.querySelector(${JSON.stringify(selector)});
        if (input === null) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(input, ${JSON.stringify(text)});
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      })()`,
    );
  const toolbar = (): Promise<{ latest: boolean; later: boolean; earlier: boolean }> =>
    run(`(() => {
      const area = document.querySelector("[data-conv-scroll]");
      if (area === null) return { latest: false, later: false, earlier: false };
      return {
        latest: area.querySelector("[data-conv-latest]") !== null,
        later: area.querySelector("[data-conv-later]") !== null,
        earlier: area.querySelector("[data-conv-earlier]") !== null,
      };
    })()`);

  await push(800);
  await scrollToBottom();
  await sleep(300);
  // 夹具共 EXPECT_TURNS 轮（见本节开头），远多于点链默认可见的 11 个——所以点链必须自己滚。
  const railBottom = await railState();
  checks.push([
    `滚离顶部后点链浮现（${EXPECT_TURNS} 轮全部在列，视口内可见 ${railBottom.visible} 个点，当前点在第 ${railBottom.current} 轮）`,
    railBottom.shell &&
      railBottom.shown &&
      railBottom.total === EXPECT_TURNS &&
      railBottom.visible === 11 &&
      railBottom.current !== null &&
      railBottom.current >= 50,
  ]);

  const opened = await clickText("搜索");
  await sleep(400);
  const panel = await historyState();
  checks.push([
    `「搜索」拉出浮层（目录已不在浮层里，由点链承担）`,
    opened && panel.open,
  ]);

  // 搜一段**只出现在一条消息里**的文字（夹具里只有 i % 3 === 0 的助手消息带正文）
  await typeInto("[data-conv-history-query]", "const x = 372");
  await sleep(400);
  const searched = await historyState();
  checks.push([
    `搜索只回命中项（${searched.hits.length} 条，命中下标 ${searched.hits[0]}）`,
    searched.hits.length === 1 && searched.hits[0] === "372",
  ]);

  const hitClicked = await clickNth("[data-conv-history-hit]", 0);
  await sleep(600);
  const afterJump = await windowState();
  const closed = await run<boolean>(`document.querySelector("[data-conv-history]") === null`);
  const jumpedToolbar = await toolbar();
  checks.push([
    `点搜索结果跳过去：浮层收起、首行就是第 ${afterJump.firstIndex} 条（应 372）`,
    hitClicked && closed && afterJump.firstIndex === 372,
  ]);
  checks.push([
    `跳过去只挂一个窗口（挂载 ${afterJump.mounted} 条，尾=${afterJump.lastIndex}），没把 372→末尾 428 条一起挂出来`,
    afterJump.mounted <= 100 && afterJump.lastIndex !== 799,
  ]);
  checks.push([
    `跳转后切到浮动段（有「载入更晚」「回到最新」）`,
    jumpedToolbar.latest && jumpedToolbar.later,
  ]);

  // 往下翻一页：整段前移（不是「加到末尾」）。用**实测的段长**算期望，不写死常量
  const paged = await clickNth("[data-conv-later]", 0);
  await sleep(500);
  const afterPage = await windowState();
  checks.push([
    `「载入更晚」往下翻一页（首行 ${afterJump.firstIndex} → ${afterPage.firstIndex}，挂载 ${afterJump.mounted} → ${afterPage.mounted}）`,
    paged &&
      afterPage.firstIndex === (afterJump.firstIndex ?? 0) + afterJump.mounted &&
      afterPage.mounted === afterJump.mounted,
  ]);

  // 回到最新：交回「跟随底部」，落到**真正的**末尾
  const backClicked = await clickNth("[data-conv-latest]", 0);
  await sleep(500);
  const latest = await windowState();
  const stillFloating = await run<boolean>(`document.querySelector("[data-conv-latest]") !== null`);
  checks.push([
    `「回到最新」落到真正的末尾（尾=${latest.lastIndex} 应 799）并交回跟随`,
    backClicked && !stillFloating && latest.lastIndex === 799 && latest.atBottom,
  ]);

  // 从点链直接跳到**开头**：最坏的一跳（后面还有 799 条），挂载也必须还是一个窗口。
  // 点第 1 轮的点——它在视口外（rail 正停在末尾那几轮），但 click 照样命中
  const dotClicked = await run<boolean>(`(() => {
    const dot = document.querySelector('[data-turn-rail-dot][data-turn="1"]');
    if (dot === null) return false;
    dot.click();
    return true;
  })()`);
  await sleep(600);
  const atStart = await windowState();
  const railAtTop = await railState();
  checks.push([
    `从点链跳到开头：只挂一个窗口（首=${atStart.firstIndex} 尾=${atStart.lastIndex}，挂载 ${atStart.mounted} 条）`,
    dotClicked &&
      atStart.firstIndex === 0 &&
      atStart.mounted <= 100 &&
      atStart.lastIndex !== 799,
  ]);
  checks.push([
    `跳回开头后滚动位置也回到顶部，点链随之淡出`,
    railAtTop.shell && !railAtTop.shown,
  ]);

  for (const [name, ok] of checks) log(`  ${ok ? "✓" : "✗"} ${name}`);
  log(`通过 ${checks.filter(([, ok]) => ok).length}/${checks.length}`);
}
