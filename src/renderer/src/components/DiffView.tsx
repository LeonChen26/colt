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
  return (
    <div className="overflow-auto rounded-[6px] border border-line bg-surface-code font-mono text-[11.5px] leading-relaxed">
      {lines.map((line, index) => {
        const kind = classifyDiffLine(line);
        return (
          <div key={index} className={`px-3 whitespace-pre ${STYLE[kind]}`}>
            {line.length > 0 ? line : " "}
          </div>
        );
      })}
    </div>
  );
}
