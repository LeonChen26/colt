// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * worker 侧的纯投影辅助：从内核数据结构中抽取渲染层需要的字段。
 * 无副作用、不依赖 Electron，便于单元测试——下面那个内核类型导入是**类型专用**的
 * （`import type` 编译后整句擦除，Node 的 type-stripping 也直接删掉），运行时依旧零依赖。
 */
import type { Message } from "@earendil-works/pi-ai";

import { isAbsolute, relative } from "node:path";
import type { ViewMessage, ViewToolResult } from "@shared/worker-protocol";
import { toolImageFileName } from "@shared/tool-output";
import { parseSkillInvocation } from "./skills";

/**
 * 内核消息内容块的**已知类型**——真源是 pi 的联合类型，不是我们手写的字符串。
 *
 * ⚠️ 这张表是**升级哨兵**：pi 新增或改名内容块类型时它**编译不过**，逼你在 `extract*` 里
 * 显式处理。没有这道哨兵，新类型会被静默丢掉——界面上整整一类内容无声消失，
 * 与 `docs/ERRORS.md` 的「不许静默」直接冲突。理由与升级流程见 `docs/ARCHITECTURE.md` §四。
 */
type ContentBlock = Exclude<Message["content"], string>[number];
/**
 * 已知内容块类型表。**作用只在编译期**：`Record<ContentBlock["type"], true>` 缺键或多键都会
 * 让 pi 升级后的类型变化当场编译失败；运行时没有读取者，故此处不做查询函数。
 */
export const COVERED_BLOCK_TYPES: Record<ContentBlock["type"], true> = {
  text: true,
  thinking: true,
  image: true,
  toolCall: true,
};

/** 从消息内容块中抽取纯文本 */
export function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => {
      return typeof block === "object" && block !== null && (block as { type?: string }).type === "text";
    })
    .map((block) => block.text)
    .join("");
}

/** 从助手消息中抽取工具调用 */
export function extractToolCalls(content: unknown): ViewMessage["toolCalls"] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((block): block is { type: "toolCall"; id: string; name: string; arguments?: unknown } => {
      return typeof block === "object" && block !== null && (block as { type?: string }).type === "toolCall";
    })
    .map((block) => ({
      id: block.id,
      name: block.name,
      args: (() => {
        try {
          return JSON.stringify(block.arguments ?? {});
        } catch {
          return "{}";
        }
      })(),
    }));
}

/**
 * 这次工具调用若是 `read`，它读的路径命中了哪个已装载技能？（P3）
 *
 * 只认 `read`：技能正文是模型用 `read` 读进去的（内核没有 skill 工具，见报告 A4）。
 * `args` 是序列化后的 JSON，解析失败就当没命中——工具卡标记是**锦上添花**，
 * 为它去抛错或乱标都不划算。
 */
function skillOfReadCall(
  call: { name: string; args: string },
  matchSkill: (path: string) => string | undefined,
): string | undefined {
  if (call.name !== "read") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.args);
  } catch {
    return undefined;
  }
  const path = (parsed as { path?: unknown } | null)?.path;
  return typeof path === "string" ? matchSkill(path) : undefined;
}

/** 从助手消息内容块中抽取思考（thinking）文本 */
export function extractThinking(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "thinking"; thinking: string } => {
      return (
        typeof block === "object" &&
        block !== null &&
        (block as { type?: string }).type === "thinking" &&
        typeof (block as { thinking?: unknown }).thinking === "string"
      );
    })
    .map((block) => block.thinking)
    .join("");
}

/** 从工具结果的 content 块中抽取文本（与消息 content 结构一致） */
export function extractToolText(result: unknown): string {
  if (typeof result !== "object" || result === null) return "";
  return extractText((result as { content?: unknown }).content);
}

/** 从工具结果的 content 块中抽取首张图片（base64 + mimeType），无则返回 undefined */
export function extractImage(content: unknown): { data: string; mimeType: string } | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const record = block as { type?: string; data?: unknown; mimeType?: unknown };
    if (record.type === "image" && typeof record.data === "string" && typeof record.mimeType === "string") {
      return { data: record.data, mimeType: record.mimeType };
    }
  }
  return undefined;
}

/** 统计 unified patch 的增删行数 */
export function countPatchLines(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    // 排除 --- / +++ 文件头
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return { added, removed };
}

/** 把绝对路径收敛为相对工作目录的路径，便于 UI 展示 */
export function toRelative(cwd: string, path: string): string {
  if (!isAbsolute(path)) return path.replaceAll("\\", "/");
  const rel = relative(cwd, path);
  return (rel.startsWith("..") ? path : rel).replaceAll("\\", "/");
}

/**
 * 把一份 transcript 投影成渲染层要的「消息 + 工具结果」两列。
 *
 * 抽成独立函数（而不是留在 `project` 里）是因为**子代理的流**要用同一套投影：
 * 下钻面板与「最近 N 步」预览拿到的必须与主对话**同一种形状**，否则渲染层要写两套。
 * 调用方各传自己的 transcript 与耗时表，投影规则**只有一份**。
 */
export function projectTranscript(
  transcript: readonly unknown[],
  toolDurations: ReadonlyMap<string, number>,
  /**
   * 「这个路径是不是某个已装载技能的文件」——命中返回技能名，用来给 `read` 工具卡打标记（P3）。
   * 可选：子代理的流**没有**技能（worker 刻意不给子代理注入技能），不传就没有标记。
   */
  matchSkill?: (path: string) => string | undefined,
): { messages: ViewMessage[]; toolResults: ViewToolResult[] } {
  const messages: ViewMessage[] = [];
  const toolResults: ViewToolResult[] = [];

  for (const entry of transcript) {
    // 压缩条目：内核压缩完成后，transcript 的开头就是它（更早的历史已被它整体替换，
    // 尾部保留消息紧随其后）。不认它的话消息流只剩尾部——用户看到「历史全没了」。
    if ((entry as { type?: string }).type === "compaction") {
      const record = entry as unknown as {
        id: string;
        summary: string;
        timestamp?: number;
      };
      messages.push({
        id: record.id,
        // `other`：摘要不是任何人说的话，气泡署名谁都不对——渲染层按 compaction 标记画卡
        role: "other",
        text: typeof record.summary === "string" ? record.summary : "",
        compaction: true,
        toolCalls: [],
        timestamp: record.timestamp,
      });
      continue;
    }
    if ((entry as { type?: string }).type !== "message") continue;
    const record = entry as unknown as {
      id: string;
      message: { role: string; content: unknown; timestamp?: number };
    };
    const role = record.message.role;

    // toolResult **只进 toolResults**，不再塞进 messages：
    // 它从不单独成条（渲染层拿到它就 `return null`），塞进 messages 等于同一段正文
    // 每次推送都多发一份——「推了不用」的典型。视图是全量快照、流式期间每 50ms 重推一次，
    // 这种浪费要按推送次数乘上去。
    // 注意：toolCallId 在 message 层级，content 是扁平的文本/图片块
    if (role === "toolResult") {
      const result = record.message as unknown as {
        toolCallId?: string;
        content?: unknown;
        isError?: boolean;
      };
      if (typeof result.toolCallId === "string") {
        const image = extractImage(result.content);
        toolResults.push({
          id: result.toolCallId,
          output: extractText(result.content),
          isError: Boolean(result.isError),
          // 截图等图片：能落盘的只报「有图」——base64 不进视图（视图每 50ms 全量重推一次，
          // 一张几 MB 的截图会被反复搬运），展开卡片时用 session.toolOutput 读回。
          // 落不了盘的类型（mime 认不出）才内联，宁可这一条大点也别让用户看不到图。
          ...(image === undefined
            ? {}
            : toolImageFileName(result.toolCallId, image.mimeType) === undefined
              ? { image }
              : { hasImage: true }),
        });
      }
      continue;
    }

    const text = extractText(record.message.content);
    // 技能调用是内核发的一条 user 消息，归属**不是用户**：目录/分支树的标签与摘要
    // 都要拿技能名，而不是把 `<skill name="…" location="…">` 那段原始 XML 摆出来
    const skill = role === "user" ? parseSkillInvocation(text) : null;
    messages.push({
      id: record.id,
      role:
        role === "user" || role === "assistant"
          ? (role as ViewMessage["role"])
          : "other",
      text,
      ...(skill === null ? {} : { skill }),
      // 用户随消息发送的图片回显到对话里；与工具截图同源，均为不含前缀的 base64
      image: role === "user" ? extractImage(record.message.content) : undefined,
      toolCalls:
        role === "assistant"
          ? extractToolCalls(record.message.content).map((call) => {
              const skill = matchSkill === undefined ? undefined : skillOfReadCall(call, matchSkill);
              return {
                ...call,
                durationMs: toolDurations.get(call.id),
                ...(skill === undefined ? {} : { skill }),
              };
            })
          : [],
      thought: role === "assistant" ? extractThinking(record.message.content) || undefined : undefined,
      timestamp: record.message.timestamp,
    });
  }
  return { messages, toolResults };
}

