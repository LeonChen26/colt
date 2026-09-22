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

export function DiffView({ patch }: { patch: string }): React.JSX.Element {
  const lines = patch.split("\n");
  // 是否已进入 hunk：hunk 内的 `---` / `+++` 是正文行（见 classifyDiffLine 的说明）
  let inHunk = false;
  return (
    // max-h 与工具输出区一致：大 patch（lockfile / 生成文件）一次性全量渲染，
    // 不设上限会把消息流撑出上万像素高度，也拖慢首次渲染
    <div className="max-h-80 overflow-auto rounded-sm border border-line bg-surface-code font-mono text-[11.5px] leading-relaxed">
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
