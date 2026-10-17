// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * Mermaid 图块的渲染（只在「Wiki」页签里用）。
 *
 * ## 为什么是动态 import
 *
 * mermaid 是 MB 级依赖（npm 包解包 100MB+，产物 chunk 也是数 MB），
 * 而它只服务「Wiki」这一个页签。静态 import 会把它塞进首屏包，让每个用户
 * 为不看的图付启动成本。这里按需加载、只加载一次（模块级 `loader` 缓存）。
 *
 * ## 为什么用 `securityLevel: "strict"`
 *
 * 页面正文是**模型写的**，Mermaid 标签里可以塞 HTML。strict 模式下 mermaid 用
 * DOMPurify 清洗标签，`dangerouslySetInnerHTML` 只喂清洗后的 SVG——不加这层，
 * 一份被污染的 wiki 页就能在渲染进程里执行脚本。
 *
 * 加载失败 / 语法错误一律**降级成源码块**并说明原因：wiki 图坏了不该让整页白屏
 * （`docs/ERRORS.md` 的「失败必须可见」，可见 ≠ 整页崩掉）。
 */
import { useEffect, useId, useState } from "react";

/** 只取本组件用到的两个方法（mermaid 的类型导出很重，不引） */
interface MermaidApi {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, text: string) => Promise<{ svg: string }>;
}

let loader: Promise<MermaidApi> | null = null;

/** 当前主题：`data-theme` 由 `lib/theme.ts` 挂在 <html> 上；system 时问系统 */
function themeName(): "dark" | "default" {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "light") return "default";
  if (attr === "dark") return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "default" : "dark";
}

function loadMermaid(): Promise<MermaidApi> {
  if (loader === null) {
    loader = import("mermaid").then((mod) => {
      const api = (mod.default ?? mod) as unknown as MermaidApi;
      api.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: themeName(),
        fontFamily: "inherit",
      });
      return api;
    });
    // 失败不缓存：下次展开同一页时重试（网络/打包问题修好后不必重启应用）
    loader.catch(() => {
      loader = null;
    });
  }
  return loader;
}

export function MermaidBlock({ code }: { code: string }): React.JSX.Element {
  const reactId = useId();
  // mermaid 要求 id 是合法 CSS 选择器片段；React 的 useId 带冒号，换掉
  const elementId = `mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setSvg(null);
    setError(null);
    loadMermaid()
      .then((api) => api.render(elementId, code))
      .then((result) => {
        if (alive) setSvg(result.svg);
      })
      .catch((reason: unknown) => {
        if (alive) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      alive = false;
    };
  }, [code, elementId]);

  if (error !== null) {
    return (
      <div className="my-2 rounded-md border border-line bg-surface-overlay p-2">
        <div className="mb-1 text-2xs text-warning">这张图渲染失败：{error}</div>
        <pre className="overflow-x-auto text-2xs leading-relaxed text-text-muted">{code}</pre>
      </div>
    );
  }
  if (svg === null) {
    return (
      <div className="my-2 rounded-md border border-line bg-surface-overlay px-2 py-3 text-center text-2xs text-text-muted">
        图渲染中…
      </div>
    );
  }
  return (
    <div
      className="wiki-mermaid my-2 overflow-x-auto rounded-md border border-line bg-surface-overlay p-2"
      // 内容来自 mermaid 的 strict 渲染（DOMPurify 清洗过），见文件头
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
