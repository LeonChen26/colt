/**
 * worker 侧的纯投影辅助：从内核数据结构中抽取渲染层需要的字段。
 * 无副作用、不依赖 Electron，便于单元测试——下面那个内核类型导入是**类型专用**的
 * （`import type` 编译后整句擦除，Node 的 type-stripping 也直接删掉），运行时依旧零依赖。
 */
import type { Message } from "@earendil-works/pi-ai";

import { isAbsolute, relative } from "node:path";
import type { ViewMessage, WorkerBranchNode } from "@shared/worker-protocol";

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
 * 折叠中间的 LLM 轮次与工具调用，避免分支面板信息过载。
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
    nodes.push({
      id: entry.id,
      parentId: nearestKept(entry.id),
      kind: entry.message?.role ?? entry.type,
      summary: text.slice(0, 60).replace(/\s+/g, " ").trim() || `(${entry.type})`,
      timestamp: entry.timestamp ?? 0,
      onActivePath: activePath.has(entry.id),
      isTip: entry.id === effectiveTip,
    });
  }
  return nodes;
}
