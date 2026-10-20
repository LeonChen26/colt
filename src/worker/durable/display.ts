// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 界面历史的条目缓存。
 *
 * **为什么需要它**：durable 的 `view.entries` 从压缩的 head 标记开始，是**模型上下文**的
 * 可见范围；而会话历史是用户看的，两者不能混为一谈——压缩过后，界面仍要能看到
 * 被摘要替换掉的那段对话。完整条目在会话库里是追加式的、并没有删，所以这里按会话
 * 全量读一遍留作显示缓存，之后只把新提交的条目追进来。
 *
 * 缓存与模型上下文完全解耦：
 *  - 压缩新增一条 compaction 条目 → 追加进缓存，旧条目一条不少；
 *  - `reenter` 切到另一个分支 → 整个缓存重建；
 *  - 投影（`projectDisplay`）不认 head，按条目顺序出消息。
 */
import type { Context } from "@earendil-works/chord";
import type {
  ConversationId,
  Cursor,
  EntryRecord,
  Storage,
} from "@earendil-works/pi-durable";

/** 每次向存储要的条目数：太大占内存，太小往返多；500 条对会话规模足够 */
const PAGE_SIZE = 500;

export interface DisplayState {
  /** 全部条目，按 id 升序（与存储的 ascending 顺序一致） */
  entries: EntryRecord[];
  /** 已收录的条目 id（字符串形式，只用于去重） */
  known: Set<string>;
}

/** 从会话库读全部条目（含压缩之前的历史） */
export async function loadDisplayState(
  storage: Pick<Storage, "scanEntries">,
  conversationId: ConversationId,
  context: Context,
): Promise<DisplayState> {
  const entries: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  for (;;) {
    const page = await storage.scanEntries(
      { conversationId, order: "ascending" },
      PAGE_SIZE,
      cursor,
      context,
    );
    entries.push(...page.items);
    if (page.next === undefined) break;
    cursor = page.next;
  }
  return { entries, known: new Set(entries.map((entry) => String(entry.id))) };
}

/**
 * 把新提交的条目并进缓存（只看 id，不看 head）。
 * 返回是否真的有新增——调用方据此决定要不要重投影。
 */
export function appendDisplayEntries(
  display: DisplayState,
  incoming: readonly EntryRecord[],
): boolean {
  let changed = false;
  for (const entry of incoming) {
    const key = String(entry.id);
    if (display.known.has(key)) continue;
    display.known.add(key);
    display.entries.push(entry);
    changed = true;
  }
  return changed;
}
