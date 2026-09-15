/**
 * **净变化**：一个文件「本次会话首次改动它之前」与「现在」的差异。
 *
 * 为什么需要它：内核的 `details.patch` 只说「这一次改了什么」，而把一串增量相加**不等于**
 * 文件的最终样子——改完又退回原样时，一串编辑相加是 `+10 −10`，文件其实一点没变。
 * 用户要问的是「这个文件最终被改成了什么样」，那就必须拿「改之前是什么」来比。
 *
 * 分工（这是本模块存在的理由，别把它挪回渲染层）：
 *   - 基线（改之前的内容）只有 worker 拿得到：它在工具执行**前**那一瞬读盘，越早越准；
 *   - 当前内容与 diff 都在**主进程**算——它既有读盘能力（`file-read.ts` 的安全边界），
 *     又是基线与改动的落库方（净变化要在改动落库那一刻一并写死，界面才不必每次重算）；
 *   - 渲染层只拿结论（`NetChangeResult`），不碰 fs。
 *
 * 两种「算不出来」必须分开报（见 `NetChangeResult`）：没有基线 vs 当前文件读不到。
 * 任何情况下都**不**退化成 `+0 −0`——那会被读成「没改过」，与事实相反。
 */
import { diffLines } from "@shared/line-diff";
import type { NetChangeResult } from "@shared/protocol";
import type { FileBaseline } from "@shared/worker-protocol";
import { readFileWithin } from "./file-read";

/** 没有基线时的说明：把三种成因都讲清楚，用户才知道这是环境所限，不是没改动 */
const NO_BASELINE = "未记录改动前的内容（文件过大 / 二进制 / 读取失败），无法给出净变化";

/**
 * 算某文件的净变化。
 *
 * `root` 是**项目根**（由调用方按 sessionId → 项目推出，绝不来自渲染层）；
 * 路径越界、文件不存在、已不是文本，都会落到 `unreadable`——都不会去碰根外的磁盘。
 */
export function computeNetChange(
  root: string,
  path: string,
  baseline: FileBaseline | undefined,
): NetChangeResult {
  if (baseline === undefined || baseline.text === null) {
    return { status: "no-baseline", reason: NO_BASELINE };
  }

  let current: string;
  try {
    const read = readFileWithin(root, path);
    if (read.kind !== "text") {
      return { status: "unreadable", reason: notTextReason(read.kind) };
    }
    current = read.text;
  } catch (error) {
    return {
      status: "unreadable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  // 基线里「文件不存在」等价于空文本：这次是新建，净变化就是整份新增
  const before = baseline.existed ? baseline.text : "";
  const diff = diffLines(before, current, path);
  return { status: "ok", patch: diff.patch, added: diff.added, removed: diff.removed };
}

/** 当前内容读得到、但「不是文本」时给一句可读的原因 */
function notTextReason(kind: string): string {
  if (kind === "too-large") return "文件过大，未读取内容，无法给出净变化";
  if (kind === "image") return "图片文件，无法按文本给出净变化";
  return "二进制文件，无法按文本给出净变化";
}
