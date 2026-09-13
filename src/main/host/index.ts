/**
 * 宿主能力路由：把 worker 发来的 toolRpc 分发到对应的宿主实现。
 *
 * 这是「worker 持 Agent、main 持能力」之间的唯一入口。新增能力（如桌面控制）只需
 * 在这里加一个分支与一个 host 模块，worker 侧的契约保持不变。
 */
import type { BrowserViewState } from "@shared/protocol";
import type { HostCapability, HostResult } from "@shared/worker-protocol";
import type { BrowserWindow } from "electron";
import { BrowserHost } from "./browser-host";
import { ComputerHost } from "./computer-host";

export interface HostRequest {
  sessionId: string;
  capability: HostCapability;
  action: string;
  params: Record<string, unknown>;
}

export class HostBridge {
  readonly #browser = new BrowserHost();
  readonly #computer = new ComputerHost();

  /**
   * 内嵌浏览器需要宿主窗口才能挂 WebContentsView，故主进程建窗后必须登记。
   * 与 sessionManager.attachWindow 同源，两处都要传。
   */
  attachWindow(window: BrowserWindow): void {
    this.#browser.attachWindow(window);
  }

  /** 订阅内嵌浏览器视图状态（由 sessionManager 转成 browser.state 推给渲染层） */
  onBrowserState(listener: (state: BrowserViewState) => void): void {
    this.#browser.onState(listener);
  }

  /** 渲染层上报页面区域矩形（null = 当前不可见） */
  setBrowserBounds(sessionId: string, rect: Parameters<BrowserHost["setBounds"]>[1]): void {
    this.#browser.setBounds(sessionId, rect);
  }

  /** 读取会话的内嵌浏览器状态 */
  browserState(sessionId: string): BrowserViewState {
    return this.#browser.stateOf(sessionId);
  }

  async handle(request: HostRequest): Promise<HostResult> {
    switch (request.capability) {
      case "browser":
        return this.#browser.handle(request.sessionId, request.action, request.params);
      case "computer":
        return this.#computer.handle(request.sessionId, request.action, request.params);
      default:
        throw new Error(`未知的宿主能力：${String(request.capability)}`);
    }
  }

  disposeSession(sessionId: string): void {
    this.#browser.closeSession(sessionId);
    this.#computer.resetSession(sessionId);
  }

  disposeAll(): void {
    this.#browser.disposeAll();
  }
}

export const hostBridge = new HostBridge();
