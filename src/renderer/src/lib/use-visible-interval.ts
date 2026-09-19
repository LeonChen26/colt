// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * `createVisibleInterval` 的 React 包装：页面不可见时暂停的 `setInterval`（F11）。
 *
 * 用法与裸 `useEffect` + `setInterval` 一一对应：
 *
 *   useVisibleInterval(() => setNow(Date.now()), 1000);
 *   useVisibleInterval(report, 400, showArea && loaded);   // active 控制开关
 *
 * 回调永远走 ref 取最新值，不列入依赖——与「回调变了就重启定时器」的直觉相反，
 * 这里的周期与可见性才是生命周期，回调内容不是（语义与差异见 visible-interval.ts）。
 */
import { useEffect, useRef } from "react";
import { createVisibleInterval, type IntervalEnvironment } from "./visible-interval";

const domEnvironment: IntervalEnvironment = {
  setInterval: (callback, intervalMs) => window.setInterval(callback, intervalMs),
  clearInterval: (handle) => window.clearInterval(handle as number),
  isHidden: () => document.hidden,
  onVisibilityChange: (listener) => {
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  },
};

export function useVisibleInterval(
  callback: () => void,
  intervalMs: number,
  active = true,
): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  useEffect(() => {
    if (!active) return;
    return createVisibleInterval(() => callbackRef.current(), intervalMs, domEnvironment);
  }, [intervalMs, active]);
}
