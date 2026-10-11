// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 定位随包分发的 ripgrep 二进制。
 *
 * 与 `toolOutputDir` / `sessionsRoot` 同一个分工：**路径只由主进程算**，worker 不猜。
 * worker 是 utilityProcess，它不知道自己是跑在 `out/` 旁边还是跑在解包后的 resources 里；
 * 而主进程一个 `app.getAppPath()` / `process.resourcesPath` 就分得清。于是这里算出绝对路径、
 * 经 `init` 下发，worker 拿到就能用。
 *
 * 两种形态：
 *   - **开发**：`<仓库根>/vendor/ripgrep/<platform>-<arch>/rg[.exe]`（`npm run rg:fetch` 拉的，已 gitignore）
 *   - **打包**：`<resources>/ripgrep/<platform>-<arch>/rg[.exe]`（electron-builder 的 extraResources）
 *
 * ⚠️ 找不到时返回 `undefined`，**不抛错**：检索有纯 JS 实现兜底，带不带二进制都能工作。
 * 那是一种**受支持的形态**（不是缺陷），所以这里也不该把它变成启动失败。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { isDev } from "./app-mode";

/** 目录名与 `scripts/fetch-rg.mjs` 写下的、以及 electron-builder.yml 里拷的一致 */
const VENDOR_SUBDIR = "ripgrep";

function binaryName(): string {
  return process.platform === "win32" ? "rg.exe" : "rg";
}

function targetKey(): string {
  return `${process.platform}-${process.arch}`;
}

/**
 * 依次看两个位置：
 *   ① 打包后的 resources（生产环境走这条）；
 *   ② 开发态的仓库 `vendor/`。
 *
 * 两个都查而不是按 `isDev` 二选一：`isDev` 是**启动早期求值一次**的常量，
 * 而这里可能在任何时刻被调用；两个都存在时「先 resources 后 vendor」的次序也让
 * 「想临时用一份手放的二进制覆盖」这件事有个明确的落点（放 resources 即可）。
 * 两次 `existsSync` 的代价可以忽略（每次开会话一次）。
 */
export function resolveRgPath(): string | undefined {
  const candidates: string[] = [];
  if (typeof process.resourcesPath === "string" && process.resourcesPath !== "") {
    candidates.push(join(process.resourcesPath, VENDOR_SUBDIR, targetKey(), binaryName()));
  }
  // app.getAppPath()：dev 下是仓库根，打包后是 app.asar 的路径（那种情况上面那条已经命中）
  try {
    candidates.push(join(app.getAppPath(), "vendor", VENDOR_SUBDIR, targetKey(), binaryName()));
  } catch {
    // app 尚未就绪时 getAppPath 可能抛——那只是「这条候选不可用」，不是错误
  }
  if (isDev) {
    // 开发态额外兜一层：从 out/main 往上两级也是仓库根，防 app.getAppPath 在某些
    // 启动方式（如直接 `electron out/main/index.js`）下给的不是仓库根
    candidates.push(join(__dirname, "..", "..", "vendor", VENDOR_SUBDIR, targetKey(), binaryName()));
  }
  return candidates.find((candidate) => existsSync(candidate));
}
