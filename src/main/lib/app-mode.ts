// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

import { app } from "electron";

/**
 * 开发期判定：**在启动早期求值一次，之后一律复用这个常量**。
 *
 * 为什么不就地写 `!app.isPackaged`：dev 下这个 getter 会**晚值漂移**——启动早期读到 false，
 * 到 `ready-to-show`（正是 worker 被 fork 的时候）已经变成 true，于是任何「运行期才求值」的
 * 判断都会把开发态误判成「已打包」。
 *
 * 这不是推演，是实测事故（2026-09-18）：`session-manager` 里那处故障注入闸门
 * （`COLT_WORKER_OVERRIDE`）正是这么失效的——运行时读到的 `app.isPackaged` 为 true，
 * 于是永远回落到真实 worker，`crash` 冒烟由此打出「OK（2ms）」，
 * 把「worker 在就绪前退出会不会快速失败」这条路径**全绿地放了过去**。
 *
 * 打包后 `process.defaultApp` 为 undefined。两个条件取或：单看哪一个都会在某种启动方式下失手。
 * 同理，dev 资源的加载、`Colt` / `Colt-dev` 数据目录的分流也都依赖这个常量。
 */
export const isDev = process.defaultApp === true || !app.isPackaged;
