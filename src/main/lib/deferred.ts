// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 可反复读写、只能 settle 一次的延迟量。
 *
 * 用于 worker 的「就绪信号」：等待方 await 它，成功走 resolve，进程中途退出走 reject。
 * 关键是提供 reject 出口——只 resolve 不清空的 promise 在持有方崩溃时会永久挂起，
 * 把上层的 session.open 一起拖住（界面停在「正在启动会话进程…」）。
 * settle 后清空出口，避免重复动作。
 */
export interface Deferred<T> {
  readonly promise: Promise<T>;
  /** 成功；第二次调用无效。T 为 void 时可无参调用 */
  resolve(...args: [T] extends [void] ? [] : [T]): void;
  /** 失败；第二次调用无效。已 resolve 后调用无效 */
  reject(error: Error): void;
  /** 是否已 settle */
  readonly settled: boolean;
}

export function createDeferred<T>(): Deferred<T> {
  let resolveFn: ((value: T) => void) | undefined;
  let rejectFn: ((error: Error) => void) | undefined;
  let settled = false;

  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    rejectFn = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
  });

  return {
    promise,
    get settled() {
      return settled;
    },
    resolve(...args) {
      resolveFn?.(args[0] as T);
    },
    reject(error) {
      rejectFn?.(error);
    },
  };
}
