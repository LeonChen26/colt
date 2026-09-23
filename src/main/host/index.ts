// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 宿主能力路由：把 worker 发来的 toolRpc 分发到对应的宿主实现。
 *
 * 这是「worker 持 Agent、main 持能力」之间的唯一入口。新增能力（如桌面控制）只需
 * 在这里加一个分支与一个 host 模块，worker 侧的契约保持不变。
 */
import type { BrowserNavAction, BrowserObservation, BrowserViewState } from "@shared/protocol";
import type { HostCapability, HostResult } from "@shared/worker-protocol";
import type { BrowserWindow } from "electron";
import { BrowserHost, type BrowserNavigation } from "./browser-host";
import { ComputerHost } from "./computer-host";
import { MemoryHost } from "./memory-host";
import {
  TerminalHost,
  type TerminalExitEvent,
  type TerminalOutputEvent,
} from "../terminal-host";
import { todoStore } from "../todo-store";

export interface HostRequest {
  sessionId: string;
  capability: HostCapability;
  action: string;
  params: Record<string, unknown>;
}

export class HostBridge {
  readonly #browser = new BrowserHost();
  readonly #computer = new ComputerHost();
  readonly #memory = new MemoryHost();
  readonly #terminal = new TerminalHost();

  /**
   * 内嵌浏览器需要宿主窗口才能挂 WebContentsView，故主进程建窗后必须登记。
   * 与 sessionManager.attachWindow 同源，两处都要传。
   */
  attachWindow(window: BrowserWindow): void {
    this.#browser.attachWindow(window);
  }

  /** 起会话进程时登记 cwd，记忆检索的项目隔离据此判定（见 memory-host.ts） */
  setMemoryContext(sessionId: string, cwd: string): void {
    this.#memory.setContext(sessionId, cwd);
  }

  /** 订阅内嵌浏览器视图状态（由 sessionManager 转成 browser.state 推给渲染层） */
  onBrowserState(listener: (state: BrowserViewState) => void): void {
    this.#browser.onState(listener);
  }

  /** 渲染层上报页面区域矩形（null = 当前不可见） */
  setBrowserBounds(sessionId: string, rect: Parameters<BrowserHost["setBounds"]>[1]): void {
    this.#browser.setBounds(sessionId, rect);
  }

  /** 读取会话的内嵌浏览器状态；null = 该会话没有浏览器视图（常态缺省，不是错误） */
  browserState(sessionId: string): BrowserViewState | null {
    return this.#browser.stateOf(sessionId);
  }

  /** 用户手动导航（B1）：后退 / 前进 / 刷新 */
  browserNavigate(sessionId: string, action: BrowserNavAction): BrowserNavigation {
    return this.#browser.navigate(sessionId, action);
  }

  /** 撤销 agent 留下的视口联调覆盖（用户在浏览器头部点「恢复」） */
  browserResetViewport(sessionId: string): BrowserViewState {
    return this.#browser.resetViewport(sessionId);
  }

  /** 开 / 关「适应宽度」（用户点装不下那条横条上的按钮，或点头部的缩放指示还原） */
  browserSetZoom(sessionId: string, fit: boolean): BrowserViewState {
    return this.#browser.setZoom(sessionId, fit);
  }

  /** 读取会话的浏览器观测快照（B2：控制台 / 网络 / 下载） */
  browserObservation(sessionId: string): BrowserObservation {
    return this.#browser.observe(sessionId);
  }

  /** 订阅终端输出帧（由 sessionManager 转成 terminal.output 推给渲染层） */
  onTerminalOutput(listener: (event: TerminalOutputEvent) => void): void {
    this.#terminal.onOutput(listener);
  }

  /** 订阅终端退出（同上，转 terminal.exit） */
  onTerminalExit(listener: (event: TerminalExitEvent) => void): void {
    this.#terminal.onExit(listener);
  }

  /** 终端是否还活着（冒烟用：关页签后 PTY 真死 / 重开真活） */
  terminalAlive(sessionId: string): boolean {
    return this.#terminal.isAlive(sessionId);
  }

  /**
   * 打开（或复用）会话终端。cwd 只由主进程按 sessionId → 项目推出
   * （与 file.read 同一套信任假设），渲染层不能指定。
   */
  terminalOpen(
    sessionId: string,
    cwd: string,
    cols: number,
    rows: number,
  ): { replay: string; nextSeq: number; shell: string } {
    return this.#terminal.open(sessionId, cwd, cols, rows);
  }

  /** 往终端写输入（页签里的键入 / 粘贴） */
  terminalInput(sessionId: string, data: string): void {
    this.#terminal.input(sessionId, data);
  }

  /** 终端视口尺寸变化（FitAddon 上报） */
  terminalResize(sessionId: string, cols: number, rows: number): void {
    this.#terminal.resize(sessionId, cols, rows);
  }

  /** 关掉终端：页签 × 传 notify=false（面板正在卸载）；系统收口见 disposeSession */
  terminalClose(sessionId: string, notify = false): void {
    this.#terminal.close(sessionId, notify);
  }

  async handle(request: HostRequest): Promise<HostResult> {
    switch (request.capability) {
      case "browser":
        return this.#browser.handle(request.sessionId, request.action, request.params);
      case "computer":
        return this.#computer.handle(request.sessionId, request.action, request.params);
      case "memory":
        return this.#memory.handle(request.sessionId, request.action, request.params);
      case "todo":
        // 待办清单的**唯一写入方**在 `todo-store.ts`（真源是 SQLite 的 todos 表）；
        // 这里只是一跳转发，与 browser / computer / memory 保持同一形态
        return todoStore.handle(request.sessionId, request.action, request.params);
      default:
        throw new Error(`未知的宿主能力：${String(request.capability)}`);
    }
  }

  disposeSession(sessionId: string): void {
    this.#browser.closeSession(sessionId);
    this.#computer.resetSession(sessionId);
    this.#memory.clearSession(sessionId);
    // 终端与页签显隐解耦（切页签不杀），会话收口是它的第二处出口。notify=true：
    // 面板可能还开着（空闲回收走的就是这条链），必须让它可见地退出而不是假活
    this.#terminal.close(sessionId, true);
    // todo 无需清理：它没有会话级内存——清单的真源是库，缓存归 session-manager 管
    // （与 `#fileChangesCache` 同一套寿命规则），在这里再存一份才是多余的
  }

  disposeAll(): void {
    this.#browser.disposeAll();
    this.#terminal.disposeAll();
  }
}

export const hostBridge = new HostBridge();
