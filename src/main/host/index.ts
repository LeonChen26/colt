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

  async handle(request: HostRequest): Promise<HostResult> {
    switch (request.capability) {
      case "browser":
        return this.#browser.handle(request.sessionId, request.action, request.params);
      case "computer":
        return this.#computer.handle(request.sessionId, request.action, request.params);
      case "memory":
        return this.#memory.handle(request.sessionId, request.action, request.params);
      default:
        throw new Error(`未知的宿主能力：${String(request.capability)}`);
    }
  }

  disposeSession(sessionId: string): void {
    this.#browser.closeSession(sessionId);
    this.#computer.resetSession(sessionId);
    this.#memory.clearSession(sessionId);
  }

  disposeAll(): void {
    this.#browser.disposeAll();
  }
}

export const hostBridge = new HostBridge();
