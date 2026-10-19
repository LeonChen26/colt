// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * `subagent` 工具的**共享契约与纯函数**：工具 schema、标题、系统提示词、结果收据。
 *
 * 执行侧住在 `worker/durable/subagent.ts`：一个子代理 = 一次工具调用所拥有的**子对话**
 * （durable `Conversation`），独立 transcript、硬白名单、与主对话并行；中止调用会连带中止它。
 * 这里只留与内核无关的部分，供 durable 入口与单测共用。
 *
 * fork 语义 = **只有 `fresh`**：子代理**只有委托方写的那段 `task`**，刻意**不继承**主对话历史。
 * 理由不是「晚点做 fork」，而是 fork 与隔离的目的冲突——隐式整份复制会把主对话的噪声与
 * 错误假设一起搬过去；`fresh` 逼出来的是「显式、有损、由委托方决定什么重要」的交接。
 * 故连 `context` 参数都不暴露（模型没有机会选错）。
 *
 * 递归**禁止**（depth = 1）：白名单不含本工具 + 工具描述明写 + durable 侧还有一道守卫。
 * 递归 spawn 是最容易失控的一类（自我复制 + 费用失控）。
 *
 * 呈现见 `docs/archive/DESIGN-subagents.md` 决策三：④ 的活卡（含卡上的「中止」）+ 下钻，
 * **不新增页签、不自动展开右栏**。
 */
import { Type } from "typebox";
import type { Static } from "typebox";
import { READONLY_TOOLS } from "@shared/readonly-tools";
import type { ViewSubagent } from "@shared/worker-protocol";
import type { AgentDef } from "./agent-defs";
import { isQuestionTool } from "./ask-user-tool";

/** 工具名常量：注册名与闸门判据**必须同源**（改错会静默变成「委派也要弹卡」） */
export const SUBAGENT_TOOL_NAME = "subagent";

export function isSubagentTool(toolName: string): boolean {
  return toolName === SUBAGENT_TOOL_NAME;
}

/**
 * 并发上限：同时最多几路子代理。
 *
 * 上限的理由不是「内核扛不住」而是**费用与注意力**：模型在一轮里发多个 `subagent` 调用
 * 时内核并发执行，没有上限时一次「顺便都查一下」就能开出十几路真实计费请求。
 */
export const MAX_CONCURRENT_SUBAGENTS = 3;

// 墙钟上限 / 收笔窗口 / 中止后的宽限，三段都住在 `subagent-handoff.ts`——
// 那里与「到点**先要交接**、窗口过了才中止」的整条策略在一起，且时序可单测。

/**
 * 注册表里保留多少个**已结束**的子代理（④ 卡与下钻要能查到；再多就只保最近这些）。
 *
 * ⚠️ 它与「**每份 transcript 多大**」必须**一起重估**：这个上限管的是「留多少个 run」，
 * 而每个 run 的 `snapshot.transcript` 是**全量**保留的（有界只发生在投影出去的那截 tail 上）。
 * 目前两边都小；若子代理变成高频用法，先量这两个数再动其中任何一个——只调一个会得出错结论。
 */
export const MAX_FINISHED_SUBAGENTS = 20;

/** 标题上限——它进「任务摘要」那一行与 ④ 卡，太长会把行撑爆 */
export const MAX_TITLE_CHARS = 60;

export const subagentSchema = Type.Object({
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

export type SubagentParams = Static<typeof subagentSchema>;

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

/** 一条子代理运行过的「收据」——诚实口径：进程状态 ≠ 任务完成 */
interface RunReceipt {
  conclusion: string;
  steps: number;
  toolCounts: { name: string; count: number }[];
  /** **能确定**改了哪些文件：只有 `edit` / `write` 带 `path` */
  changedFiles: Set<string>;
  /**
   * 非只读、又推不出文件名的调用（`bash` / `computer` / MCP 工具…）。
   *
   * 为什么单列出来：这些工具**可能**写盘，但文件名无从得知。只认 `edit` / `write` 的话，
   * 子代理用 `bash` 改了一圈之后，回给模型的收据会写成「没有改动文件」——那是谎报，
   * 而模型正是靠这份收据判断「要不要再核一遍」（`docs/ERRORS.md` 的诚实口径）。
   */
  opaqueCalls: { name: string; count: number }[];
}

export function collectReceipt(transcript: readonly unknown[]): RunReceipt {
  const toolCounts = new Map<string, number>();
  const changedFiles = new Set<string>();
  const opaqueCalls = new Map<string, number>();
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
          continue;
        }
        // 只读工具（真源 `READONLY_TOOLS`）与「本来就不碰用户工作区」的两把（提问 / 委派）
        // 不入此列；其余一律算「可能写盘」——宁多报一次，不漏报成「什么都没动」。
        if (
          READONLY_TOOLS.has(call.name) ||
          isQuestionTool(call.name) ||
          call.name === SUBAGENT_TOOL_NAME
        ) {
          continue;
        }
        opaqueCalls.set(call.name, (opaqueCalls.get(call.name) ?? 0) + 1);
      }
    }
  }
  return {
    conclusion,
    steps,
    toolCounts: [...toolCounts.entries()].map(([name, count]) => ({ name, count })),
    changedFiles,
    opaqueCalls: [...opaqueCalls.entries()].map(([name, count]) => ({ name, count })),
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
  input: {
    name: string;
    status: ViewSubagent["status"];
    error?: string;
    timedOut: boolean;
    /** 走到上限后改由「总结交接」收尾（见 `subagent-handoff.ts`） */
    handedOff?: boolean;
  },
  receipt: RunReceipt,
): string {
  const head: string[] = [];
  const tools =
    receipt.toolCounts.length === 0
      ? "没有用到工具"
      : `用了 ${receipt.toolCounts.map((item) => `${item.name}×${item.count}`).join("、")}`;
  const files =
    receipt.changedFiles.size === 0
      ? "没有可确认的文件改动"
      : `改动了 ${receipt.changedFiles.size} 个文件：${[...receipt.changedFiles].join("、")}`;
  // 「可能写盘」那一串跟着 files 一起报：它既不等于「改了文件」，也不能被省掉
  const opaque =
    receipt.opaqueCalls.length === 0
      ? ""
      : `；另有 ${receipt.opaqueCalls.map((item) => `${item.name}×${item.count}`).join("、")}` +
        "，这类调用**可能也写了盘**，但改了哪个文件从记录里看不出来";
  if (input.status === "completed") {
    // 走到上限、由交接收尾的：**不能报成「已完成」**——那句「已完成」会让调用方
    // 把半途的交接当成任务做完了（本仓最贵的一类错误是「持续撒谎」，见 ERRORS.md）。
    if (input.handedOff === true) {
      head.push(
        `子代理「${input.name}」跑到**时间上限后收笔**（${receipt.steps} 步，${tools}，${files}${opaque}）：` +
          `下面的结论是它写下的**总结交接**，任务**不一定**做完——接手前先按交接里「没做完的部分」核一遍。`,
      );
    } else {
      head.push(`子代理「${input.name}」已完成（${receipt.steps} 步，${tools}，${files}${opaque}）。`);
    }
  } else if (input.status === "aborted") {
    const why = input.timedOut
      ? input.handedOff === true
        ? "超过时间上限、要了交接但没写完"
        : "超过时间上限"
      : "用户或上游中断";
    head.push(
      `子代理「${input.name}」被中止（${why}${input.error === undefined ? "" : `：${input.error}`}），` +
        `结果**不完整**（${receipt.steps} 步，${tools}${opaque}）。别把它当成「做完了」。`,
    );
  } else {
    head.push(
      `子代理「${input.name}」失败：${input.error ?? "原因未知"}` +
        `（${receipt.steps} 步，${tools}${opaque}）。`,
    );
  }
  if (receipt.conclusion === "") {
    head.push("它没有留下结论文本——需要结论的话请再委派一次，并在 task 里明确要求给出结论。");
  } else {
    head.push("", "它给出的结论：", receipt.conclusion);
  }
  return head.join("\n");
}

