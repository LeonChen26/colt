// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * durable 内核下的 `subagent` 工具。
 *
 * 与旧内核（`../lib/subagent.ts` 的多 lane 编排）**语义对齐、实现换底座**：
 *  - 旧：`harness.lane("sub:...", { createAt: null })`，一个会话内多条 lane；
 *  - 新：`tx.createConversation({ ownership: { kind: "task", taskId } })`，一个会话一个
 *    子对话，由这次工具调用（`pi.tool` 任务）**拥有**。
 *
 * 为什么用「任务拥有的会话」而不是另建一条对话再手工管生命周期：durable 的 ownership
 * 已经把三件事绑好了——中止调用会中止子对话、调用失败也一样、父任务空闲前子任务必须先空闲，
 * 而 `{ background: true }` 的中止还能连后台一起收。手工管会漏掉其中至少一条。
 *
 * 崩溃恢复是本实现真正吃到的新能力：`replay: "safe"` + 固定 `requestId` +
 * `scanConversations({ ownerTaskId })`，重启后重跑这个工具会**找回同一个子对话与同一次提交**，
 * 而不是再开一个、再花一遍钱。
 *
 * 语义与旧实现一致的部分（不要在这里另立一套）：
 *  - 硬工具白名单（`def.tools`），`subagent` 自己永远被剔除（禁止递归）；
 *  - 并发上限 = `MAX_CONCURRENT_SUBAGENTS`，检查与占位同步完成（它是费用闸）；
 *  - 到墙钟上限先要「总结交接」，窗口过了才中止（时序在 `subagent-handoff.ts`）；
 *  - 返回「结论 + 过程收据」，中止 / 失败不许报成完成；
 *  - 视图只有有界尾部，完整流按需拉。
 */
import {
  configure,
  defineTool,
  type AgentChange,
  type Conversation,
  type ConversationId,
  type ConversationView as DurableConversationView,
  type ConversationWatch,
  type Harness,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { AssistantMessage } from "@earendil-works/pi-ai";

import type { ViewSubagent } from "@shared/worker-protocol";
import { splitModelRef } from "@shared/model-ref";
import { promptTokensOf } from "@shared/token-usage";

import type { AgentDef } from "../lib/agent-defs";
import {
  MAX_CONCURRENT_SUBAGENTS,
  MAX_FINISHED_SUBAGENTS,
  SUBAGENT_TOOL_NAME,
  buildResultText,
  collectReceipt,
  deriveTitle,
  describeSubagentError,
  subagentSchema,
  subagentSystemPrompt,
  truncateTitle,
  type SubagentParams,
} from "../lib/subagent";
import { MAX_SUBAGENT_STEPS_IN_VIEW } from "../lib/subagent-view";
import { createHandoffTimer, handoffInstruction, type HandoffLimits } from "../lib/subagent-handoff";
import { projectTranscript } from "../lib/project";
import { durableTranscript, livePartialText, liveRunningTools, sumUsage } from "./project";

/** `ViewSubagent.id` 的前缀：`sub:<定义名>:<会话 id>`（会话 id 是 durable 的稳定持久身份） */
const RUN_ID_PREFIX = "sub:";

/** 从视图 id 反解子对话 id——重启后内存注册表是空的，只能靠名字找回来 */
export function conversationIdOfRunId(id: string): ConversationId | undefined {
  if (!id.startsWith(RUN_ID_PREFIX)) return undefined;
  const rest = id.slice(RUN_ID_PREFIX.length);
  const at = rest.lastIndexOf(":");
  if (at <= 0) return undefined;
  const parsed = Number.parseInt(rest.slice(at + 1), 10);
  return Number.isFinite(parsed) ? (parsed as ConversationId) : undefined;
}

function runIdOf(name: string, conversationId: ConversationId): string {
  return `${RUN_ID_PREFIX}${name}:${String(conversationId)}`;
}

export interface DurableSubagentDeps {
  defs: readonly AgentDef[];
  /** 子代理的工作目录（与主会话一致） */
  cwd: string;
  /** 子代理提示词里拼的 AGENTS.md 块（与旧内核同一来源） */
  agentsMd: () => Promise<string>;
  /** 主对话 id——depth 守卫与「分流临时提醒 / 提示词注入」的判据 */
  mainConversationId: () => ConversationId | undefined;
  harness: () => Harness | undefined;
  ensureModel: (providerId: string, modelId: string) => Promise<void>;
  onUpdate: () => void;
  /** 收尾时序的可覆盖值（单测 / 冒烟压时序用） */
  handoff?: HandoffLimits;
}

interface Run {
  id: string;
  conversationId: ConversationId;
  toolCallId: string;
  name: string;
  title: string;
  status: ViewSubagent["status"];
  startedAt: number;
  endedAt?: number;
  error?: string;
  handedOff?: boolean;
  latest: DurableConversationView | undefined;
  watch: ConversationWatch | undefined;
  /** 结束时的冻结投影：流式期间每 50ms 整份重推，重投影已完成 run 是纯浪费 */
  frozen: ViewSubagent | undefined;
}

const DESCRIPTION =
  "把一件**能整包交出去**的事委派给一个子代理去做：它跑在独立上下文中，" +
  "只有你写的 task（看不到我们的对话），做完把结论回给你。适合：大范围搜读定位、" +
  "独立的小改造、可以并行拆开的多份调研。不适合：一两步就能做完的事（自己做更快）、" +
  "需要边做边和用户确认的事（子代理看不见用户）。" +
  `规矩：① agent 用系统提示词里 <available_subagents> 列出的名字；` +
  `② task **必须自包含**——背景（相关路径 / 已知事实）、目标、交付物、约束，` +
  `写不清它必然空转且同样计费；③ 子代理不能再开子代理（只允许一层）；` +
  `④ 它内部的写 / 执行照样过审批闸门，所以你不用替它担心越权。` +
  "返回的是它的结论 + 过程收据（用了哪些工具、改了哪些文件、是否被中止）——" +
  "收据说「被中止 / 失败」时不要当成做完了。";

export class DurableSubagents {
  readonly #deps: DurableSubagentDeps;
  readonly #runs = new Map<string, Run>();
  /** 已预约但还没注册进 `#runs` 的额度（检查与占位之间不能有 await） */
  #pending = 0;
  #closed = false;
  readonly #tool: ToolRegistration;

  constructor(deps: DurableSubagentDeps) {
    this.#deps = deps;
    this.#tool = defineTool({
      name: SUBAGENT_TOOL_NAME,
      description: DESCRIPTION,
      parameters: subagentSchema,
      // 崩溃后重跑：靠 ownerTaskId 找回同一个子对话、靠固定 requestId 找回同一次提交
      replay: "safe",
      execute: async (params, api, context) => {
        const text = await this.#run(params, api, context);
        return {
          output: [{ type: "text" as const, text }],
          details: { conversationId: String(api.conversationId) },
        };
      },
    });
  }

  /** 注册进「colt」扩展的那个工具 */
  tool(): ToolRegistration {
    return this.#tool;
  }

  /** 主对话当前的子代理总账（有界尾部的冻结投影） */
  toView(): ViewSubagent[] {
    return [...this.#runs.values()].map((run) => this.#viewOf(run));
  }

  /** 审批卡上标注「来自 <子代理名>」用 */
  refFor(conversationId: ConversationId): { id: string; name: string } | undefined {
    for (const run of this.#runs.values()) {
      if (run.conversationId === conversationId) return { id: run.id, name: run.name };
    }
    return undefined;
  }

  /** 中止一个子代理（界面上的「中止」） */
  async abort(id: string, context: Context): Promise<void> {
    const conversationId = this.#runs.get(id)?.conversationId ?? conversationIdOfRunId(id);
    if (conversationId === undefined) return;
    const conversation = await this.#conversation(conversationId, context);
    if (conversation === undefined) return;
    await conversation.abort(context).catch(() => undefined);
  }

  /** 主会话中断 → 在跑的子代理一并收掉（否则它们继续烧钱到自然结束） */
  async abortAll(context: Context): Promise<void> {
    for (const run of this.#runs.values()) {
      if (run.status !== "running") continue;
      const conversation = await this.#conversation(run.conversationId, context);
      if (conversation === undefined) continue;
      await conversation.abort(context).catch(() => undefined);
    }
  }

  /** 按需拉一个子代理的完整流；名字不存在时回 `undefined`（界面按「没有内容」呈现） */
  async transcript(id: string, context: Context): Promise<unknown[] | undefined> {
    const conversationId = this.#runs.get(id)?.conversationId ?? conversationIdOfRunId(id);
    if (conversationId === undefined) return undefined;
    const conversation = await this.#conversation(conversationId, context);
    if (conversation === undefined) return undefined;
    const view = await conversation.context(context);
    return durableTranscript(view.entries);
  }

  /** 会话关闭：停掉所有 watch，避免事件继续往已作废的视图上写 */
  dispose(): void {
    this.#closed = true;
    for (const run of this.#runs.values()) {
      void run.watch?.stop().catch(() => undefined);
    }
    this.#runs.clear();
  }

  #conversation(id: ConversationId, context: Context): Promise<Conversation | undefined> {
    return (this.#deps.harness()?.conversation(id, context) ?? Promise.resolve(undefined)) as Promise<
      Conversation | undefined
    >;
  }

  #viewOf(run: Run): ViewSubagent {
    if (run.status !== "running" && run.frozen !== undefined) return run.frozen;
    const view = this.#project(run);
    if (run.status !== "running") run.frozen = view;
    return view;
  }

  #project(run: Run): ViewSubagent {
    const latest = run.latest;
    const transcript = latest === undefined ? [] : durableTranscript(latest.entries);
    const { messages } = projectTranscript(transcript, new Map<string, number>());
    const live = latest?.docs["pi.live"] as never;
    const streaming = livePartialText(live);
    const usage = sumUsage(latest?.docs["pi.usage"] as never);
    return {
      id: run.id,
      toolCallId: run.toolCallId,
      name: run.name,
      title: run.title,
      status: run.status,
      startedAt: run.startedAt,
      ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
      ...(run.error === undefined ? {} : { error: run.error }),
      ...(run.handedOff === undefined ? {} : { handedOff: run.handedOff }),
      tail: {
        streamingText: streaming.text,
        thought: streaming.thought,
        runningTools: latest === undefined ? [] : liveRunningTools(live, latest.entries),
        recentSteps: messages.slice(-MAX_SUBAGENT_STEPS_IN_VIEW),
        stepCount: messages.length,
      },
      stats: {
        promptTokens: promptTokensOf(usage),
        outputTokens: usage.output,
        costUsd: usage.cost.total,
      },
    };
  }

  #runningCount(): number {
    let count = 0;
    for (const run of this.#runs.values()) if (run.status === "running") count += 1;
    return count;
  }

  /**
   * 预约并发额度（同步）。检查与占位必须在同一步里做完——中间有 await 时，
   * 一轮里并发发出的多个 `subagent` 会一起通过检查（check-then-act），上限形同虚设。
   */
  #reserve(): void {
    if (this.#runningCount() + this.#pending >= MAX_CONCURRENT_SUBAGENTS) {
      throw new Error(
        `同时进行的子代理最多 ${MAX_CONCURRENT_SUBAGENTS} 个，请等其中一个结束后再委派。`,
      );
    }
    this.#pending += 1;
  }

  /** 只留最近 `MAX_FINISHED_SUBAGENTS` 个已结束的（运行中的永不淘汰） */
  #evictFinished(): void {
    const finished = [...this.#runs.values()].filter((run) => run.status !== "running");
    const excess = finished.length - MAX_FINISHED_SUBAGENTS;
    for (let index = 0; index < excess; index += 1) {
      const victim = finished[index];
      if (victim === undefined) break;
      this.#runs.delete(victim.id);
    }
  }

  /** 工具面：硬白名单。名字不存在**不静默丢**——丢了就是「看着能读、其实没有工具」 */
  #allowedTools(
    def: AgentDef,
    agentName: string,
    registryTools: readonly ToolRegistration[],
  ): ToolRegistration[] {
    const byName = new Map<string, ToolRegistration>();
    for (const tool of registryTools) byName.set(tool.name, tool);
    const available = [...byName.keys()];
    const wanted =
      def.tools === null ? available.filter((name) => name !== SUBAGENT_TOOL_NAME) : def.tools;
    const missing = wanted.filter((name) => !byName.has(name));
    if (missing.length > 0) {
      throw new Error(
        `子代理「${agentName}」定义里要用的工具在本会话不可用：${missing.join("、")}。` +
          `可用的是：${available.join("、")}。请改定义或换一个子代理。`,
      );
    }
    const allowed = wanted
      .filter((name) => name !== SUBAGENT_TOOL_NAME)
      .map((name) => byName.get(name))
      .filter((tool): tool is ToolRegistration => tool !== undefined);
    if (allowed.length === 0) {
      throw new Error(`子代理「${agentName}」没有任何可用工具（定义里的 tools 全是不可用的）。`);
    }
    return allowed;
  }

  async #run(params: SubagentParams, api: ToolExecutionApi, context: Context): Promise<string> {
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

    // depth 守卫：只允许主对话发起。子对话的工具白名单里已经没有 subagent，
    // 这里是第二层——两层都留着，因为白名单是「模型看不到」，而不是「调不到」。
    const main = this.#deps.mainConversationId();
    if (main === undefined || api.conversationId !== main) {
      throw new Error("子代理不能再委派子代理（只允许一层）：请自己完成这件事。");
    }

    // 模型路由：确保目标 provider 能装配、模型真的在表里——失败**不回落会话模型**
    const modelRef = def.model === null ? null : splitModelRef(def.model);
    if (modelRef !== null) await this.#deps.ensureModel(modelRef.provider, modelRef.model);

    // 并发上限（同步检查 + 占位，见 `#reserve`）
    this.#reserve();
    let run: Run;
    try {
      run = await this.#spawn(api, def, agentName, task, params, modelRef, context);
    } finally {
      this.#pending -= 1;
    }

    const handle = await api.conversation(run.conversationId, context);
    if (handle === undefined) {
      run.status = "failed";
      run.error = "子对话未能打开。";
      return this.#finish(run, false, false);
    }

    /** 中止后仍不返回时的「停止等待」信号（见 `GRACE_AFTER_ABORT_MS`） */
    let giveUp: (() => void) | undefined;
    const grace = new Promise<"give-up">((resolve) => {
      giveUp = () => resolve("give-up");
    });
    const handoff = createHandoffTimer(
      {
        onHandoff: () => {
          run.handedOff = true;
          this.#deps.onUpdate();
          void handle
            .submit(
              { type: "input", content: handoffInstruction(), whenBusy: "steer" },
              context,
            )
            .catch(() => undefined);
        },
        onAbort: () => {
          void handle.abort(context).catch(() => undefined);
        },
        onGiveUp: () => giveUp?.(),
      },
      this.#deps.handoff ?? {},
      {
        setTimeout: (callback, ms) => {
          const timer = setTimeout(callback, ms);
          timer.unref?.();
          return timer;
        },
        clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
      },
    );

    try {
      // 固定 requestId：崩溃后重跑这个工具时找回**同一次**提交，而不是再发一遍
      const submission = await handle.submit(
        { type: "input", content: task, requestId: `subagent:${String(api.taskId)}` },
        context,
      );
      void submission.wait(context).catch(() => undefined);
      const settled = await Promise.race([submission.wait(context), grace]);
      if (settled === "give-up") {
        run.status = "aborted";
        run.error = "中止未生效（可能卡在不可中断的调用上），已停止等待";
      } else if (settled.status === "unanswered") {
        run.status = "aborted";
        run.error = "这次提交没有被回答（用户或上游中断）。";
      } else {
        this.#applyFinalStatus(run);
      }
    } catch (error) {
      run.status = "failed";
      run.error = describeSubagentError(error);
    } finally {
      handoff.cancel();
    }

    return this.#finish(run, handoff.timedOut(), handoff.handoffRequested());
  }

  /** 从子对话最后一条助手消息判断终态：模型报错时不能记成完成 */
  #applyFinalStatus(run: Run): void {
    const entries = run.latest?.entries ?? [];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry === undefined || entry.kind !== "assistant") continue;
      const message = entry.model?.[0] as AssistantMessage | undefined;
      if (message?.stopReason === "error") {
        run.status = "failed";
        run.error = message.errorMessage ?? "生成失败，原因未知。";
        return;
      }
      break;
    }
    run.status = "completed";
  }

  async #spawn(
    api: ToolExecutionApi,
    def: AgentDef,
    agentName: string,
    task: string,
    params: SubagentParams,
    modelRef: { provider: string; model: string } | null,
    context: Context,
  ): Promise<Run> {
    const registryTools = api.registry.tools().map((entry) => entry.tool);
    const allowed = this.#allowedTools(def, agentName, registryTools);
    const instructions = subagentSystemPrompt(def, await this.#deps.agentsMd());

    // 建子对话与配置在**同一个提交**里：要么都有一个可用的子对话，要么什么都没有。
    // 重跑（崩溃恢复）时先按 ownerTaskId 找回来——找不到才新建。
    const conversationId = await api.commit(async (tx) => {
      const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
      if (existing !== undefined) return existing.id;
      const created = await tx.createConversation({
        ownership: { kind: "task", taskId: api.taskId },
      });
      const change: AgentChange = {
        instructions,
        cwd: this.#deps.cwd,
        tools: allowed,
        ...(modelRef === null
          ? {}
          : { model: { provider: modelRef.provider, modelId: modelRef.model } }),
      };
      await configure(tx, created.id, change);
      return created.id;
    }, context);

    const title = truncateTitle((params.title ?? "").trim() || deriveTitle(task, def.name));
    const run: Run = {
      id: runIdOf(def.name, conversationId),
      conversationId,
      toolCallId: api.callId,
      name: def.name,
      title,
      status: "running",
      startedAt: Date.now(),
      latest: undefined,
      watch: undefined,
      frozen: undefined,
    };
    this.#runs.set(run.id, run);

    const conversation = await this.#conversation(conversationId, context);
    if (conversation !== undefined) {
      const watch = await conversation.watch(context);
      run.watch = watch;
      run.latest = watch.value;
      watch.start(async (value) => {
        if (this.#closed) return;
        run.latest = value;
        this.#deps.onUpdate();
      });
    }
    // 让界面能把这次调用与子对话对上
    await api.details({ conversationId: String(conversationId), name: def.name, title }, context);
    this.#deps.onUpdate();
    return run;
  }

  async #finish(run: Run, timedOut: boolean, handedOff: boolean): Promise<string> {
    run.endedAt = Date.now();
    await run.watch?.stop().catch(() => undefined);
    run.watch = undefined;
    this.#evictFinished();
    this.#deps.onUpdate();
    const transcript = run.latest === undefined ? [] : durableTranscript(run.latest.entries);
    return buildResultText(
      {
        name: run.name,
        status: run.status,
        ...(run.error === undefined ? {} : { error: run.error }),
        timedOut,
        handedOff,
      },
      collectReceipt(transcript),
    );
  }
}
