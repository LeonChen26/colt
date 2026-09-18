// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 终端输出视图：渲染带颜色的日志。
 * ANSI 解析逻辑见 lib/ansi.ts（纯函数，可单测）。
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
      className={`overflow-auto rounded-[6px] bg-surface-code px-3 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-text-secondary ${className}`}
    >
      {spans.map((span, index) => (
        <span key={index} className={span.className || undefined}>
          {span.text}
        </span>
      ))}
    </pre>
  );
}
