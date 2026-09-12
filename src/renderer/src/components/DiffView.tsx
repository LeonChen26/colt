/**
 * Unified patch 渲染：edit 工具的 details.patch 已是标准 unified diff，
 * 直接按行着色即可，无需引入 Monaco（它需要 original+modified 全文）
 * 作者：陕耀云栈WorkMate
 */
type LineKind = "add" | "remove" | "hunk" | "meta" | "context";

function classify(line: string): LineKind {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "remove";
  return "context";
}

const STYLE: Record<LineKind, string> = {
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
        const kind = classify(line);
        return (
          <div key={index} className={`px-3 whitespace-pre ${STYLE[kind]}`}>
            {line.length > 0 ? line : " "}
          </div>
        );
      })}
    </div>
  );
}
