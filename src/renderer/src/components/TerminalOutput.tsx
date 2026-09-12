/**
 * 终端输出视图：解析 ANSI SGR 转义序列，渲染带颜色的日志
 * pi 的 bash 工具是「执行并流式返回合并输出」，不是交互式 PTY，
 * 所以这里用轻量自绘而非 xterm.js
 * 作者：陕耀云栈WorkMate
 */
import { useMemo } from "react";

interface Span {
  text: string;
  className: string;
}

/** ANSI 前景色 30-37 / 亮色 90-97 */
const FG: Record<number, string> = {
  30: "text-neutral-600",
  31: "text-red-400",
  32: "text-green-400",
  33: "text-yellow-400",
  34: "text-blue-400",
  35: "text-purple-400",
  36: "text-cyan-400",
  37: "text-neutral-200",
  90: "text-neutral-500",
  91: "text-red-300",
  92: "text-green-300",
  93: "text-yellow-300",
  94: "text-blue-300",
  95: "text-purple-300",
  96: "text-cyan-300",
  97: "text-white",
};

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001B\[([0-9;]*)m/g;

/** 把带 ANSI 转义的文本切成样式片段 */
function parseAnsi(input: string): Span[] {
  const spans: Span[] = [];
  let cursor = 0;
  let className = "";

  for (const match of input.matchAll(ANSI_PATTERN)) {
    const index = match.index;
    if (index > cursor) spans.push({ text: input.slice(cursor, index), className });
    cursor = index + match[0].length;

    const codes = (match[1] ?? "").split(";").filter((part) => part.length > 0);
    if (codes.length === 0) {
      className = "";
      continue;
    }
    for (const raw of codes) {
      const code = Number(raw);
      if (code === 0) className = "";
      else if (code === 1) className = `${className} font-bold`.trim();
      else if (FG[code]) className = `${className.replace(/text-\S+/g, "").trim()} ${FG[code]}`.trim();
    }
  }

  if (cursor < input.length) spans.push({ text: input.slice(cursor), className });
  return spans;
}

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
