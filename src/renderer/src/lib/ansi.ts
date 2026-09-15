/**
 * ANSI SGR 转义序列解析：把带颜色标记的终端输出切成可渲染的样式片段。
 * pi 的 bash 工具是「执行并流式返回合并输出」，不是交互式 PTY，
 * 因此这里只需解析 SGR，无需完整终端仿真。
 */

export interface AnsiSpan {
  text: string;
  className: string;
}

/** ANSI 前景色 30-37 / 亮色 90-97 → Tailwind 类名 */
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
const ANSI_PATTERN = /\u001B\[([0-9;]*)m|\u001B\[[0-9;]*[A-Za-z]|\u001B\][^\u0007]*\u0007/g;

/** 把带 ANSI 转义的文本切成样式片段 */
export function parseAnsi(input: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  let cursor = 0;
  let className = "";

  for (const match of input.matchAll(ANSI_PATTERN)) {
    const index = match.index;
    if (index > cursor) spans.push({ text: input.slice(cursor, index), className });
    cursor = index + match[0].length;

    // 非 SGR 序列（光标控制 [2K/[1G、OSC 标题等）只剥离不应用样式：
    // 否则 ESC 控制字符在 HTML 里不可见，用户看到的是正文里混着「[2K[1G」的字面垃圾。
    if (match[1] === undefined) continue;

    const codes = match[1].split(";").filter((part) => part.length > 0);
    if (codes.length === 0) {
      className = "";
      continue;
    }
    for (const raw of codes) {
      const code = Number(raw);
      if (code === 0) className = "";
      else if (code === 1) className = `${className} font-bold`.trim();
      // 22 = bold off、39 = 默认前景色：npm 等大量用「1m…22m」包步骤名，
      // 不处理 22 会让第一次加粗之后的所有输出全部残留粗体。
      else if (code === 22) className = className.replace(/font-bold/g, "").trim();
      else if (code === 39) className = className.replace(/text-\S+/g, "").trim();
      else if (FG[code]) className = `${className.replace(/text-\S+/g, "").trim()} ${FG[code]}`.trim();
    }
  }

  if (cursor < input.length) spans.push({ text: input.slice(cursor), className });
  return spans;
}
