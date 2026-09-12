/**
 * 终端输出视图：渲染带颜色的日志。
 * ANSI 解析逻辑见 lib/ansi.ts（纯函数，可单测）。
 * 作者：陕耀云栈WorkMate
 */
import { useMemo } from "react";
import { parseAnsi } from "../lib/ansi";

export function TerminalOutput({
  text,
  className = "",
}: {
  text: string;
  className?: string;
}): React.JSX.Element {
  const spans = useMemo(() => parseAnsi(text), [text]);
  return (
    <pre
      className={`overflow-auto rounded-md bg-black/50 px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap ${className}`}
    >
      {spans.map((span, index) => (
        <span key={index} className={span.className || undefined}>
          {span.text}
        </span>
      ))}
    </pre>
  );
}
