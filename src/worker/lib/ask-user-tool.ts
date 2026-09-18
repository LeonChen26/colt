// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * `ask_user` 工具：模型在「需求不清」时先问再做，而不是硬猜。
 *
 * 与审批闸门**并列但独立**：两者都是「worker 阻塞、主进程回答」的同形往返，
 * 但语义相反——审批的默认值是放行（`auto` / `full-access` 会静默批准），
 * 提问的默认值是「没答案」。所以它没有走 `approvalRequest`，而是自己一条通道。
 *
 * 校验与文案都在本文件，且都是**纯函数**（`validateQuestionnaire` / `formatAnswers` /
 * 三条回落文案），便于单测覆盖——这条链路的失败模式是静默，能测的部分必须测到。
 */
import { Type } from "typebox";
import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core";
import type {
  AskUserQuestion,
  AskUserSkipReason,
  WorkerMessage,
} from "@shared/worker-protocol";

/** 上限与界面一屏能放下多少直接相关 */
export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_HEADER_CHARS = 12;

/**
 * 工具名常量：注册名与闸门判据**必须同源**——改名时编译器会一起提醒，
 * 而不是悄悄变成「闸门认不得了 → 提问被当待审工具弹卡」。
 */
export const ASK_USER_TOOL_NAME = "ask_user";

/** `ask_user` 不受审批策略管辖：它不是「有副作用的动作」，是「向人要信息」（见文件头） */
export function isQuestionTool(toolName: string): boolean {
  return toolName === ASK_USER_TOOL_NAME;
}

/** 一次提问的答复：要么有答案，要么是被跳过（超时 / 中断） */
export type AskUserAnswer =
  | { kind: "answered"; answers: Record<string, string> }
  | { kind: "skipped"; reason: AskUserSkipReason };

const optionSchema = Type.Object({
  label: Type.String({ description: "选项标题，1~5 个词，用户点它" }),
  description: Type.String({ description: "这个选项意味着什么，一句话" }),
});

const questionSchema = Type.Object({
  question: Type.String({ description: "问题正文" }),
  header: Type.Optional(
    Type.String({ description: `短标签（≤${MAX_HEADER_CHARS} 字符），多题时作分组标题` }),
  ),
  options: Type.Array(optionSchema, {
    description: `${MIN_OPTIONS}~${MAX_OPTIONS} 个选项`,
    minItems: MIN_OPTIONS,
    maxItems: MAX_OPTIONS,
  }),
  multiSelect: Type.Optional(Type.Boolean({ description: "可多选；默认单选" })),
});

const askUserSchema = Type.Object({
  questions: Type.Array(questionSchema, {
    description: `1~${MAX_QUESTIONS} 个问题，一屏全部展示`,
    minItems: 1,
    maxItems: MAX_QUESTIONS,
  }),
});

export type ValidateResult =
  | { ok: true; questions: AskUserQuestion[] }
  | { ok: false; message: string };

/**
 * 校验问卷。
 *
 * **为什么要自己校验、而不全交给 typebox**：模型常给出「结构对、语义不对」的输入
 * （空字符串的问题、重复的问题正文、重复 label、超长 header），这些 typebox 校验不出来，
 * 而它们到界面上就是「点不出东西的按钮」或「选了跟没选一样」。
 *
 * 失败文案必须说清**正确写法**——对齐 `@shared/skill-error` 的口径：
 * 让模型下一次能发对，比告诉它「参数错了」有用得多。
 */
export function validateQuestionnaire(input: unknown): ValidateResult {
  if (typeof input !== "object" || input === null) {
    return { ok: false, message: "ask_user 需要一个对象参数：{ questions: [...] }" };
  }
  const raw = (input as { questions?: unknown }).questions;
  if (!Array.isArray(raw)) {
    return { ok: false, message: "ask_user 需要 questions 数组：每项含 question 与 options" };
  }
  if (raw.length === 0) {
    return { ok: false, message: "questions 至少要有 1 个问题" };
  }
  if (raw.length > MAX_QUESTIONS) {
    return { ok: false, message: `一次最多问 ${MAX_QUESTIONS} 个问题，本次给了 ${raw.length} 个` };
  }

  const questions: AskUserQuestion[] = [];
  for (const [index, item] of raw.entries()) {
    if (typeof item !== "object" || item === null) {
      return { ok: false, message: `第 ${index + 1} 个问题不是对象` };
    }
    const q = item as {
      question?: unknown;
      header?: unknown;
      options?: unknown;
      multiSelect?: unknown;
    };
    if (typeof q.question !== "string" || q.question.trim() === "") {
      return { ok: false, message: `第 ${index + 1} 个问题缺 question（非空字符串）` };
    }
    if (q.header !== undefined) {
      if (typeof q.header !== "string") {
        return { ok: false, message: `第 ${index + 1} 个问题的 header 必须是字符串` };
      }
      if (q.header.length > MAX_HEADER_CHARS) {
        return {
          ok: false,
          message: `第 ${index + 1} 个问题的 header 超过 ${MAX_HEADER_CHARS} 字符（当前 ${q.header.length}）：${q.header}`,
        };
      }
    }
    if (!Array.isArray(q.options)) {
      return { ok: false, message: `第 ${index + 1} 个问题缺 options 数组` };
    }
    if (q.options.length < MIN_OPTIONS || q.options.length > MAX_OPTIONS) {
      return {
        ok: false,
        message: `第 ${index + 1} 个问题需要 ${MIN_OPTIONS}~${MAX_OPTIONS} 个选项，本次给了 ${q.options.length} 个`,
      };
    }
    const options: { label: string; description: string }[] = [];
    for (const [optIndex, opt] of q.options.entries()) {
      if (typeof opt !== "object" || opt === null) {
        return { ok: false, message: `第 ${index + 1} 个问题的第 ${optIndex + 1} 个选项不是对象` };
      }
      const o = opt as { label?: unknown; description?: unknown };
      if (typeof o.label !== "string" || o.label.trim() === "") {
        return {
          ok: false,
          message: `第 ${index + 1} 个问题的第 ${optIndex + 1} 个选项缺 label（非空字符串）`,
        };
      }
      options.push({
        label: o.label,
        description: typeof o.description === "string" ? o.description : "",
      });
    }
    // 重复 label 会让「用户选了 A」与「模型收到 A」对不上——选项靠 label 回传，必须唯一
    const labels = new Set(options.map((o) => o.label));
    if (labels.size !== options.length) {
      return { ok: false, message: `第 ${index + 1} 个问题的选项 label 有重复，答案会分不清` };
    }
    questions.push({
      question: q.question,
      ...(typeof q.header === "string" ? { header: q.header } : {}),
      options,
      ...(q.multiSelect === true ? { multiSelect: true } : {}),
    });
  }
  // 答案以**问题正文**为键（见 formatAnswers），两题正文相同时后一题会顶掉前一题：
  // 界面上看着都选了，回到模型那里只剩一条。与选项 label 唯一性同一类理由
  const asked = new Set(questions.map((item) => item.question));
  if (asked.size !== questions.length) {
    return { ok: false, message: "questions 里有重复的问题正文，答案会互相覆盖——每题正文必须唯一" };
  }
  return { ok: true, questions };
}

/** 把答案渲染给模型看：问题 + 用户选了什么，逐条对齐 */
export function formatAnswers(
  questions: AskUserQuestion[],
  answers: Record<string, string>,
): string {
  const lines = questions.map((q) => {
    const picked = answers[q.question];
    const value = picked === undefined || picked.trim() === "" ? "（未选择）" : picked;
    return `Q：${q.question}\nA：${value}`;
  });
  return `用户已回答：\n${lines.join("\n")}`;
}

/**
 * 没拿到答案时的回落文案。
 *
 * 三条都必须是「有信息」而不是「失败」：模型要能据此继续，
 * 而不是卡住或原样重试（重试 = 再弹一次卡，用户看到的是界面没反应）。
 * 三条也必须彼此分得清——把「用户点了跳过」说成「对话被中断」，模型会以为整个会话没了。
 */
export function skipMessage(reason: AskUserSkipReason): string {
  if (reason === "timeout") {
    return (
      "用户未在限定时间内回答这次提问。请按你认为最合理的方案继续，" +
      "并在开头明确说明你所做的假设，便于用户事后纠正。"
    );
  }
  if (reason === "skipped") {
    return (
      "用户跳过了这次提问，没有作答（对话仍在继续）。" +
      "请按你认为最合理的方案继续，并明确说明你所做的假设，便于用户事后纠正。"
    );
  }
  return "对话已被中断，这次提问没有作答。";
}

/** 工具需要的宿主：把提问发出去并阻塞等答案（由 entry.ts 提供，与审批同一套范式） */
export interface AskUserHost {
  ask(toolCallId: string, questions: AskUserQuestion[], timeoutMs: number): Promise<AskUserAnswer>;
}

export function createAskUserTools(host: AskUserHost): AgentHarnessTool<ExecutionToolContext>[] {
  const askUser: AgentHarnessTool<
    ExecutionToolContext,
    typeof askUserSchema,
    undefined
  > = {
    name: ASK_USER_TOOL_NAME,
    label: "Ask User",
    description:
      "向用户提结构化问题（选项式），阻塞等待回答后再继续。" +
      "何时用：需求有关键分岔、存在无法从代码推断的偏好、或将要做不可逆动作而意图不明时——" +
      "先问再做，比猜错返工便宜。" +
      "何时不用：答案能从代码/文档查到（自己查），或只是想确认无关紧要的细节（直接做）。" +
      `限制：一次 ${1}~${MAX_QUESTIONS} 题，每题 ${MIN_OPTIONS}~${MAX_OPTIONS} 个选项。` +
      "用户可能跳过：此时你会收到一条说明，请据此自行决断并声明假设，不要重复发问。",
    parameters: askUserSchema,
    // 参数位置照内核签名：(toolCallId, params, onUpdate, toolContext, invocation, context)
    async execute(toolCallId, params) {
      const validated = validateQuestionnaire(params);
      if (!validated.ok) {
        // 抛错而不是返回文本：内核只有这条路能把结果标成 isError（`AgentToolResult` 没有
        // isError 字段），模型因此能明确看到「这次调用失败了」并改对重发。
        throw new Error(`提问参数不合法：${validated.message}`);
      }
      const answer = await host.ask(toolCallId, validated.questions, 0);
      if (answer.kind === "skipped") {
        return {
          content: [{ type: "text" as const, text: skipMessage(answer.reason) }],
          details: undefined,
        };
      }
      return {
        content: [
          { type: "text" as const, text: formatAnswers(validated.questions, answer.answers) },
        ],
        details: undefined,
      };
    },
  };
  return [askUser];
}

/**
 * 提问的阻塞往返（与审批同形，见文件头注）。
 *
 * 独立成一个小对象而不是摊在 `entry.ts` 里：那是已知大户（有体量闸守着）；
 * 而且「发请求 / 等答复 / 超时 / 会话关闭时作废」这四件事是**一整块状态**，
 * 拆散在 entry 里反而更难看出谁没被清理。
 */
export interface AskUserGateway extends AskUserHost {
  /** 主进程答复到达，唤醒阻塞的工具 */
  settle(
    toolCallId: string,
    answers: Record<string, string> | undefined,
    skipped: AskUserSkipReason | undefined,
  ): void;
  /** 会话关闭时作废所有待答提问，避免工具干等到超时 */
  dispose(): void;
}

/** timeoutMs 传 0 时由 `defaultTimeoutMs` 兜底——别在别处再写一份时长字面量 */
export function createAskUserGateway(
  send: (message: WorkerMessage) => void,
  defaultTimeoutMs: number,
): AskUserGateway {
  const pending = new Map<
    string,
    { resolve: (value: AskUserAnswer) => void; timer: NodeJS.Timeout }
  >();

  return {
    ask(toolCallId, questions, timeoutMs) {
      const durationMs = timeoutMs > 0 ? timeoutMs : defaultTimeoutMs;
      return new Promise<AskUserAnswer>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(toolCallId);
          resolve({ kind: "skipped", reason: "timeout" });
        }, durationMs);
        timer.unref?.();
        pending.set(toolCallId, { resolve, timer });
        send({ type: "askUserRequest", toolCallId, questions, timeoutMs: durationMs });
      });
    },

    settle(toolCallId, answers, skipped) {
      const entry = pending.get(toolCallId);
      if (entry === undefined) return;
      pending.delete(toolCallId);
      clearTimeout(entry.timer);
      if (skipped !== undefined) {
        entry.resolve({ kind: "skipped", reason: skipped });
        return;
      }
      entry.resolve({ kind: "answered", answers: answers ?? {} });
    },

    dispose() {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.resolve({ kind: "skipped", reason: "cancelled" });
      }
      pending.clear();
    },
  };
}
