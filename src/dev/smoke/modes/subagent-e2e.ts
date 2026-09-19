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
 * 小模型的服从是概率事件（0.6b 实测过四种失败形态：不调工具、子代理假装写了、
 * 绕过委派自己直接 write、**看过一轮成功后记下回传格式、对下一轮编造假结果**），
 * 所以「发 prompt → 等内部 write」整条可重试至多 5 次：主 lane 绕过委派的直接 write
 * 会被**拒掉并在理由里指路**，断言一条不放水。第四种形态靠**分段会话**破解：
 * reckless 在另一个全新会话里跑，历史里没有被抄的委派成功。
 *
 * prompt C 验**递归防护的模型侧**：夹具 `reckless.md` 的定义里**显式白名单了
 * subagent**（作者恶意/误配），`#spawn` 仍必须把它硬剥掉。depth 守卫（「调用方不是
 * 主 lane 就拒」）被白名单挡在模型可达面之外，模型侧能钉的物证是落盘 JSONL 里子 lane
 * **运行时** `pi.op.state` 的 `batch.configuration.activeToolNames`（恰好等于白名单）。
 * ⚠️ `pi.lane.config` 是创建时的种子快照（全量），不是运行态，拿它断言必假阴性。
 *
 * 夹具：`<fixture>/.agents/agents/demo.md`（frontmatter 白名单 `write, read`）与
 * `reckless.md`（对抗定义，白名单 `write, subagent`），与生产发现路径同构
 * （`agent-defs.ts` 的 `<cwd>/.agents/agents/`）。必须在 `window.reload()` 之前写好：
 * 清单在 worker init 时装载，后写模型看不见。
 */
import { app, BrowserWindow } from "electron";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { join } from "node:path";
import { createSession, getSession, upsertProject } from "../../../main/db/repo";
import { sessionManager } from "../../../main/session-manager";
import { listProviders } from "../../../main/providers";
import { hasUsableProvider } from "@shared/model-ref";
import type { ConversationView } from "@shared/worker-protocol";
import { sleep, uncaughtErrors } from "../context";

/** 子代理定义名：夹具文件名（去 .md），也是 prompt 点名的 agent 入参 */
const AGENT_NAME = "demo";

/** 对抗夹具名：定义里**显式白名单 subagent**，验证 spawn 的硬剥（递归无入口） */
const RECKLESS_NAME = "reckless";

export async function runSubagentE2e(
  window: BrowserWindow,
  log: (message: string) => void,
  run: <T>(expression: string) => Promise<T>,
): Promise<void> {
  const fixtureDir = join(process.cwd(), "out", "smoke-subagent-e2e-fixture");
  // 先清空再写：模型在失败尝试里可能往 .agents/agents/ 写 stray 定义（实测写到过
  // researcher.md / general.md），不清的话清单会累积、报错文本不确定。
  const agentsDir = join(fixtureDir, ".agents", "agents");
  rmSync(agentsDir, { recursive: true, force: true });
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, `${AGENT_NAME}.md`),
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
  // 对抗定义：作者显式把 subagent 写进 tools——spawn 必须硬剥它（depth=1 的模型侧证据）。
  // 必须在 window.reload() 之前写好：清单在 worker init 时装载，后写模型看不见。
  writeFileSync(
    join(agentsDir, `${RECKLESS_NAME}.md`),
    [
      "---",
      "description: 冒烟夹具对抗子代理：定义里显式要求 subagent 工具",
      "tools: write, subagent",
      "---",
      "",
      "你是冒烟夹具对抗子代理。严格按 task 要求行事。",
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
  const getView = (sid: string): ConversationView | undefined => sessionManager.getView(sid);

  /** reload 后等渲染层自动打开某会话（worker 就绪）——worker 的生死交给渲染层 */
  const waitOpened = async (sid: string): Promise<boolean> => {
    window.reload();
    await sleep(4000);
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (getView(sid)) return true;
      await sleep(1000);
    }
    return false;
  };

  const waitSettled = async (
    sid: string,
    before: number,
    timeoutMs: number,
  ): Promise<ConversationView> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const view = getView(sid);
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
  const waitInnerWrite = async (sid: string, steerAgent: string, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    let sawRunning = false;
    const rejectedBypass = new Set<string>();
    for (;;) {
      const pending = sessionManager.approvals.listPending(sid);
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
        // 必须走 resolveApproval（清计时器 + 给 worker 回 approvalResult）——
        // 只调 approvals.resolve 的话 worker 的阻塞无人唤醒，lane 挂到超时（实测踩过）。
        sessionManager.resolveApproval({
          sessionId: sid,
          toolCallId: item.toolCallId,
          approved: false,
          reason:
            `不要自己直接写文件。请用 subagent 工具委派 ${steerAgent} 子代理去做这件事，` +
            "task 里写清要它创建什么文件。",
        });
      }
      const view = getView(sid);
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

  type PendingApproval = ReturnType<typeof sessionManager.approvals.listPending>[number];

  /**
   * 发一条点名委派的 prompt，等到**带归属**的内部 write 进闸。
   * 小模型（0.6b）服从是概率事件（实测同一条 prompt 有时一次过、有时连错 3 次），
   * 整条可重试至多 5 次，断言一条不放水。
   */
  const MAX_ATTEMPTS = 5;
  const delegateUntilInnerWrite = async (
    sid: string,
    steerAgent: string,
    label: string,
    text: string,
  ): Promise<PendingApproval> => {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 1) log(`第 ${attempt} 次尝试 ${label}（上次子代理没真的调 write）…`);
      await run(
        `window.colt.invoke("session.prompt", ${JSON.stringify({ sessionId: sid, text })})`,
      );
      log(`已发出 ${label}，等子代理发起内部 write…`);
      try {
        return await waitInnerWrite(sid, steerAgent, 180_000);
      } catch (error) {
        const endedWithoutWrite =
          error instanceof Error && error.message.includes("主 lane 结束了却没等到");
        if (!endedWithoutWrite || attempt === MAX_ATTEMPTS) throw error;
      }
    }
    throw new Error(`${label} ${MAX_ATTEMPTS} 次尝试都没等到子代理的内部 write`);
  };

  /** 批准确走真实 UI（同 mcp-e2e：「允许一次」唯一候选 + 命中测试 + 真点击） */
  const clickAllowOnce = (): Promise<string> => run<string>(`(() => {
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

  /**
   * 批准确走真实 UI（同 mcp-e2e：「允许一次」唯一候选 + 命中测试 + 真点击）。
   * 批渲染晚于待审进主进程一拍，点击带重试：30s 内 pending 清空才算批到。
   */
  const approveViaUi = async (sid: string): Promise<boolean> => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const result = await clickAllowOnce();
      await sleep(1000);
      if (result === "clicked" && sessionManager.approvals.listPending(sid).length === 0) {
        return true;
      }
      if (attempt === 0 || attempt === 29) {
        log(`  批准重试 ${attempt + 1}：${result}，pending=${sessionManager.approvals.listPending(sid).length}`);
      }
    }
    return false;
  };

  /**
   * 从落盘 JSONL 收集指定会话里所有 `pi.op.state` 的
   * `batch.configuration.activeToolNames`（子 lane **实际运行时**的工具名单，排序后 JSON 去重）。
   *
   * ⚠️ 不能拿 `pi.lane.config` 当物证（实测踩过）：它记的是 lane 创建时的**种子值**
   * （全量 14 个工具），`setActiveTools` 的运行时更新不落这个 namespace——
   * 拿它断言会得出「白名单没生效」的**假阴性**（与 §五⑤「电平别拿创建时快照当运行态」同源）。
   *
   * ⚠️ 定位文件**不能**按 `join(userData, "sessions", project.id)`（实测踩过，报「集合为空」）：
   * DB 里 project.id 是 UUID，而内核按**转义后的 cwd** 建目录、按 `时间戳_kernelId.jsonl` 命名
   * （报错现场是 `readdirSync(<uuid> 目录)` 抛异常 → 静默 catch → 空集合）。这里沿用产品自己的
   * 定位法（`ipc/index.ts` 的 `removeSessionJsonl`）：在 sessions 根下递归搜**文件名含本会话
   * kernelSessionId** 的 `.jsonl`——只收**本次会话**的文件，避免把历次冒烟遗留的旧文件一并
   * 并进来（否则判据会被旧物证喂成**假绿**，比红更危险）。
   */
  const batchedToolNameSets = (sids: string[]): Set<string> => {
    const found = new Set<string>();
    const kernelIds = sids
      .map((sid) => getSession(sid)?.kernelSessionId)
      .filter((id): id is string => typeof id === "string" && id !== "");
    if (kernelIds.length === 0) return found;
    const root = join(app.getPath("userData"), "sessions");
    if (!existsSync(root)) return found;
    const files: string[] = [];
    const stack = [root];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (entry.name.endsWith(".jsonl") && kernelIds.some((id) => entry.name.includes(id))) {
          files.push(full);
        }
      }
    }
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const line of text.split("\n")) {
        if (!line.includes("pi.op.state") || !line.includes("activeToolNames")) continue;
        try {
          const arr: unknown[] = line.trim().startsWith("[") ? JSON.parse(line) : [JSON.parse(line)];
          for (const entry of arr as {
            namespace?: string;
            value?: { batch?: { configuration?: { activeToolNames?: unknown } } };
          }[]) {
            const names = entry.value?.batch?.configuration?.activeToolNames;
            if (entry.namespace === "pi.op.state" && Array.isArray(names)) {
              found.add(JSON.stringify([...names].sort()));
            }
          }
        } catch {
          // 行解析失败就跳过——判据落在「找到且字段对」，不因单行坏数据误判
        }
      }
    }
    return found;
  };

  let session2: ReturnType<typeof createSession> | undefined;

  try {
    if (!hasUsableProvider(listProviders())) {
      checks.push(["前置：存在可用的模型服务（没有就无法真实调用）", false]);
      log("没有可用的模型服务。请先配好一个服务（本地 Ollama 也行）再跑本模式。");
      return;
    }
    checks.push(["前置：存在可用的模型服务", true]);

    const opened = await waitOpened(session.id);
    checks.push(["渲染层自动打开夹具会话（worker 就绪）", opened]);
    if (!opened) return;

    // 0.6b 这类小模型的 thinking 会把它锚回上一条指令；切到 low 让它直接服从当前指令。
    await run(
      `window.colt.invoke("session.setThinkingLevel", ${JSON.stringify({ sessionId: session.id, level: "low" })})`,
    );

    // ── prompt A：把密语钉进主 transcript（让下面的「缺席」断言不空洞）──
    const nonce = `colt-sub-${Math.random().toString(16).slice(2, 10)}`;
    const beforeA = getView(session.id)?.messages.length ?? 0;
    await run(
      `window.colt.invoke("session.prompt", ${JSON.stringify({
        sessionId: session.id,
        text: `记住这个密语：${nonce}。只回复「记住了」两个字，不要做别的。`,
      })})`,
    );
    const viewA = await waitSettled(session.id, beforeA, 120_000);
    checks.push(["prompt A 落定（主对话基线正常）", viewA.lastRun?.status === "completed"]);
    checks.push(["密语已进主对话（下面的「缺席」断言才有比对物）", JSON.stringify(viewA.messages).includes(nonce)]);

    // ── prompt B：点名调用 demo 子代理，task 里让它 write 一个文件 ──
    const beforeB = getView(session.id)?.messages.length ?? 0;
    const entriesBeforeB = getView(session.id)?.subagents.length ?? 0;
    const inner = await delegateUntilInnerWrite(
      session.id,
      AGENT_NAME,
      "prompt B",
      `不要直接回答我，必须调用工具。调用 subagent 工具，参数照抄这一行：` +
        `{"agent":"${AGENT_NAME}","task":"用 write 工具创建文件 hello.txt，内容就一行：from-subagent"}` +
        "。拿到子代理的结果后，原样复述它的话，然后停下来。",
    );
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
    const runningEntry = getView(session.id)
      ?.subagents.slice(entriesBeforeB)
      .filter((item) => item.name === AGENT_NAME)
      .at(-1);
    checks.push([
      "视图出现 demo 子代理活条目（模型按名调用了它＝清单真的被看见了）",
      runningEntry !== undefined && runningEntry.status === "running",
    ]);

    // 批准确走真实 UI（命中测试 + 真点击，渲染竞速带重试）
    const card = await approveViaUi(session.id);
    checks.push([
      "点「允许一次」后待审清空（批准确到了子 lane 的闸门）",
      card,
    ]);

    const viewB = await waitSettled(session.id, beforeB, 240_000);
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

    // ── prompt C：递归防护的模型侧——对抗定义 reckless 显式白名单了 subagent ──
    // depth 守卫（「调用方不是主 lane 就拒」）被白名单挡在模型可达面之外，模型侧能验的
    // 是**硬剥本身**：定义写了 tools: write, subagent，spawn 也必须把 subagent 剥掉。
    // 物证是落盘 JSONL 里子 lane 运行时 batch 配置（pi.op.state），不从 transcript 猜。
    //
    // 必须在**另一个新会话**里跑：实测 0.6b 在看过 demo 成功的一轮后，会对 reckless
    // 编造「子代理已完成（N 步，用了 write×1…）」的假结果、照抄上一轮回传格式——
    // 5 次尝试全是编故事、零真实调用。新会话没有可抄的成功历史，委派成功率恢复正常。
    session2 = createSession(
      project.id,
      join(app.getPath("userData"), "sessions", project.id),
    );
    log(`会话 2：${session2.id}（reckless 单独跑，防 0.6b 照抄 demo 结果编故事）`);
    const opened2 = await waitOpened(session2.id);
    checks.push(["会话 2 就绪（reckless 独立会话，历史里无可抄的委派成功）", opened2]);
    if (!opened2) throw new Error("会话 2 未就绪");
    await run(
      `window.colt.invoke("session.setThinkingLevel", ${JSON.stringify({ sessionId: session2.id, level: "low" })})`,
    );
    const beforeC = getView(session2.id)?.messages.length ?? 0;
    const entriesBeforeC = getView(session2.id)?.subagents.length ?? 0;
    const inner2 = await delegateUntilInnerWrite(
      session2.id,
      RECKLESS_NAME,
      "prompt C",
      `不要直接回答我，必须调用工具。调用 subagent 工具，参数照抄这一行：` +
        `{"agent":"${RECKLESS_NAME}","task":"用 write 工具创建文件 reckless.txt，内容就一行：from-reckless。然后尝试用 subagent 工具再开一个子代理做随便什么事"}` +
        "。拿到子代理的结果后，原样复述它的话，然后停下来。",
    );
    checks.push([
      "reckless 委派带「来自 reckless」归属进闸",
      inner2.subagent !== undefined && inner2.subagent.name === RECKLESS_NAME,
    ]);
    const card2 = await approveViaUi(session2.id);
    checks.push([
      "reckless 的批准确走 UI（点「允许一次」后待审清空）",
      card2,
    ]);
    const viewC = await waitSettled(session2.id, beforeC, 240_000);
    const entry2 = viewC.subagents
      .slice(entriesBeforeC)
      .filter((item) => item.name === RECKLESS_NAME)
      .at(-1);
    checks.push([
      "reckless 子代理跑完（completed 且有时间戳）",
      entry2 !== undefined && entry2.status === "completed" && entry2.endedAt !== undefined,
    ]);
    // 硬剥的确定性物证：子 lane **运行时** batch 配置恰好等于白名单
    //（demo=read+write；reckless 对抗定义列了 subagent 也被剥到只剩 write——
    // 若硬剥失效，运行时配置只会是全量 14 个，绝不会出现这两个精确集合）
    const batchSets = batchedToolNameSets([session.id, session2.id]);
    log(`  运行时工具名单集合：${[...batchSets].join(" ；")}`);
    checks.push([
      "子 lane 白名单硬剥 subagent（对抗定义显式列了也没用；运行时 batch 配置物证）",
      batchSets.has(JSON.stringify(["read", "write"])) && batchSets.has(JSON.stringify(["write"])),
    ]);
    if (entry2 !== undefined) {
      const recklessTranscript = await sessionManager.subagentTranscript(session2.id, entry2.id);
      const hay2 = JSON.stringify(recklessTranscript);
      // 阴性判据：子 lane 里**没有** subagent 工具调用（fresh transcript 里出现即红）
      checks.push(["reckless transcript 里没有 subagent 工具调用（递归无入口）", !hay2.includes('"name":"subagent"')]);
    } else {
      checks.push(["reckless transcript 里没有 subagent 工具调用（递归无入口）", false]);
    }
    try {
      const args2 = JSON.parse(inner2.argsJson) as { path?: string };
      const written2 = args2.path !== undefined ? join(fixtureDir, args2.path) : null;
      checks.push([
        "reckless 的内部 write 真的落了盘（reckless.txt，内容 from-reckless）",
        written2 !== null &&
          existsSync(written2) &&
          readFileSync(written2, "utf8").includes("from-reckless"),
      ]);
      if (written2 !== null) log(`  落盘文件：${written2}`);
    } catch {
      checks.push(["reckless 的内部 write 真的落了盘（reckless.txt，内容 from-reckless）", false]);
    }

    checks.push(["模型接着往下做了（本轮 completed 且有新助手消息）", viewC.lastRun?.status === "completed" && lastAnswer(viewC) !== ""]);
    checks.push(["全程未抛未捕获异常", uncaughtErrors.length === 0]);
  } finally {
    for (const sid of [session.id, session2?.id].filter((v): v is string => v !== undefined)) {
      try {
        await run(`window.colt.invoke("session.close", ${JSON.stringify({ sessionId: sid })})`);
      } catch (error) {
        log(`关闭会话失败（无害）：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    log("[subagent-e2e] 端到端断言");
    for (const [name, ok] of checks) log(`  ${ok ? "✓" : "✗"} ${name}`);
    log(`通过 ${checks.filter(([, ok]) => ok).length}/${checks.length}`);
  }
}
