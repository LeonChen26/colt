// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * Unified patch 渲染：按行着色。
 * 分类逻辑见 lib/diff.ts（纯函数，可单测）。
 */
import { classifyDiffLine, type DiffLineKind } from "../lib/diff";

const STYLE: Record<DiffLineKind, string> = {
  add: "bg-success-soft text-success-fg",
  remove: "bg-danger-soft text-danger-fg",
  hunk: "bg-surface-overlay text-text-muted",
  meta: "text-text-muted",
  context: "text-text-secondary",
};

export function DiffView({
  patch,
  fill = false,
}: {
  patch: string;
  /**
   * 放进**整屏面板**（下钻的 diff 层、改动页右栏）时置 true：高度交给外层容器管、卡片铺满，
   * 不再自带 320px 上限——否则面板那么高、卡片只有上半屏，下面全空（用户报的就是这个）。
   * 消息流 / 审批卡里保持默认 false：那两处是**流里的卡片**，没有可用的固定高度，
   * 不设上限会把消息流撑出上万像素。
   */
  fill?: boolean;
}): React.JSX.Element {
  const lines = patch.split("\n");
  // 是否已进入 hunk：hunk 内的 `---` / `+++` 是正文行（见 classifyDiffLine 的说明）
  let inHunk = false;
  return (
    // 默认（流里）与工具输出区一致地封 320px：大 patch（lockfile / 生成文件）一次性全量渲染，
    // 不设上限会把消息流撑出上万像素高度，也拖慢首次渲染。`fill` 时改由外层容器封顶。
    <div
      data-diff-view
      className={`overflow-auto rounded-sm border border-line bg-surface-code font-mono text-xs leading-relaxed ${
        fill ? "min-h-0 flex-1" : "max-h-80"
      }`}
    >
      {lines.map((line, index) => {
        const kind = classifyDiffLine(line, inHunk);
        if (kind === "hunk") inHunk = true;
        return (
          <div key={index} className={`px-3 whitespace-pre ${STYLE[kind]}`}>
            {line.length > 0 ? line : " "}
          </div>
        );
      })}
    </div>
  );
}
