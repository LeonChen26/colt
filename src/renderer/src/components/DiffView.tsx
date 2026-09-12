/**
 * Unified patch 渲染：按行着色。
 * 分类逻辑见 lib/diff.ts（纯函数，可单测）。
 * 作者：陕耀云栈WorkMate
 */
import { classifyDiffLine, type DiffLineKind } from "../lib/diff";

const STYLE: Record<DiffLineKind, string> = {
  add: "bg-green-500/12 text-green-300",
  remove: "bg-red-500/12 text-red-300",
  hunk: "bg-blue-500/12 text-blue-300",
  meta: "text-[--color-text-muted]",
  context: "text-[--color-text-secondary]",
};

export function DiffView({ patch }: { patch: string }): React.JSX.Element {
  const lines = patch.split("\n");
  return (
    <div className="overflow-auto rounded-md border border-[--color-border-subtle] bg-black/40 font-mono text-xs leading-relaxed">
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
