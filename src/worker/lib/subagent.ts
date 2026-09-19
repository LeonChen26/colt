// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * `subagent` 工具：把一件事**整包交给另一个 agent** 去做。
 *
 * 执行模型 = **同会话多 lane，进程内**（先例是 `/memory-tidy` 的 `TIDY_LANE`）：
 * 子代理跑在自己的 lane 上——独立 transcript、独立工具白名单（`setActiveTools` 按 lane
 * 持久化）、与主对话并行；审批闸门是全 harness 共享的，所以子代理的写/执行**照样被拦**。
 * 不学「`repo.fork` 开新 session + 第二个 harness」：那是多一行会话记录 + 多一个进程，
 * 资源账更贵，而独立 lane 已经白拿了同样的隔离。
 *
 * fork 语义 = **只有 `fresh`**（`createAt: null`）：子代理**只有委托方写的那段 `task`**，
 * 刻意**不继承**主对话历史。理由不是「晚点做 fork」，而是 fork 与隔离的目的冲突——
 * 隐式整份复制会把主对话的噪声与错误假设一起搬过去，每次还付一遍重放的钱；
 * `fresh` 逼出来的是「显式、有损、由委托方决定什么重要」的交接。故 v1 **连 `context`
 * 参数都不暴露**（模型没有机会选错）。
 *
 * 递归**禁止**（depth = 1）：白名单不含本工具 + 工具描述明写 + 这里还有一道
 * 「调用方不是主 lane 就拒绝」的守卫。递归 spawn 是最容易失控的一类（自我复制 + 费用失控）。
 *
 * 呈现见 `docs/DESIGN-subagents.md` 决策三：④ 的活卡 + ⑦「任务摘要」此刻段 + 下钻，
 * **不新增页签、不自动展开右栏**。本文件只负责把状态放进 `ViewSubagent`，
 * 界面怎么画不在这里。
 */
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { Static } from "typebox";
import {
  reduceLaneSnapshot,
  type AgentHarness,
  type AgentHarnessTool,
  type AgentLane,
  type Context,
  type ExecutionToolContext,
  type LaneSnapshot,
} from "@earendil-works/pi-agent-core";
import type { ViewSubagent } from "@shared/worker-protocol";
import type { AgentDef } from "./agent-defs";
import { projectSubagent, type SubagentProjectionInput } from "./subagent-view";
import { toolDurations } from "./tool-bookkeeping";

/** 工具名常量：注册名与闸门判据**必须同源**（改错会静默变成「委派也要弹卡」） */
export const SUBAGENT_TOOL_NAME = "subagent";

/** 子代理 lane 名前缀。名字即**持久身份**：内核按 lane 名持久化配置与恢复 */
export const SUBAGENT_LANE_PREFIX = "sub:";

export function isSubagentTool(toolName: string): boolean {
  return toolName === SUBAGENT_TOOL_NAME;
}

export function isSubagentLane(laneName: string): boolean {
  return laneName.startsWith(SUBAGENT_LANE_PREFIX);
}

/**
 * 并发上限：同时最多几路子代理。
 *
 * 上限的理由不是「内核扛不住」而是**费用与注意力**：模型在一轮里发多个 `subagent` 调用
 * 时内核并发执行，没有上限时一次「顺便都查一下」就能开出十几路真实计费请求。
 */
export const MAX_CONCURRENT_SUBAGENTS = 3;

/** 单个子代理的墙钟上限，到点中止并在结果里如实说明（否则一路跑掉没人拦得住） */
export const MAX_SUBAGENT_MS = 10 * 60 * 1000;

/** 注册表里保留多少个**已结束**的子代理（④ 卡与下钻要能查到；再多就只保最近这些） */
export const MAX_FINISHED_SUBAGENTS = 20;

/** 标题上限——它进「任务摘要」那一行与 ④ 卡，太长会把行撑爆 */
export const MAX_TITLE_CHARS = 60;

const subagentSchema = Type.Object({
  agent: Type.String({
    description: "子代理定义名（见系统提示词里的 <available_subagents> 清单）",
  }),
  task: Type.String({
    description:
      "要它做的事。**必须自包含**：子代理看不到我们这段对话，只有你写的这段话。" +
      "至少写清：背景（相关路径 / 已知事实）、目标、交付物、约束。" +
      "写不清它必然空转——而它用的是同一个模型、同样按次计费。",
  }),
  title: Type.Optional(
    Type.String({ description: `一句话任务摘要（界面显示用，≤${MAX_TITLE_CHARS} 字符；缺省取 task 首行）` }),
  ),
});

type SubagentParams = Static<typeof subagentSchema>;

/** 编排侧需要从 entry 拿到的能力（工具在 harness 建好之前就要交出去，故 harness 是惰性取的） */
export interface SubagentDeps {
  /** 主 lane 名——depth 守卫的判据 */
  mainLane: string;
  defs: readonly AgentDef[];
  harness: () => AgentHarness<ExecutionToolContext> | undefined;
  /** 状态有变（开始 / 结束 / 流式推进）→ 推一次视图（实现方自己合并节流） */
  onUpdate: () => void;
}

interface SubagentRun {
  id: string;
  toolCallId: string;
  name: string;
  title: string;
  status: ViewSubagent["status"];
  startedAt: number;
  endedAt?: number;
  error?: string;
  snapshot: LaneSnapshot;
  stats: { inputTokens: number; outputTokens: number; costUsd: number };
  unsubscribe: () => void;
}

/** 内核 `lane.prompt` / `lane.abort` 的失败（`Result.err`）→ 给用户看的一句话 */
export function describeSubagentError(error: unknown): string {
  const tag = (error as { _tag?: string } | undefined)?._tag;
  switch (tag) {
    case "LaneBusy":
      return "这个子代理还在忙，请等它结束。";
    case "Closed":
      return "会话已关闭，无法委派子代理。";
    case "InvalidMessage":
      return "任务描述不合法，未能发起委派。";
  }
  const message =
    error instanceof Error
      ? error.message
      : typeof (error as { message?: unknown } | undefined)?.message === "string"
        ? (error as { message: string }).message
        : String(error);
  return `子代理未能启动：${message}`;
}

/** 按上限截断标题——**显式给的 title 也要过这一道**（schema 里写了 ≤60，不截就是撒谎） */
export function truncateTitle(title: string): string {
  return title.length > MAX_TITLE_CHARS ? `${title.slice(0, MAX_TITLE_CHARS)}…` : title;
}

/** 标题缺省取 task 首行（空则回落到定义名，绝不产出空标题） */
export function deriveTitle(task: string, agentName: string): string {
  const firstLine = task.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "";
  return truncateTitle(firstLine === "" ? agentName : firstLine);
}

/**
 * 子代理系统提示词 = 定义正文 +（可选的）AGENTS.md 块。
 *
 * **不注入记忆、不注入技能清单**：记忆是**主对话的**沉淀优势，注入等于把父的上下文
 * 偷渡给子代理；技能清单一列，模型就会以为「我可以调技能」，而子代理的工具面是硬白名单、
 * 根本没有 skill 能力——那是死入口（`AGENTS.md` §3.6）。
 * 定义找不到时（磁盘上的定义被删了）给一段通用提示词，而不是让它落回编码助手的提示词。
 */
export function subagentSystemPrompt(def: AgentDef | undefined, agentsMd: string): string {
  const body =
    def?.body ??
    "你是一个被委派了独立任务的子代理。你看不到主对话的历史，只有下面这段任务描述。\n" +
      "规矩：先把任务读清；需要的信息自己用工具查；最后用一段话给出结论。";
  return agentsMd === "" ? body : `${body}\n\n${agentsMd}`;
}

/** 从 lane 名解析定义名（`sub:<agent>:<shortId>`）——重启后注册表是空的，只能靠名字 */
export function agentNameFromLane(laneName: string): string | null {
  if (!isSubagentLane(laneName)) return null;
  const rest = laneName.slice(SUBAGENT_LANE_PREFIX.length);
  const at = rest.lastIndexOf(":");
  return at <= 0 ? (rest === "" ? null : rest) : rest.slice(0, at);
}

/** 一条子代理运行过的「收据」——诚实口径：进程状态 ≠ 任务完成 */
interface RunReceipt {
  conclusion: string;
  steps: number;
  toolCounts: { name: string; count: number }[];
  changedFiles: Set<string>;
}

export function collectReceipt(transcript: readonly unknown[]): RunReceipt {
  const toolCounts = new Map<string, number>();
  const changedFiles = new Set<string>();
  let steps = 0;
  let conclusion = "";
  for (const entry of transcript) {
    const record = entry as { type?: string; message?: { role?: string; content?: unknown } };
    if (record.type !== "message" || record.message === undefined) continue;
    steps += 1;
    const role = record.message.role;
    if (role === "assistant") {
      const text = textOf(record.message.content);
      if (text !== "") conclusion = text;
      for (const call of toolCallsOf(record.message.content)) {
        toolCounts.set(call.name, (toolCounts.get(call.name) ?? 0) + 1);
        if ((call.name === "edit" || call.name === "write") && call.path !== null) {
          changedFiles.add(call.path);
        }
      }
    }
  }
  return {
    conclusion,
    steps,
    toolCounts: [...toolCounts.entries()].map(([name, count]) => ({ name, count })),
    changedFiles,
  };
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content
    .filter((block): block is { type: "text"; text: string } => {
      return (
        typeof block === "object" && block !== null && (block as { type?: string }).type === "text"
      );
    })
    .map((block) => block.text)
    .join("")
    .trim();
}

function toolCallsOf(content: unknown): { name: string; path: string | null }[] {
  if (!Array.isArray(content)) return [];
  const out: { name: string; path: string | null }[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const record = block as { type?: string; name?: unknown; arguments?: unknown };
    if (record.type !== "toolCall" || typeof record.name !== "string") continue;
    const args = record.arguments as { path?: unknown } | undefined;
    out.push({
      name: record.name,
      path: typeof args?.path === "string" ? args.path : null,
    });
  }
  return out;
}

/** 诚实的结果文本：结论 + 过程收据（用了什么、改了什么、是不是没跑完） */
export function buildResultText(
  input: { name: string; status: ViewSubagent["status"]; error?: string; timedOut: boolean },
  receipt: RunReceipt,
): string {
  const head: string[] = [];
  const tools =
    receipt.toolCounts.length === 0
      ? "没有用到工具"
      : `用了 ${receipt.toolCounts.map((item) => `${item.name}×${item.count}`).join("、")}`;
  const files =
    receipt.changedFiles.size === 0
      ? "没有改动文件"
      : `改动了 ${receipt.changedFiles.size} 个文件：${[...receipt.changedFiles].join("、")}`;
  if (input.status === "completed") {
    head.push(`子代理「${input.name}」已完成（${receipt.steps} 步，${tools}，${files}）。`);
  } else if (input.status === "aborted") {
    head.push(
      `子代理「${input.name}」被中止（${input.timedOut ? "超过时间上限" : "用户或上游中断"}），` +
        `结果**不完整**（${receipt.steps} 步，${tools}）。别把它当成「做完了」。`,
    );
  } else {
    head.push(
      `子代理「${input.name}」失败：${input.error ?? "原因未知"}（${receipt.steps} 步，${tools}）。`,
    );
  }
  if (receipt.conclusion === "") {
    head.push("它没有留下结论文本——需要结论的话请再委派一次，并在 task 里明确要求给出结论。");
  } else {
    head.push("", "它给出的结论：", receipt.conclusion);
  }
  return head.join("\n");
}

/**
 * 子代理编排 + 总账。
 *
 * 做成一个类（而不是散在 entry.ts 的几个闭包）有两个理由：① `entry.ts` 是**有体量闸的
 * 大户**，新逻辑必须压进新文件；② 「跑着哪些子代理 / 谁占着并发额度 / 视图怎么投」是
 * **一整块状态**，摊在 entry 里迟早出现「状态改了但视图没推」这类静默。
 */
export class Subagents {
  readonly #deps: SubagentDeps;
  readonly #runs = new Map<string, SubagentRun>();
  /** 已预约但还没注册进 `#runs` 的额度（见 `#reserve`：检查与占位之间不能有 await） */
  #pending = 0;
  #closed = false;

  constructor(deps: SubagentDeps) {
    this.#deps = deps;
  }

  /** 当前注册在案的子代理 → 视图总账（运行中的在前，保持开始顺序） */
  toView(): ViewSubagent[] {
    return [...this.#runs.values()].map((run) => projectSubagent(this.#projectionOf(run)));
  }

  /** 某个 lane 对应的定义（`transform_context` 用；重启后注册表为空，靠 lane 名解析） */
  definitionForLane(laneName: string): AgentDef | undefined {
    const known = this.#runs.get(laneName);
    const name = known?.name ?? agentNameFromLane(laneName);
    if (name === null) return undefined;
    return this.#deps.defs.find((def) => def.name === name);
  }

  /** 某个子代理的完整流快照（`session.subagentTranscript` 用；没有则回 undefined） */
  snapshotOf(id: string): LaneSnapshot | undefined {
    return this.#runs.get(id)?.snapshot;
  }

  /** 中止一个子代理（用户点「中止」/ 主会话被中断时走这里） */
  async abort(id: string, context: Context): Promise<void> {
    const lane = await this.#laneOf(id, context);
    if (lane === null) return;
    await lane.abort(context).catch(() => undefined);
  }

  /** 主会话中断 → 所有在跑的子代理一起收掉（否则子代理会继续烧钱到自然结束） */
  async abortAll(context: Context): Promise<void> {
    for (const run of this.#runs.values()) {
      if (run.status !== "running") continue;
      const lane = await this.#laneOf(run.id, context);
      if (lane === null) continue;
      await lane.abort(context).catch(() => undefined);
    }
  }

  /** 会话关闭：退订所有 watch，避免事件继续往已作废的快照上写 */
  dispose(): void {
    this.#closed = true;
    for (const run of this.#runs.values()) run.unsubscribe();
    this.#runs.clear();
  }

  /**
   * 拉一个**已存在** lane 的完整流（注册表里没有时，比如 worker 重启后）：
   * 用 `harness.lanes()` 先确认它真的存在——`harness.lane(name)` 对不存在的 lane
   * 会**新建**它，那就凭空在会话里多出一个空分支。
   */
  async reviveSnapshot(id: string, context: Context): Promise<LaneSnapshot | undefined> {
    // 与 `#laneOf` 同一道边界：只有子代理 lane 才许从会话里复活快照，
    // 否则传 "main" 会顺着 `harness.lane` 拿到主对话的完整流。
    if (!isSubagentLane(id)) return undefined;
    const harness = this.#deps.harness();
    if (harness === undefined) return undefined;
    const lanes = await harness.lanes(context);
    if (!lanes.some((lane) => lane.name === id)) return undefined;
    const lane = await harness.lane(id, context);
    const watch = await lane.watch(context);
    try {
      return await watch.resnapshot(context);
    } finally {
      watch.unsubscribe();
    }
  }

  tools(): AgentHarnessTool<ExecutionToolContext, typeof subagentSchema, undefined>[] {
    return [this.#makeTool()];
  }

  #makeTool(): AgentHarnessTool<ExecutionToolContext, typeof subagentSchema, undefined> {
    return {
      name: SUBAGENT_TOOL_NAME,
      label: "Subagent",
      description:
        "把一件**能整包交出去**的事委派给一个子代理去做：它跑在独立上下文中，" +
        "只有你写的 task（看不到我们的对话），做完把结论回给你。适合：大范围搜读定位、" +
        "独立的小改造、可以并行拆开的多份调研。不适合：一两步就能做完的事（自己做更快）、" +
        "需要边做边和用户确认的事（子代理看不见用户）。" +
        `规矩：① agent 用系统提示词里 <available_subagents> 列出的名字；` +
        `② task **必须自包含**——背景（相关路径 / 已知事实）、目标、交付物、约束，` +
        `写不清它必然空转且同样计费；③ 子代理不能再开子代理（只允许一层）；` +
        `④ 它内部的写 / 执行照样过审批闸门，所以你不用替它担心越权。` +
        "返回的是它的结论 + 过程收据（用了哪些工具、改了哪些文件、是否被中止）——" +
        "收据说「被中止 / 失败」时不要当成做完了。",
      parameters: subagentSchema,
      execute: async (toolCallId, params, _onUpdate, _toolContext, invocation, context) => {
        const text = await this.#run(toolCallId, params, invocation.operationId, context);
        return { content: [{ type: "text" as const, text }], details: undefined };
      },
    };
  }

  #laneOf(id: string, context: Context): Promise<AgentLane | null> {
    // 名字必须真的是子代理 lane。本方法只按「lane 存在」查，不加这道判据的话，
    // 传 "main" / TIDY_LANE 就能借中止通道动主对话——契约明写「不动主对话、不动别的
    // 子代理」，边界要在这里强制，而不是指望调用方永远传对。
    if (!isSubagentLane(id)) return Promise.resolve(null);
    const harness = this.#deps.harness();
    if (harness === undefined) return Promise.resolve(null);
    return harness.lanes(context).then((lanes) => {
      if (!lanes.some((lane) => lane.name === id)) return null;
      return harness.lane(id, context);
    });
  }

  #projectionOf(run: SubagentRun): SubagentProjectionInput {
    return {
      id: run.id,
      toolCallId: run.toolCallId,
      name: run.name,
      title: run.title,
      status: run.status,
      startedAt: run.startedAt,
      ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
      ...(run.error === undefined ? {} : { error: run.error }),
      snapshot: run.snapshot,
      stats: run.stats,
      // 与完整流（`projectTranscript(..., toolDurations)`）同源，否则预览里没有单步耗时
      durations: toolDurations,
    };
  }

  #runningCount(): number {
    let count = 0;
    for (const run of this.#runs.values()) if (run.status === "running") count += 1;
    return count;
  }

  /**
   * 预约一个并发额度（**同步**）。检查与占位必须在同一步里做完——`#run` 在两处之间
   * **不能有 await**，否则一轮里并发发出的多个 `subagent` 调用会一起通过检查
   * （check-then-act），上限形同虚设，而它其实是**费用闸**。
   */
  #reserve(): void {
    if (this.#runningCount() + this.#pending >= MAX_CONCURRENT_SUBAGENTS) {
      throw new Error(
        `同时进行的子代理最多 ${MAX_CONCURRENT_SUBAGENTS} 个，请等其中一个结束后再委派。`,
      );
    }
    this.#pending += 1;
  }

  /** 注册表只留最近 `MAX_FINISHED_SUBAGENTS` 个已结束的（运行中的永不淘汰） */
  #evictFinished(): void {
    const finished = [...this.#runs.values()].filter((run) => run.status !== "running");
    const excess = finished.length - MAX_FINISHED_SUBAGENTS;
    for (let index = 0; index < excess; index += 1) {
      const victim = finished[index];
      if (victim === undefined) break;
      victim.unsubscribe();
      this.#runs.delete(victim.id);
    }
  }

  /**
   * 建 lane、装白名单、注册进总账——`#run` 里**受并发占位保护的那一段**。
   *
   * 单独成方法是为了把「占着额度」的窗口压到最短：真正的运行（`lane.prompt`，可能十分钟）
   * 在窗口之外，否则跑满三个子代理之后额度会被整段运行期占死，第四个永远等不到位置。
   */
  async #spawn(
    toolCallId: string,
    params: SubagentParams,
    def: AgentDef,
    agentName: string,
    task: string,
    context: Context,
  ): Promise<{ run: SubagentRun; lane: AgentLane }> {
    const harness = this.#deps.harness();
    if (harness === undefined) throw new Error("会话尚未初始化，无法委派子代理。");

    // 工具面：硬白名单。名字不存在**不静默丢**——静默丢会让子代理「看着能读、其实没有工具」，
    // 而定义里那行 tools 是作者写下的意图，丢了必须报出来。
    const available = new Set((await harness.getTools(context)).map((tool) => tool.name));
    const wanted =
      def.tools === null ? [...available].filter((name) => name !== SUBAGENT_TOOL_NAME) : def.tools;
    const missing = wanted.filter((name) => !available.has(name));
    if (missing.length > 0) {
      throw new Error(
        `子代理「${agentName}」定义里要用的工具在本会话不可用：${missing.join("、")}。` +
          `可用的是：${[...available].join("、")}。请改定义或换一个子代理。`,
      );
    }
    const allowed = wanted.filter((name) => name !== SUBAGENT_TOOL_NAME);
    if (allowed.length === 0) {
      throw new Error(`子代理「${agentName}」没有任何可用工具（定义里的 tools 全是不可用的）。`);
    }

    const id = `${SUBAGENT_LANE_PREFIX}${def.name}:${randomUUID().slice(0, 8)}`;
    const lane = await harness.lane(id, { createAt: null }, context);
    const current = await lane.getActiveTools(context);
    if (current.join("\u0000") !== allowed.join("\u0000")) {
      await lane.setActiveTools(allowed, context);
    }
    const watch = await lane.watch(context);
    const run: SubagentRun = {
      id,
      toolCallId,
      name: def.name,
      title: truncateTitle((params.title ?? "").trim() || deriveTitle(task, def.name)),
      status: "running",
      startedAt: Date.now(),
      snapshot: watch.snapshot,
      stats: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      unsubscribe: () => watch.unsubscribe(),
    };
    this.#runs.set(id, run);
    watch.start((event) => {
      if (this.#closed || !this.#runs.has(id)) return;
      reduceLaneSnapshot(run.snapshot, event);
      // 归属统计只认**这条 lane 自己的** usage（usage 事件不按 lane 过滤，所有 watcher 都会收到）
      if (event.type === "usage" && event.lane === id && !event.row.adjustment) {
        run.stats.inputTokens += event.row.usage.input;
        run.stats.outputTokens += event.row.usage.output;
        run.stats.costUsd += event.row.usage.cost.total;
      }
      this.#deps.onUpdate();
    });
    this.#deps.onUpdate();
    return { run, lane };
  }

  async #run(
    toolCallId: string,
    params: SubagentParams,
    operationId: string,
    context: Context,
  ): Promise<string> {
    if (this.#closed) throw new Error("会话已关闭，无法委派子代理。");

    const names = this.#deps.defs.map((def) => def.name).join("、");
    const agentName = params.agent.trim();
    const task = params.task.trim();
    if (agentName === "") throw new Error(`subagent 缺 agent：填一个子代理名字（可用：${names || "无"}）。`);
    if (task === "") {
      throw new Error(
        "subagent 缺 task：子代理看不到我们的对话，task 必须自包含" +
          "（背景、目标、交付物、约束），否则它必然空转。",
      );
    }
    const def = this.#deps.defs.find((item) => item.name === agentName);
    if (def === undefined) {
      throw new Error(
        `没有名为「${agentName}」的子代理定义。可用的是：${names || "（一个都没有）"}。` +
          `要新增：在 .agents/agents/ 下放 <名字>.md（带 description 与 tools 两行 frontmatter）。`,
      );
    }

    // depth 守卫：调用方必须主 lane。判据落在**运行中的那个 lane**（按 operationId 认），
    // 而不是「猜」——工具入参里没有 lane 信息。
    const calling = await this.#callingLane(operationId, context);
    if (calling !== null && calling !== this.#deps.mainLane) {
      throw new Error("子代理不能再委派子代理（只允许一层）：请自己完成这件事。");
    }
    // 并发上限：检查与占位由 `#reserve` 同步完成，中间不能有 await（见 `#reserve`）。
    this.#reserve();
    let spawned: { run: SubagentRun; lane: AgentLane };
    try {
      spawned = await this.#spawn(toolCallId, params, def, agentName, task, context);
    } finally {
      // 注册进 `#runs` 的 run 本身就是额度的一分子，占位到此结束；
      // 中途抛错（工具不可用 / 定义写错）也照样释放，不能永久吃掉一个位置。
      this.#pending -= 1;
    }
    const { run, lane } = spawned;

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void lane.abort(context).catch(() => undefined);
    }, MAX_SUBAGENT_MS);
    timer.unref?.();

    try {
      const result = await lane.prompt(task, undefined, context);
      // 失败有**两条**路径，缺一不可查（compact / memoryTidy 已经踩过两次）：
      // ① accept 阶段被拒 → Result.err；② Result.ok 但 record.status 为 failed / aborted。
      if (!result.ok) {
        run.status = "failed";
        run.error = describeSubagentError(result.error);
      } else if (result.value.status === "suspended") {
        // 内核把 run 挂起（deferred）时它在后台继续：等它落地再结算，别把「还在跑」报成完成
        await lane.waitForIdle(context).catch(() => undefined);
        const settled = await lane.getResult(result.value.operationId, context).catch(() => undefined);
        applyOutcome(run, settled, timedOut);
      } else {
        applyOutcome(run, result.value, timedOut);
      }
    } catch (error) {
      run.status = "failed";
      run.error = describeSubagentError(error);
    } finally {
      clearTimeout(timer);
    }

    run.endedAt = Date.now();
    run.unsubscribe();
    this.#evictFinished();
    this.#deps.onUpdate();
    return buildResultText(
      { name: run.name, status: run.status, ...(run.error === undefined ? {} : { error: run.error }), timedOut },
      collectReceipt(run.snapshot.transcript),
    );
  }

  async #callingLane(operationId: string, context: Context): Promise<string | null> {
    const harness = this.#deps.harness();
    if (harness === undefined) return null;
    const lanes = await harness.lanes(context);
    const owner = lanes.find((lane) => lane.operation?.id === operationId);
    return owner?.name ?? null;
  }
}

/** 把内核的运行终态映射到 `ViewSubagent.status`（四种状态都要说得清） */
function applyOutcome(
  run: SubagentRun,
  record: { status: string; error?: { message?: string } } | undefined,
  timedOut: boolean,
): void {
  const status = record?.status;
  if (status === "completed") {
    run.status = "completed";
    return;
  }
  if (status === "aborted" || timedOut) {
    run.status = "aborted";
    return;
  }
  if (status === "declined") {
    // 运行没有被授权执行：与中止同类（都没跑完），但如实说明原因
    run.status = "aborted";
    run.error = "这次运行未被授权执行。";
    return;
  }
  run.status = "failed";
  run.error = record?.error?.message ?? "运行失败，原因未知。";
}
