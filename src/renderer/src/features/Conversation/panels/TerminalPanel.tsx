// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 「终端」页签（⑦ 的可插拔视图之一）：xterm.js + 主进程 PTY 的交互终端。
 *
 * 生命周期与页签显隐**解耦**：PTY 锚定主进程（terminal-host），这里只是它的一扇
 * 窗——卸载只 dispose xterm 的 DOM，**不发 terminal.close**；关终端只发生在页签 ×
 * （closeDockInstance）/ 会话收口 / app 退出三处。切页签回来重挂，`terminal.open`
 * 的幂等回放（replay）把积压补上，不用重敲。
 *
 * seq 竞态：**先订阅 `terminal.output` 再 invoke open**，用 open 返回的 `nextSeq`
 * 丢弃先到的旧帧（`seq < nextSeq` 的内容已在 replay 里）。`nextSeqRef` 初始
 * `Infinity`：open 返回前一切帧都丢——它们必然已在 replay 里，丢了不丢数据。
 *
 * 头部自己画而不套 SidePanelShell：与浏览器 / 文件页签同一模式（内容型面板），
 * 且 SidePanelShell 的 `overflow-y-auto` 滚动容器会干扰 FitAddon 的尺寸测量。
 */
import { useEffect, useRef, useState } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Eraser, RotateCw, SquareTerminal } from "lucide-react";
import { ICON } from "@/lib/icon";
import "@xterm/xterm/css/xterm.css";

/** 与 styles.css 的 --font-mono 同一份清单（CSS 变量进不了 xterm 的 canvas，只能带字面量副本） */
const MONO_STACK = '"JetBrains Mono", "Cascadia Code", Consolas, ui-monospace, monospace';

/**
 * 挂载时从 CSS 变量读一次配色（跟随 data-theme）。已知局限：**主题切换不实时跟随**
 * （xterm 的 theme 不监听 CSS 变量变化，切主题要重挂页签才生效）——接受它，换来
 * 不写死色值；终端页签的存续通常短于一次换主题。
 */
function themeFromCss(): Pick<
  ITheme,
  "background" | "foreground" | "cursor" | "selectionBackground"
> {
  const css = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string): string => css.getPropertyValue(name).trim() || fallback;
  return {
    background: read("--color-surface-code", "#07090c"),
    foreground: read("--color-text-primary", "#e8ebf0"),
    cursor: read("--color-accent", "#c9ced6"),
    selectionBackground: "rgba(201, 206, 214, 0.22)",
  };
}

export function TerminalPanel({ sessionId }: { sessionId: string }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  /** open 返回前为 Infinity（丢弃一切帧）；open 之后是「该从这里开始收」的帧号 */
  const nextSeqRef = useRef<number>(Number.POSITIVE_INFINITY);
  /** shell 退出后置 true：显示「重新打开」覆盖层；重开通过 reopenToken 重走挂载流程 */
  const [exited, setExited] = useState(false);
  const [reopenToken, setReopenToken] = useState(0);
  /** open 成功后的 shell 名（头部 meta）；起不来则停在 null */
  const [shellName, setShellName] = useState<string | null>(null);
  /** 起不来终端的原因（node-pty 装载失败 / shell 一个都没有）；正常为 null */
  const [openError, setOpenError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    nextSeqRef.current = Number.POSITIVE_INFINITY;
    setExited(false);
    setOpenError(null);
    setShellName(null);

    const terminal = new Terminal({
      // 对齐代码区字号档（panels 里的 font-mono 均为 text-xs = 12px）
      fontSize: 12,
      fontFamily: MONO_STACK,
      cursorBlink: true,
      scrollback: 2000,
      theme: themeFromCss(),
    });
    terminalRef.current = terminal;
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    try {
      fit.fit();
    } catch {
      // 容器还没布局（宽高 0）：用默认 80x24 先开，ResizeObserver 到位后会校正
    }

    // ① 先订阅——晚于 open 的话，「订阅前 flush 出去的帧」就永远丢了
    const offOutput = window.colt.on("terminal.output", ({ sessionId: sid, data, seq }) => {
      if (sid !== sessionId) return;
      if (seq < nextSeqRef.current) return;
      nextSeqRef.current = seq + 1;
      terminal.write(data);
    });
    const offExit = window.colt.on("terminal.exit", ({ sessionId: sid, exitCode }) => {
      if (sid !== sessionId) return;
      setExited(true);
      if (exitCode !== 0) {
        terminal.write(`\r\n\x1b[31m[进程已退出，代码 ${exitCode ?? "未知"}]\x1b[0m\r\n`);
      }
    });

    terminal.onData((data) => {
      void window.colt.invoke("terminal.input", { sessionId, data });
    });
    // fit 之后 cols/rows 变了才上报（挂载时 open 已带初始尺寸，重复报是噪音）
    let lastCols = terminal.cols;
    let lastRows = terminal.rows;
    terminal.onResize(({ cols, rows }) => {
      if (cols === lastCols && rows === lastRows) return;
      lastCols = cols;
      lastRows = rows;
      void window.colt.invoke("terminal.resize", { sessionId, cols, rows });
    });

    // ② 再 open：幂等（切页签回来走这里，拿回放）；失败如实说（终端起不来 ≠ 应用坏了）
    void window.colt
      .invoke("terminal.open", { sessionId, cols: terminal.cols, rows: terminal.rows })
      .then(({ replay, nextSeq, shell }) => {
        nextSeqRef.current = nextSeq;
        setShellName(shell);
        if (replay !== "") terminal.write(replay);
        terminal.focus();
      })
      .catch((error: unknown) => {
        setOpenError(error instanceof Error ? error.message : String(error));
      });

    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // 布局中途（宽高 0）fit 会抛；下一次回调会再试
      }
    });
    observer.observe(host);

    // 卸载只清 DOM 与订阅——终端进程锚在主进程，切页签不杀（closeDockInstance 才杀）
    return () => {
      offOutput();
      offExit();
      observer.disconnect();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [sessionId, reopenToken]);

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col" data-terminal-panel>
      <div className="flex h-[var(--h-panel-head)] shrink-0 items-center justify-between border-b border-line px-3">
        <span className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
          <SquareTerminal {...ICON.sm} />
          终端
          {shellName !== null && (
            <span className="font-mono text-2xs text-text-muted">{shellName}</span>
          )}
        </span>
        <button
          type="button"
          title="清屏"
          onClick={() => terminalRef.current?.clear()}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-xs text-text-muted transition hover:bg-line-soft hover:text-text-primary"
        >
          <Eraser {...ICON.sm} />
        </button>
      </div>

      {/* 点头部以外任意处聚焦终端（xterm 自身点击即聚焦，这里兜住空白边距区） */}
      <div className="relative min-h-0 flex-1 bg-surface-code" onClick={() => terminalRef.current?.focus()}>
        <div ref={hostRef} className="h-full w-full p-1" />
        {openError !== null && (
          <div
            data-terminal-error
            className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface-code px-6 text-center"
          >
            <p className="text-xs leading-relaxed text-danger-fg">终端起不来：{openError}</p>
            <button
              type="button"
              onClick={() => setReopenToken((t) => t + 1)}
              className="flex items-center gap-1.5 rounded-xs border border-line px-2.5 py-1 text-xs text-text-secondary transition hover:bg-surface-overlay hover:text-text-primary"
            >
              <RotateCw {...ICON.sm} />
              重试
            </button>
          </div>
        )}
        {exited && openError === null && (
          <div
            data-terminal-exited
            className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface-code/95 px-6 text-center"
          >
            <p className="text-xs text-text-muted">终端已退出</p>
            <button
              type="button"
              onClick={() => setReopenToken((t) => t + 1)}
              className="flex items-center gap-1.5 rounded-xs border border-line px-2.5 py-1 text-xs text-text-secondary transition hover:bg-surface-overlay hover:text-text-primary"
            >
              <RotateCw {...ICON.sm} />
              重新打开
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
