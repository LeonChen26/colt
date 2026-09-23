// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 会话级交互终端的宿主（「终端」页签的主进程侧）。
 *
 * **生命周期锚定主进程**，与页签的显隐解耦：切页签不杀（渲染层三元链会卸载重挂，
 * StrictMode 下还双挂载——终端若跟着页签死，每次切走都丢会话）；关掉只发生在
 * 三个收口：页签 ×（terminal.close）、会话 dispose（hostBridge.disposeSession）、
 * app 退出（disposeAll）。
 *
 * 回放与合帧：PTY 输出是高频小 chunk（一次 `ls` 能来几十段），逐段 `webContents.send`
 * 既贵又会把渲染层的事件队列灌爆。这里攒 **16ms** 合成一帧；同时维护 **64KB** 环形
 * 缓冲（超限丢头部）——`terminal.open` 的 `replay` 就是它，切页签回来不用重敲。
 *
 * seq 竞态：渲染层**先订阅** `terminal.output` 再 invoke open。订阅到 open 返回
 * 之间 flush 出去的帧会先到，渲染层拿 open 返回的 `nextSeq` 丢弃 `seq < nextSeq`
 * 的帧——它们的内容已在 replay 里，丢了不丢数据。
 */
import { spawnSync } from "node:child_process";
import { advanceFeed, FLUSH_MS, type FeedState } from "./terminal-feed";
import { buildPtyOptions, loadPty, pickShell, type IPty } from "./terminal-pty";

interface TerminalSession extends FeedState {
  pty: IPty;
  shell: string;
  /** 合帧中的积压（尚未计入 buffer / seq） */
  pending: string;
  flushTimer: NodeJS.Timeout | undefined;
}

export interface TerminalOutputEvent {
  sessionId: string;
  data: string;
  seq: number;
}

export interface TerminalExitEvent {
  sessionId: string;
  exitCode: number | null;
}

export class TerminalHost {
  readonly #sessions = new Map<string, TerminalSession>();
  #onOutput: ((event: TerminalOutputEvent) => void) | undefined;
  #onExit: ((event: TerminalExitEvent) => void) | undefined;
  /** 探测结果缓存：「哪有 shell」对一台机器是常量，别为每次开页签都阻塞一次主进程 */
  static #shell: string | undefined;

  /** 注册输出回调（由 HostBridge 接到 sessionManager 的推送出口）；以最后一次为准 */
  onOutput(listener: (event: TerminalOutputEvent) => void): void {
    this.#onOutput = listener;
  }

  /** 注册退出回调（同上） */
  onExit(listener: (event: TerminalExitEvent) => void): void {
    this.#onExit = listener;
  }

  /**
   * 打开（或复用）会话终端。**幂等**：已开就回积压，不另起一个 shell——
   * 渲染层重挂（切页签回来 / StrictMode 双挂载）都会再 open 一次。
   */
  open(
    sessionId: string,
    cwd: string,
    cols: number,
    rows: number,
  ): { replay: string; nextSeq: number; shell: string } {
    const existing = this.#sessions.get(sessionId);
    if (existing !== undefined) {
      this.resize(sessionId, cols, rows);
      return { replay: existing.buffer, nextSeq: existing.seq + 1, shell: existing.shell };
    }

    const shell = TerminalHost.#pickShell();
    const pty = loadPty().spawn(shell, [], buildPtyOptions(cwd, cols, rows));
    const entry: TerminalSession = { pty, shell, buffer: "", seq: -1, pending: "", flushTimer: undefined };
    this.#sessions.set(sessionId, entry);

    pty.onData((chunk: string) => {
      entry.pending += chunk;
      if (entry.flushTimer === undefined) {
        entry.flushTimer = setTimeout(() => this.#flush(sessionId), FLUSH_MS);
      }
    });
    // 自己退出（用户敲 exit / shell 崩了）：close() 已先把 entry 删掉，这里的
    // 查无此人是「我们杀的」，不重复推 exit；查得到才是真退出。
    pty.onExit(({ exitCode }: { exitCode: number | undefined }) => {
      const current = this.#sessions.get(sessionId);
      if (current !== entry) return;
      this.#stopTimer(current);
      this.#sessions.delete(sessionId);
      this.#emitExit(sessionId, exitCode ?? null);
    });

    return { replay: "", nextSeq: 0, shell };
  }

  /** 往终端写输入；没开就静默丢弃（页签关了还写，只能是想串台） */
  input(sessionId: string, data: string): void {
    const entry = this.#sessions.get(sessionId);
    if (entry === undefined) return;
    entry.pty.write(data);
  }

  /** 视口尺寸变化；没开就静默丢弃（同上） */
  resize(sessionId: string, cols: number, rows: number): void {
    const entry = this.#sessions.get(sessionId);
    if (entry === undefined) return;
    try {
      entry.pty.resize(Math.max(2, Math.floor(cols)), Math.max(2, Math.floor(rows)));
    } catch {
      // pty 已死但 onExit 还没到（Windows 上 TerminateProcess 有延迟）：忽略这次
    }
  }

  /**
   * 关掉终端；没开也是正常（幂等收口，三处都会调到这里）。
   *
   * `notify`：系统收口（会话 dispose / 空闲回收）时面板**可能还开着**——推一次
   * `terminal.exit` 让它显示「已退出」覆盖层，否则终端假活（敲键被静默丢弃、
   * 界面毫无提示）。页签 × 的路径传 false：面板正在卸载，通知没有听众。
   */
  close(sessionId: string, notify = false): void {
    const entry = this.#sessions.get(sessionId);
    if (entry === undefined) return;
    // 先删再杀：onExit 回调查不到 entry，就不会把「我们杀的」当成「它自己退了」推出去
    this.#sessions.delete(sessionId);
    this.#stopTimer(entry);
    if (notify) this.#emitExit(sessionId, null);
    try {
      entry.pty.kill();
    } catch {
      // 已死：TerminateProcess 对已退出进程抛错，无需处理
    }
  }

  /** 终端是否还活着（冒烟断言「关页签后 PTY 真死 / 重开真活」用） */
  isAlive(sessionId: string): boolean {
    return this.#sessions.has(sessionId);
  }

  disposeAll(): void {
    for (const sessionId of [...this.#sessions.keys()]) this.close(sessionId);
  }

  #flush(sessionId: string): void {
    const entry = this.#sessions.get(sessionId);
    if (entry === undefined) return;
    entry.flushTimer = undefined;
    if (entry.pending === "") return;
    // 推进（帧号 / 缓冲截头）走纯函数 advanceFeed，数据不变量由单测钉死
    const next = advanceFeed(entry, entry.pending);
    entry.pending = "";
    entry.buffer = next.buffer;
    entry.seq = next.seq;
    if (this.#onOutput !== undefined) {
      this.#onOutput({ sessionId, data: next.frame.data, seq: next.frame.seq });
    }
  }

  #stopTimer(entry: TerminalSession): void {
    if (entry.flushTimer !== undefined) {
      clearTimeout(entry.flushTimer);
      entry.flushTimer = undefined;
    }
  }

  #emitExit(sessionId: string, exitCode: number | null): void {
    if (this.#onExit !== undefined) {
      this.#onExit({ sessionId, exitCode });
    }
  }

  /** 探测一次，之后一直用（spawnSync 探测阻塞主进程百毫秒级；pwsh 缺席时往往要连探两次） */
  static #pickShell(): string {
    if (TerminalHost.#shell === undefined) {
      TerminalHost.#shell = pickShell(TerminalHost.#shellExists);
    }
    return TerminalHost.#shell;
  }

  /** shell 是否找得到（PATH 探测）。static 便于单测绕开真实探测 */
  static #shellExists(exe: string): boolean {
    const probe =
      process.platform === "win32"
        ? spawnSync("where", [exe], { encoding: "utf8" })
        : spawnSync("which", [exe], { encoding: "utf8" });
    return probe.status === 0;
  }
}
