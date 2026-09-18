// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * /memory-tidy：显式的记忆整理命令（L3b 后台整固）。
 *
 * 触发形式是**用户敲的命令**，而不是「记忆超限后自动后台跑」：整理是一次真实
 * 模型调用（可见计费），删条目又是有观感的结果——两件事都该发生在用户明确要求
 * 的时候；且截断传感器（memory.ts）从未真正触发过，为假想的负载先做自动化
 * 基础设施，是给不存在的需求修路。
 *
 * 实现走内核的一级能力 **子 lane**：`harness.lane(TIDY_LANE)` 开一条独立 lane，
 * 自己的 transcript、自己的工具白名单（setActiveTools 按 lane 持久化）、与主对话
 * 并行。三件事由内核与既有设施自动兜住，应用不用再操心：
 * - **审批**：HookRegistry 是全 harness 共享的，整理写记忆文件照常走审批闸门；
 * - **计量**：usage / toolCall 事件带 lane 名，telemetry 只采主 lane（MAIN_LANE），
 *   整理的消耗不进会话统计；但 after_tool 的文件改动记录器不分 lane——整理对
 *   记忆文件的改写会如实出现在会话的改动记录里（诚实报告，不藏）；
 * - **崩溃恢复**：entry.ts 的 open-operations 恢复循环按名重开这条 lane。
 *
 * 应用侧只补内核没有的两件事（见 entry.ts）：
 * - transform_context 按 lane 分支——系统提示词是 harness 级单值，整理 lane
 *   需要下面这份专用提示词，而不是编码助手的提示词；
 * - 完成通知——子 lane 对界面不可见（主 lane 的 watch 看不到它），跑完必须由
 *   应用显式报一声，否则用户敲了命令只见「没反应」（AGENTS.md §3.6）。
 *
 * v1 只整理项目级记忆：用户级（~/.colt/memory.md）在项目之外、条目少而稳定，
 * 且写入每次单独确认（docs/SECURITY.md），先不碰。
 */
import { MEMORY_RELATIVE_PATH, memoryFilePath } from "./memory";

/** 整理跑在独立子 lane 上；名字即身份（持久化、恢复、事件过滤都按它） */
export const TIDY_LANE = "memory-tidy";

/**
 * 整理允许的工具集：读文件、整体写回、查检索冷层。
 * 白名单是硬边界（setActiveTools），提示词里「只许改这一个文件」是软约束——两层叠加。
 */
export const TIDY_TOOLS: readonly string[] = ["read", "write", "memory_search"];

/** 整理 lane 的系统提示词：它不是编码助手，主对话的 AGENTS.md / 记忆块对它没有意义 */
export function memoryTidySystemPrompt(cwd: string): string {
  const path = memoryFilePath(cwd);
  return [
    "你在整理一个项目的长期记忆文件。这是一次独立的后台任务，与任何对话无关；不要回答问题，只做整理。",
    "",
    `记忆文件：${path}（${MEMORY_RELATIVE_PATH}，跨会话沉淀的项目记忆，Markdown，一行一条）。`,
    "",
    "做法：",
    "1. 用 read 工具读取该文件。文件为空或不存在时，不写任何东西，直接报告「记忆为空」。",
    "2. 需要判断某条记忆是否还有效时，可用 memory_search 查历史沉淀（结果含已归档条目）。",
    "3. 合并语义重复的条目：同一件事记了多遍的，合成一条信息最全的写法。可以改写措辞，但不得引入文件之外的新事实。",
    "4. 删除明显过时的条目：描述的事实已不再成立，或已被后面的条目取代。拿不准是否过时就保留——宁可少删，不凭猜测删。",
    "5. 其余条目原样保留，保持一行一条的既有格式；不分节、不加评论。",
    "6. 有改动时，用 write 工具把整理后的完整内容一次性写回该文件。只允许改这一个文件，其他任何文件都不要碰。",
    "7. 最后用一两句话报告：合并几条、删除几条、保留几条；没有改动就说明原因。",
  ].join("\n");
}

/** 发给整理 lane 的任务正文（规则在系统提示词里，这里只给一句可执行的指令） */
export function memoryTidyTask(): string {
  return "整理项目记忆文件：合并重复、删除过时条目，有改动就写回，然后报告结果。";
}

/** 整理完成的通知。子 lane 对界面不可见，这句话就是用户能看到的全部结果 */
export function memoryTidyDoneNotice(): string {
  return (
    `记忆整理完成（项目记忆 ${MEMORY_RELATIVE_PATH}）。` +
    "被合并或删除的条目已进入检索冷层，需要时仍可用 memory_search 找回。"
  );
}

/**
 * 内核 `lane.prompt()` 的失败（Result.err）→ 给用户看的一句话。
 * 与 compact-error 同款判别：错误类不在本仓类型面里（worker 只拿到运行时对象），
 * 按 `_tag`（TaggedError）识别，与内核 result.js 的定义对齐。
 */
export function describeTidyError(error: unknown): string {
  const tag = (error as { _tag?: string } | undefined)?._tag;
  switch (tag) {
    case "LaneBusy":
      return "上一次记忆整理还在进行中，请等它完成。";
    case "Closed":
      return "会话已关闭，无法整理记忆。";
  }
  const message =
    error instanceof Error
      ? error.message
      : typeof (error as { message?: unknown } | undefined)?.message === "string"
        ? (error as { message: string }).message
        : String(error);
  return `记忆整理未能启动：${message}`;
}

/** 整理**运行后**结算的终态（status !== "completed"）→ 给用户看的一句话（同 compact-error 的第二条失败路径） */
export function describeTidyOutcome(record: {
  status: string;
  error?: { code?: string; message?: string };
}): string {
  if (record.status === "aborted" || record.error?.code === "aborted") return "记忆整理已中止。";
  if (record.error?.message) return `记忆整理失败：${record.error.message}`;
  if (record.status === "declined") return "记忆整理未执行。";
  return "记忆整理失败：原因未知。";
}
