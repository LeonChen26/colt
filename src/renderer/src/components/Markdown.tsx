/**
 * 助手回复的 Markdown 渲染。
 *
 * 结构交给 react-markdown + remark-gfm，代码高亮交给 rehype-highlight，
 * 颜色统一走 styles.css 里的 --color-code-* 令牌（低饱和，与主题联动）。
 * 代码块带语言标签与复制按钮，复制读的是渲染后的文本，避免与高亮节点耦和。
 */
import { Children, isValidElement, useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Check, Copy } from "lucide-react";
import { ICON } from "@/lib/icon";

/** 行内代码 */
function InlineCode({ children }: { children?: ReactNode }): React.JSX.Element {
  return <code className="md-code">{children}</code>;
}

/** 围栏代码块：语言标签 + 复制按钮 + 高亮后的代码 */
function CodeBlock({ children }: { children?: ReactNode }): React.JSX.Element {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  // react-markdown 会把 <code class="language-xxx"> 作为唯一子元素传进来
  const child = Children.toArray(children)[0];
  const className =
    isValidElement<{ className?: string }>(child) ? child.props.className ?? "" : "";
  const language = /language-([\w-]+)/.exec(className)?.[1] ?? "";

  // 「已复制」的复位交给 effect：定时器挂在组件上，卸载时一并清掉。
  // 写在 copy() 里的话，复制完立刻切走消息，1.5s 后会对着一个已卸载的组件 setState。
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = (): void => {
    const text = preRef.current?.textContent ?? "";
    void navigator.clipboard.writeText(text).then(() => setCopied(true));
  };

  return (
    <div className="md-code-block">
      <div className="md-code-head">
        <span className="lang">{language || "text"}</span>
        <button type="button" className="copy" onClick={copy} title="复制代码">
          {copied ? <Check {...ICON.xs} /> : <Copy {...ICON.xs} />}
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre ref={preRef}>{children}</pre>
    </div>
  );
}

const COMPONENTS: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  // 行内代码不带 language-* 类，交给 InlineCode；代码块内的 code 已在 pre 里处理
  code: ({ node, className, children, ...props }) => {
    void node;
    if (typeof className === "string" && className.includes("language-")) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    }
    return <InlineCode>{children}</InlineCode>;
  },
  // 链接交给系统浏览器打开（主进程 setWindowOpenHandler 已接管）
  a: ({ node, ...props }) => {
    void node;
    return <a {...props} target="_blank" rel="noreferrer" />;
  },
};

export function Markdown({ children }: { children: string }): React.JSX.Element {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={COMPONENTS}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
