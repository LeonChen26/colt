// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 页面不可见时暂停的周期定时器（F11）。
 *
 * 为什么存在：渲染层的周期定时器服务的全是「用户正在看」的东西——相对时间
 * 刷新、观测轮询、原生视图矩形重申。窗口最小化/隐藏后它们全是纯浪费（电、CPU、
 * 无意义的 IPC），而原生视图矩形在不可见时本来就没有正确性可言。
 *
 * 与裸 setInterval 的两点语义差异（都是刻意的）：
 * - **启动即跳一次**：调用方原本「先 tick 再 setInterval」的写法（观测抽屉）
 *   可以原样迁移；对只设周期的调用方（倒计时卡片）这次多跳的回调是幂等的
 *   （`setNow(Date.now())`），无害。
 * - **重新可见时立即补跳一次**再重启周期：隐藏期间状态可能已变（倒计时早已
 *   到期、页面区域已被重排），等到下一个周期才纠正就是肉眼可见的滞后——
 *   对原生视图矩形这种「电平状态」尤其如此（AGENTS.md ⑤：漏一次边沿就永久错位）。
 *
 * 本模块是纯逻辑，不碰 DOM：窗口原语由调用方注入，故可在 node 单测里代入
 * 假环境逐拍验证。React 包装见 `use-visible-interval.ts`。
 */

/** 定时器与可见性的最小环境抽象；生产实现绑定 window/document，测试注入假环境 */
export interface IntervalEnvironment {
  setInterval: (callback: () => void, intervalMs: number) => unknown;
  clearInterval: (handle: unknown) => void;
  isHidden: () => boolean;
  /** 订阅可见性变化；返回退订函数 */
  onVisibilityChange: (listener: () => void) => () => void;
}

/**
 * 启动一个「可见才走」的周期任务，返回停止函数。
 * 幂等：重复可见/隐藏事件不会叠出第二个定时器；停止后环境事件不再有任何效果。
 */
export function createVisibleInterval(
  callback: () => void,
  intervalMs: number,
  env: IntervalEnvironment,
): () => void {
  let handle: unknown;
  let stopped = false;

  const stop = (): void => {
    if (handle === undefined) return;
    env.clearInterval(handle);
    handle = undefined;
  };
  const start = (): void => {
    if (stopped || handle !== undefined) return;
    callback();
    handle = env.setInterval(callback, intervalMs);
  };
  const onVisibilityChange = (): void => {
    if (env.isHidden()) stop();
    else start();
  };

  if (!env.isHidden()) start();
  const unsubscribe = env.onVisibilityChange(onVisibilityChange);

  return () => {
    stopped = true;
    stop();
    unsubscribe();
  };
}
