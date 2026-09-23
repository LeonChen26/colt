// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 弹窗（新窗口请求）的接管——从 `browser-host.ts` 的 `#viewFor` 整体搬出。
 *
 * 原来是两个闭包共用一个局部变量 `pendingAdopt` 协调：
 *   - `setWindowOpenHandler` 决定「不开新窗口，改在当前视图打开」，并把提示写进捕获缓冲；
 *   - `did-start-navigation` 的 reset 会把这条提示抹掉，于是先挂号、reset 后重放。
 * 搬出来后协调状态收进本类，宿主在两处各留一行委托。行为逐字保留。
 */
import { shouldAdoptPopup, type CaptureBuffer } from "./browser-observe";

export class PopupAdopter {
  /** 已在当前视图接管的待重放提示；did-start-navigation 的 reset 之后取走 */
  #pending: { url: string } | undefined;

  /**
   * 新窗口请求的统一处置：一律不开新窗口。
   *
   * 默认行为会生出一个不受宿主管辖的窗口——读不到、disposeAll 也回收不掉，
   * 而 agent 后续的 snapshot/text 仍停在旧页面上，表现为「点了没反应」。
   * 改为在当前视图接管；接管与否记一条 info 到控制台缓冲
   * （这里没有独立的通知通道，靠文案自证来源）。
   */
  handleWindowOpen(
    details: { url: string },
    capture: CaptureBuffer,
    load: (url: string) => Promise<void>,
  ): { action: "deny" } {
    if (!shouldAdoptPopup(details.url)) {
      capture.recordConsole({
        level: "info",
        message: `已拦截非 http(s) 的新窗口请求：${details.url}`,
        source: details.url,
        line: 0,
      });
      return { action: "deny" };
    }
    capture.reset();
    capture.recordConsole({
      level: "info",
      message: `拦截新窗口请求，已在当前窗口打开：${details.url}`,
      source: details.url,
      line: 0,
    });
    // 上面那条提示随后会被 did-start-navigation 的 reset 抹掉，先挂号、reset 后重放；
    // 若导航根本没能开始（loadURL 直接失败），缓冲里还留着这条，线索不丢
    this.#pending = { url: details.url };
    void load(details.url).catch(() => undefined);
    return { action: "deny" };
  }

  /** 取回挂号中的接管提示（reset 之后由调用方重放进捕获缓冲）；没有挂号则无操作 */
  drainAdopted(capture: CaptureBuffer): void {
    const adopt = this.#pending;
    this.#pending = undefined;
    if (adopt === undefined) return;
    capture.recordConsole({
      level: "info",
      message: `拦截新窗口请求，已在当前窗口打开：${adopt.url}`,
      source: adopt.url,
      line: 0,
    });
  }
}
