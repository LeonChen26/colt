/**
 * 按文件格式渲染的**代码 / 文本**视图（文件内容层里非 Markdown 的那一半）。
 *
 * 它替掉原先那个裸 `<pre>`——差别就是「按格式」这三个字：
 *   1. 由扩展名认出语言（`lib/code-lang.ts`，纯函数、可单测），交给 highlight.js 着色；
 *   2. 左侧行号槽，长行横向滚动时**不动**（`position: sticky`）；
 *   3. 认不出语言、或语言不在 common 包里、或着色抛错，一律**原样等宽显示**——
 *      宁可没有颜色，也不猜一个语言然后画错（同内容层「不做半截渲染」的理由）。
 *
 * 配色复用 `.md` 围栏代码块那套令牌（`styles.css` 里 `:is(.md, .code-view) .hljs-*`），
 * 所以助手回复里的代码块与文件预览的同一段代码不会出现两种颜色。
 */
import { useMemo } from "react";
import hljs from "highlight.js/lib/common";
import { detectLanguage } from "@/lib/code-lang";

/**
 * 超过这个字符数就只按纯文本显示（仍有行号）。
 * highlight.js 是同步的，1MB（`file-read.ts` 的文本上限）能把它卡住几秒并**阻塞渲染**，
 * 而真实源码极少超过这个量级；与其为了罕见的巨型文件冻住界面，不如放弃着色。
 */
const HIGHLIGHT_LIMIT = 300_000;

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function CodeView({ path, text }: { path: string; text: string }): React.JSX.Element {
  const { html, gutter } = useMemo(() => {
    const language = detectLanguage(path);
    // 末尾换行不算一行，否则行号槽会多出一个空号
    const source = text.endsWith("\n") ? text.slice(0, -1) : text;
    const lines = source.split("\n");

    let body: string;
    if (language !== null && source.length <= HIGHLIGHT_LIMIT) {
      try {
        body = hljs.highlight(source, { language, ignoreIllegals: true }).value;
      } catch (error) {
        // 着色失败不该让内容看不见（退回转义后的原文），但**不能静默**：
        // 静默回落与「这个文件本来就没颜色」在界面上长得一模一样，
        // 一旦 highlight.js 的调用方式失效（升级、打包 interop），这里就是唯一的证据。
        console.error(`[code-view] 着色失败，已退回纯文本：${path}`, error);
        body = escapeHtml(source);
      }
    } else {
      body = escapeHtml(source);
    }

    // 行号拼成一整段文本（一个文本节点），而不是每行一个元素——
    // 大文件几万行时，几万个 DOM 节点比着色本身还贵
    const numbers = lines.map((_, index) => index + 1).join("\n");
    return { html: body, gutter: numbers };
  }, [path, text]);

  return (
    <div className="code-view min-h-0 flex-1" data-file-text>
      <div className="gutter" aria-hidden="true">
        {gutter}
      </div>
      <pre>
        <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}
