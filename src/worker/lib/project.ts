// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * worker 侧的纯投影辅助：从内核数据结构中抽取渲染层需要的字段。
 * 无副作用、不依赖 Electron，便于单元测试——下面那个内核类型导入是**类型专用**的
 * （`import type` 编译后整句擦除，Node 的 type-stripping 也直接删掉），运行时依旧零依赖。
 */
import type { Message } from "@earendil-works/pi-ai";

import { isAbsolute, relative } from "node:path";
import type {
  ConversationView,
  ViewFileChange,
  ViewMessage,
  ViewRunOutcome,
  ViewRunningTool,
  ViewSkill,
  ViewSubagent,
  ViewToolResult,
  WorkerBranchNode,
} from "@shared/worker-protocol";
import type { LaneSnapshot } from "@earendil-works/pi-agent-core";
import type { ThinkingLevel } from "@shared/thinking-level";
import type { ViewTodo } from "@shared/todo";
import { toolImageFileName } from "@shared/tool-output";
import { skillInvocationLabel } from "@shared/skill-invocation";
import { serializeArgs } from "./telemetry";
import { parseSkillInvocation, skillPathMatcher } from "./skills";

/**
 * 内核消息内容块的**已知类型**——真源是 pi 的联合类型，不是我们手写的字符串。
 *
 * ⚠️ 这张表是**升级哨兵**：pi 新增或改名内容块类型时它**编译不过**，逼你在 `extract*` 里
 * 显式处理。没有这道哨兵，新类型会被静默丢掉——界面上整整一类内容无声消失，
 * 与 `docs/ERRORS.md` 的「不许静默」直接冲突。理由与升级流程见 `docs/ARCHITECTURE.md` §四。
 */
type ContentBlock = Exclude<Message["content"], string>[number];
const COVERED_BLOCK_TYPES: Record<ContentBlock["type"], true> = {
  text: true,
  thinking: true,
  image: true,
  toolCall: true,
};

/** 内容块的 `type` 是否已被 `extract*` 覆盖（false = 会被投影丢掉，应当上报） */
export function isCoveredBlockType(type: unknown): boolean {
  return typeof type === "string" && Object.prototype.hasOwnProperty.call(COVERED_BLOCK_TYPES, type);
}

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

/** 分支树条目：内核 entry 中投影所需的最小字段 */
export interface BranchEntry {
  id: string;
  parentId: string | null;
  /** 条目类型：message / compaction / branch_summary ... */
  type: string;
  timestamp?: number;
  message?: { role: string; content: unknown };
}

/**
 * 把会话全部条目投影成分支树节点。
 * 只保留「用户输入」「该轮最终回复」以及压缩/分支摘要等结构节点，
 * 折叠中间的 LLM 轮次与工具调用，避免分支树信息过载。
 * 被折叠条目的子节点会挂到最近的保留祖先上以保持树连通；
 * 若当前指针落在被折叠条目上，则回退为活跃路径上最近的保留节点。
 */
export function projectBranchNodes(
  entries: BranchEntry[],
  tipId: string | null,
): WorkerBranchNode[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));

  const keep = new Set<string>();
  for (const entry of entries) {
    if (!entry.message) {
      // 压缩 / 分支摘要等结构节点保留
      keep.add(entry.id);
      continue;
    }
    const role = entry.message.role;
    if (role === "user") {
      keep.add(entry.id);
      continue;
    }
    if (role !== "assistant") continue;
    // 仅保留该轮的最终回复：不含工具调用且有文本输出的助手消息
    const hasToolCall = extractToolCalls(entry.message.content).length > 0;
    if (!hasToolCall && extractText(entry.message.content).trim()) keep.add(entry.id);
  }

  const nearestKept = (id: string): string | null => {
    let cursor = byId.get(id)?.parentId ?? null;
    while (cursor) {
      if (keep.has(cursor)) return cursor;
      cursor = byId.get(cursor)?.parentId ?? null;
    }
    return null;
  };

  const activePath = new Set<string>();
  let effectiveTip: string | null = null;
  let cursor: string | null = tipId;
  while (cursor) {
    activePath.add(cursor);
    if (effectiveTip === null && keep.has(cursor)) effectiveTip = cursor;
    cursor = byId.get(cursor)?.parentId ?? null;
  }

  const nodes: WorkerBranchNode[] = [];
  for (const entry of entries) {
    if (!keep.has(entry.id)) continue;
    const text = entry.message ? extractText(entry.message.content) : "";
    const skill = entry.message?.role === "user" ? parseSkillInvocation(text) : null;
    nodes.push({
      id: entry.id,
      parentId: nearestKept(entry.id),
      kind: entry.message?.role ?? entry.type,
      summary:
        skill === null
          ? text.slice(0, 60).replace(/\s+/g, " ").trim() || `(${entry.type})`
          : skillInvocationLabel(skill).slice(0, 60),
      timestamp: entry.timestamp ?? 0,
      onActivePath: activePath.has(entry.id),
      isTip: entry.id === effectiveTip,
    });
  }
  return nodes;
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
        tokensBefore: number;
        timestamp?: number;
      };
      messages.push({
        id: record.id,
        // `other`：摘要不是任何人说的话，气泡署名谁都不对——渲染层按 compaction 标记画卡
        role: "other",
        text: typeof record.summary === "string" ? record.summary : "",
        compaction: {
          // 缺失/非法给 0：渲染层对 <=0 不显示数字（与完成通知 compactDoneMessage 同口径）
          tokensBefore: typeof record.tokensBefore === "number" ? record.tokensBefore : 0,
        },
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

/** 正在执行的工具 → 渲染层 DTO（主对话与子代理共用同一份规则） */
export function projectRunningTools(
  operation: LaneSnapshot["operation"],
): ViewRunningTool[] {
  return (operation?.runningTools ?? []).map((tool) => {
    const record = tool as unknown as {
      toolCallId?: string;
      id?: string;
      toolName?: string;
      name?: string;
      args?: unknown;
      startedAt?: number;
      result?: unknown;
    };
    const details = (record.result as { details?: { fullOutputPath?: string } } | undefined)?.details;
    return {
      id: record.toolCallId ?? record.id ?? "",
      name: record.toolName ?? record.name ?? "",
      // 内核在 runningTools 上已经带上了入参，序列化后供渲染层实时展示命令
      args: serializeArgs(record.args) ?? "{}",
      // bash 等工具在运行中会不断把全量输出快照写回 result
      output: extractToolText(record.result),
      fullOutputPath: details?.fullOutputPath,
      startedAt: record.startedAt ?? Date.now(),
    };
  });
}

/** 把 LaneSnapshot 投影成渲染层可直接消费的 DTO */
/**
 * 把内核的「最近一次操作结果」投影成 ⑥ 需要的**运行终态**（C1）。
 *
 * 只认 `kind === "run"`：压缩 / 导航也会写 `lastResult`，但它们在状态条上答非所问
 * （用户问的是「我刚交办的那件事怎么样了」）。没有跑过、或最近一次是别的操作 → `null` → 「空闲」。
 */
export function projectLastRun(result: LaneSnapshot["lastResult"]): ViewRunOutcome | null {
  if (result === undefined || result.kind !== "run") return null;
  return {
    status: result.status,
    ...(result.error !== undefined ? { error: result.error.message } : {}),
  };
}

export function project(
  snapshot: LaneSnapshot,
  meta: {
    sessionId: string;
    cwd: string;
    model: string;
    /** 当前模型是否支持图片输入（取自模型目录的 input 能力），决定界面能否发图 */
    imageInput: boolean;
    /** 会话思考等级，供界面下拉回显 */
    thinkingLevel: ThinkingLevel;
    /**
     * 本会话装载到的技能（装载后固定）。
     *
     * 渲染层要拿它的**名字**就地判「这个名字存不存在」：名字打错时它不清空输入、把可用名报出来，
     * 用户改一个字母就能重敲。没有它，那半句额外指示会跟着输入一起没掉。
     * 其余字段（来源/是否对模型公开/路径）是给「技能」面板用的底子。
     */
    skills: ViewSkill[];
    fileChanges: ViewFileChange[];
    /**
     * 待办清单。与 `fileChanges` 同一个道理：**投影时恒为空数组**，
     * 主进程会用数据库里那份完整清单覆盖它（真源在主进程，不在 worker 内存）。
     */
    todos: ViewTodo[];
    /** 最近一轮上下文占用，由 usage 事件维护；重启后由主进程用 DB 回填 */
    contextUsed: number;
  },
  /**
   * 已完成的工具调用耗时（toolCallId → ms）。由 entry.ts 的 after_tool 维护、有上限，
   * 投影时只读——放在这里而不是本模块里，只因它是**会话运行期**的状态，不是纯数据。
   */
  toolDurations: ReadonlyMap<string, number>,
  /**
   * 子代理总账（有界尾部）。由 worker 的子代理注册表给出——它**不来自内核快照**：
   * 子代理跑在独立 lane 上，主 lane 的快照里根本没有它们。
   */
  subagents: readonly ViewSubagent[],
): ConversationView {
  // 技能工具卡标记（P3）：判定函数由「已装载技能的路径集合 + cwd」构成，
  // 让每次 `read` 命中技能文件时打上「技能 X」——主对话才有技能，子代理的流不传。
  const { messages, toolResults } = projectTranscript(
    snapshot.transcript,
    toolDurations,
    skillPathMatcher(meta.skills, meta.cwd),
  );

  const operation = snapshot.operation;
  const streamingText = operation?.streamingMessage
    ? extractText(operation.streamingMessage.content)
    : null;
  const streamingThought = operation?.streamingMessage
    ? extractThinking(operation.streamingMessage.content)
    : "";

  const runningTools = projectRunningTools(operation);

  const usage = snapshot.stats?.usage;
  return {
    sessionId: meta.sessionId,
    model: meta.model,
    imageInput: meta.imageInput,
    thinkingLevel: meta.thinkingLevel,
    skills: meta.skills,
    messages,
    toolResults,
    fileChanges: meta.fileChanges,
    todos: meta.todos,
    streamingText: streamingText && streamingText.length > 0 ? streamingText : null,
    thought: streamingThought.length > 0 ? streamingThought : null,
    runningTools,
    subagents: [...subagents],
    // operation 非 null 即为「有一次 run/compaction/navigation 正在飞行」：
    // 内核 reducer 在 *_start 时写入该对象，在 *_end 时才置回 null。
    // 注意不要看 operation.status —— OperationStatus 只有 running|open|aborting，
    // 而 run_start 写入的恰是 "open"（表示「进行中的操作」而非「已完成」），
    // 用它判定会把整个运行期误判为空闲。
    running: operation !== null,
    // 「在忙什么」与「忙不忙」分开投影（见契约注释）：压缩期间流式区只有一段
    // 无署名的摘要文本，渲染层要靠 kind 才能给出「正在压缩上下文」的状态呈现。
    runningOperation: operation?.kind ?? null,
    lastRun: projectLastRun(snapshot.lastResult),
    queuedCount: snapshot.queues?.length ?? 0,
    stats: {
      messageCount: snapshot.stats?.messageCount ?? 0,
      inputTokens: usage?.input ?? 0,
      outputTokens: usage?.output ?? 0,
      totalTokens: usage?.totalTokens ?? 0,
      costUsd: usage?.cost?.total ?? 0,
      contextUsed: meta.contextUsed,
    },
  };
}
