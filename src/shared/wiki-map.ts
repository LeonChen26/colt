// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 仓库 Wiki 的**提示词注入块**（每请求拼进系统提示词，见 `worker/entry.ts` 的 `transform_context`）。
 *
 * 为什么值得注入：「这个项目怎么组织的」是每轮对话都要用到的背景，而模型默认只能靠
 * grep 逐个文件重建。有产物时先把「模块 → 页面」的索引摆出来，模型的第一反应才会是
 * 读 wiki 而不是翻源码（`docs/wiki` 是 agent 自己写的，比现场 grep 出来的切片完整）。
 *
 * 三条口径：
 * 1. **没有产物就不产出任何东西**——空块是常态噪声，删掉比留着强；
 * 2. **必须写清新鲜度**。产物是某一刻的代码快照，落后以后结论会变成撒谎
 *    （`docs/ERRORS.md` 的「持续撒谎」是这一层最贵的错）。落后就明说落后，
 *    比较不了就说「未知」——`0` 与 `null` 绝不能混；
 * 3. **超预算就截断，但要如实写还剩多少**。静默裁掉会让模型以为 wiki 只覆盖了前几个模块。
 */
/** 一条「模块 → 页面」索引；`title` 是模块在树里的层级路径（`父 / 子`），`path` 相对项目根 */
export interface WikiMapEntry {
  path: string;
  title: string;
}

/**
 * 注入块的输入：只收**已经算好**的事实。
 *
 * 读盘、解析 `module_tree.json`、判定新鲜度都在 `worker/lib/wiki-map.ts`；
 * 这里保持纯函数，才能被单测直接钉住（尤其是「null ≠ 0」那一条）。
 */
export interface WikiMapInput {
  /** 概览页路径；没有则为 null */
  overview: string | null;
  entries: readonly WikiMapEntry[];
  /** `metadata.json` 的原始时间戳（不猜格式，只截日期） */
  generatedAt: string | null;
  /** 落后多少提交；**null 表示比较不了**，与 `0`（一致）必须分开 */
  behind: number | null;
}
/**
 * 块的字数预算。
 *
 * 按 1.5k token 估：中文一字约 1 token，ASCII 路径约 3~4 字符 1 token，混合下来
 * **4000 字符**是偏保守的落点（宁短勿长——这段每轮都随提示词一起过账，
 * 而且要排在 AGENTS.md / 记忆块之后，不能抢它们的注意力）。
 */
export const WIKI_MAP_BUDGET_CHARS = 4000;

/** `metadata.json` 的 timestamp 是 `2026-10-17T22:03:43.924415`；只取日期部分，取不到就原样给 */
function dayOf(timestamp: string): string {
  const head = timestamp.trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(head) ? head : timestamp.trim();
}

/** 新鲜度短语：`null` 是「不知道」，不是「最新」 */
function freshness(input: WikiMapInput): string {
  const parts: string[] = [];
  if (input.generatedAt !== null && input.generatedAt.trim() !== "") {
    parts.push(`生成于 ${dayOf(input.generatedAt)}`);
  }
  if (input.behind === null) {
    parts.push("与当前代码是否同步未知");
  } else if (input.behind === 0) {
    parts.push("生成后代码没有新提交");
  } else {
    parts.push(`生成后代码又多了 ${input.behind} 个提交，**部分结论可能已过期**`);
  }
  return parts.join("，");
}

/**
 * 渲染注入块。空产物（既没有概览也没有任何页面）返回空串。
 */
export function renderWikiMap(
  input: WikiMapInput,
  budgetChars: number = WIKI_MAP_BUDGET_CHARS,
): string {
  const entries = [...input.entries].filter((entry) => entry.path !== "");
  if (entries.length === 0 && input.overview === null) return "";

  const header = "## 仓库 Wiki（agent 生成、随代码演进的模块文档）";
  const meta = `位置 docs/wiki/ ｜ ${freshness(input)}`;
  const trail = [
    "读某页用 read 打开对应路径（不要 grep 整个 docs/wiki）。",
    "wiki 与源码冲突时以**源码为准**；wiki 里没写的再去 grep。",
  ].join("");
  const overviewLine =
    input.overview === null
      ? null
      : `- 概览（先看这页）→ ${input.overview}`;

  // 预算：表头 + 元信息 + 尾注先扣，剩下的才给页面行（与 todo 注入同一口径：先算固定的）
  const fixed = [header, meta, overviewLine, trail].filter((line): line is string => line !== null);
  const fixedChars = fixed.reduce((sum, line) => sum + line.length + 1, 0);
  let remaining = Math.max(0, budgetChars - fixedChars);

  const lines: string[] = [];
  for (const entry of entries) {
    const line = `- ${entry.title} → ${entry.path}`;
    // +1 是行尾换行；放不下就停，后面统一交代「剩多少」
    if (line.length + 1 > remaining) break;
    remaining -= line.length + 1;
    lines.push(line);
  }
  const hidden = entries.length - lines.length;

  const body = [
    header,
    meta,
    ...(overviewLine === null ? [] : [overviewLine]),
    ...lines,
  ];
  if (hidden > 0) {
    // 「还剩多少」是必写的一句：静默截断会让模型以为 wiki 就只覆盖了这几块
    body.push(`- …还有 ${hidden} 页未列出（docs/wiki/ 下都有；按上面的命名规则可直接 read）`);
  }
  body.push(trail);
  return body.join("\n");
}
