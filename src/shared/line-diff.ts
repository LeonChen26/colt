// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 行级 diff：把「改动前 → 改动后」两份文本算成 unified patch + 增删行数。
 *
 * 它是**净值**那套东西的算法核心（`src/main/net-change.ts`）：内核给的 `details.patch`
 * 只说「这一次改了什么」，而用户要看的是「这个文件最终变成了什么样」——后者只能由
 * 「基线与当前内容」两份全文算出来，故这里需要一个不依赖内核的 diff。
 *
 * 三件事都在这里定死：
 *   ① 行**带换行符参与比较**（`"a\n"` 与 `"a"` 不是同一行）——末尾少一个换行也是真差异，
 *      与 git 的观感一致：少了换行那一行会被算作一删一增。
 *   ② 先砍掉公共前后缀，再对中间段求最短编辑脚本——常见的「改几行」瞬间缩成几十行的
 *      小矩阵；矩阵真的过大时退化成「整块替换」（仍**不丢行**，只是粒度变粗）。
 *   ③ 只产出 unified patch（`@@ -a,b +c,d @@`）——渲染层 `DiffView` 按行前缀着色，
 *      与内核产的 patch 共用同一条显示路径，不必为净值单写一套视图。
 *
 * 纯函数、不碰 electron / fs / DOM，故 `tests/line-diff.test.ts` 直接覆盖。
 */

/** hunk 前后各留的上下文行数：与内核 `edit` 产出的一致，两处观感才相同 */
const CONTEXT = 3;

/**
 * 中间段矩阵的规模上限（行数乘积）。
 * 超过它就不求最短编辑脚本，直接「整块替换」——这种情况只会出现在两份**大体不同**
 * 的大文件上（正常改动的中间段早被前后缀砍到很小），此时粒度变粗、行数偏保守，
 * 但**不会算错方向**（不会把没删的说成删了）。
 */
const MAX_MATRIX = 4_000_000;

export interface LineDiff {
  /** 标准 unified patch；两份内容相同时为空串 */
  patch: string;
  added: number;
  removed: number;
}

/**
 * 切行：**保留行尾换行符**（见文件头 ①）。
 * 空文本切出 0 行；`"a\n"` 切出一行 `"a\n"`，`"a"` 切出一行 `"a"`。
 */
function splitLines(text: string): string[] {
  if (text === "") return [];
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** 行尾换行符不参与显示（它是比较用的，不是内容） */
function display(line: string): string {
  return line.endsWith("\n") ? line.slice(0, -1) : line;
}

type Op = { kind: "ctx" | "del" | "ins"; line: string };

/** 最长公共子序列（中间段）：返回编辑脚本；矩阵过大时退化成整块替换 */
function editScript(a: string[], b: string[]): Op[] {
  if (a.length * b.length > MAX_MATRIX) {
    return [
      ...a.map((line) => ({ kind: "del", line }) as Op),
      ...b.map((line) => ({ kind: "ins", line }) as Op),
    ];
  }

  const width = b.length + 1;
  // lcs[i * width + j] = a[i..] 与 b[j..] 的最长公共子序列长度（从右下往左上填）
  const lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? (lcs[(i + 1) * width + (j + 1)] as number) + 1
          : Math.max(lcs[(i + 1) * width + j] as number, lcs[i * width + (j + 1)] as number);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: "ctx", line: a[i] as string });
      i += 1;
      j += 1;
      continue;
    }
    // 同长时优先「删」：让删除集中在新增之前，读起来像一次正常改动
    if ((lcs[(i + 1) * width + j] as number) >= (lcs[i * width + (j + 1)] as number)) {
      ops.push({ kind: "del", line: a[i] as string });
      i += 1;
    } else {
      ops.push({ kind: "ins", line: b[j] as string });
      j += 1;
    }
  }
  for (; i < a.length; i += 1) ops.push({ kind: "del", line: a[i] as string });
  for (; j < b.length; j += 1) ops.push({ kind: "ins", line: b[j] as string });
  return ops;
}

/** 把编辑脚本切成 hunk：改动之间隔着 ≤ 2×CONTEXT 行上下文就并进同一个 hunk */
function toHunks(ops: Op[]): { oldStart: number; oldCount: number; newStart: number; newCount: number; lines: string[] }[] {
  const hunks: { oldStart: number; oldCount: number; newStart: number; newCount: number; lines: string[] }[] = [];
  // 每个 op 在两侧的「之前已有多少行」，用于算 hunk 头部的起止行号
  const oldBefore: number[] = [];
  const newBefore: number[] = [];
  let oldSeen = 0;
  let newSeen = 0;
  for (const op of ops) {
    oldBefore.push(oldSeen);
    newBefore.push(newSeen);
    if (op.kind !== "ins") oldSeen += 1;
    if (op.kind !== "del") newSeen += 1;
  }

  let index = 0;
  while (index < ops.length) {
    if ((ops[index] as Op).kind === "ctx") {
      index += 1;
      continue;
    }
    // 从这处改动往回吃 CONTEXT 行上下文
    let start = index;
    let lead = 0;
    while (start > 0 && lead < CONTEXT && (ops[start - 1] as Op).kind === "ctx") {
      start -= 1;
      lead += 1;
    }

    // 往后走：改动连同 ≤2×CONTEXT 的上下文间隔一起并进本 hunk
    let end = index;
    let body: Op[] = [];
    while (end < ops.length) {
      if ((ops[end] as Op).kind !== "ctx") {
        end += 1;
        continue;
      }
      let gap = end;
      while (gap < ops.length && (ops[gap] as Op).kind === "ctx") gap += 1;
      if (gap - end > CONTEXT * 2 || gap >= ops.length) break;
      end = gap;
    }
    const tail = Math.min(CONTEXT, ops.length - end);
    body = ops.slice(start, end + tail);

    const lines = body.map((op) => {
      const prefix = op.kind === "del" ? "-" : op.kind === "ins" ? "+" : " ";
      // 末行没有换行符时补一枚 git 同款标记，免得「少一个换行」看起来像没变化
      return `${prefix}${display(op.line)}${op.line.endsWith("\n") ? "" : "\n\\ No newline at end of file"}`;
    });
    const oldCount = body.filter((op) => op.kind !== "ins").length;
    const newCount = body.filter((op) => op.kind !== "del").length;
    const oldStart = oldCount === 0 ? (oldBefore[start] as number) : (oldBefore[start] as number) + 1;
    const newStart = newCount === 0 ? (newBefore[start] as number) : (newBefore[start] as number) + 1;
    hunks.push({ oldStart, oldCount, newStart, newCount, lines });
    index = end + tail;
  }
  return hunks;
}

/**
 * 算「改动前 → 改动后」的差异。
 *
 * `path` 只用于 patch 头两行（`--- a/x` / `+++ b/x`）；不给就写「改动前 / 当前」。
 */
export function diffLines(before: string, after: string, path = ""): LineDiff {
  const a = splitLines(before);
  const b = splitLines(after);

  // 砍公共前后缀：正常改动下中间段极小，矩阵与 hunk 都跟着小
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const middle = editScript(a.slice(prefix, a.length - suffix), b.slice(prefix, b.length - suffix));
  const removed = middle.filter((op) => op.kind === "del").length;
  const added = middle.filter((op) => op.kind === "ins").length;
  if (removed === 0 && added === 0) return { patch: "", added: 0, removed: 0 };

  const ops: Op[] = [
    ...a.slice(0, prefix).map((line) => ({ kind: "ctx", line }) as Op),
    ...middle,
    ...a.slice(a.length - suffix).map((line) => ({ kind: "ctx", line }) as Op),
  ];

  const head = path === "" ? "--- 改动前\n+++ 当前" : `--- a/${path}\n+++ b/${path}`;
  const body = toHunks(ops).map(
    (hunk) =>
      `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@\n${hunk.lines.join("\n")}`,
  );
  return { patch: `${head}\n${body.join("\n")}\n`, added, removed };
}
