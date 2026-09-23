// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * node-pty 的加载与参数组装（「终端」页签的底座）。
 *
 * 纯 Node（不 import electron），`pickShell` / `buildPtyOptions` 是纯函数，
 * 由 `tests/terminal-pty.test.ts` 直接覆盖；真实 spawn 只在 terminal-host 里发生。
 *
 * **为什么 require 是惰性的**：node-pty 是原生模块（.node 二进制），装载失败
 * （版本不符 / 文件损坏 / 平台不符）不该连累整个主进程起不来——终端只是众多页签
 * 之一，打不开终端可以如实报错，应用本身必须照常启动。类型走 `import type`
 * （编译期擦除，不触发装载）。
 */
import { createRequire } from "node:module";
import type { IPty, IPtyForkOptions } from "@homebridge/node-pty-prebuilt-multiarch";

const nodeRequire = createRequire(import.meta.url);

type PtyModule = typeof import("@homebridge/node-pty-prebuilt-multiarch");

let ptyModule: PtyModule | undefined;

/** 惰性装载 node-pty；失败抛原错误，由调用方转成可读的「终端起不来」 */
export function loadPty(): PtyModule {
  if (ptyModule === undefined) {
    ptyModule = nodeRequire("@homebridge/node-pty-prebuilt-multiarch") as PtyModule;
  }
  return ptyModule;
}

/** 装载是否已发生过且成功（诊断用，不触发装载） */
export function ptyLoaded(): boolean {
  return ptyModule !== undefined;
}

/**
 * shell 候选（按优先级）：Windows 上 pwsh（PowerShell 7）> powershell（Windows
 * PowerShell 5.1）> cmd；类 Unix 上 $SHELL > bash > sh。
 *
 * `pickShell` 收一个探测谓词而不是自己去查——「怎么算找得到」在 Windows 上
 * （PATH + PATHEXT）和 Unix（which）是两套话，把它留给宿主侧，这里只管顺序。
 */
export const SHELL_CANDIDATES: readonly string[] =
  process.platform === "win32"
    ? ["pwsh.exe", "powershell.exe", "cmd.exe"]
    : [process.env.SHELL ?? "bash", "bash", "sh"];

/** 按候选顺序挑第一个探测命中的；一个都没有就回落最后一个（Windows 必有 cmd） */
export function pickShell(has: (exe: string) => boolean): string {
  for (const exe of SHELL_CANDIDATES) {
    if (has(exe)) return exe;
  }
  return SHELL_CANDIDATES[SHELL_CANDIDATES.length - 1];
}

/** 终端行列的下限：xterm / pty 都不接受 0（FitAddon 在容器未布局时可能给 0） */
const MIN_COLS = 2;
const MIN_ROWS = 2;

function clampCols(value: number): number {
  if (!Number.isFinite(value)) return 80;
  return Math.max(MIN_COLS, Math.floor(value));
}

function clampRows(value: number): number {
  if (!Number.isFinite(value)) return 24;
  return Math.max(MIN_ROWS, Math.floor(value));
}

/**
 * 组装 pty 参数。`env` 显式带全 `process.env`：node-pty 传了 env 就是**替换**而非
 * 合并，漏带 PATH 会让 shell 里连一条外部命令都跑不了（症状极隐蔽）。
 */
export function buildPtyOptions(cwd: string, cols: number, rows: number): IPtyForkOptions {
  return {
    name: "xterm-256color",
    cols: clampCols(cols),
    rows: clampRows(rows),
    cwd,
    env: { ...process.env } as Record<string, string>,
  };
}

/** 便捷再导出：terminal-host 只需要这一个类型 */
export type { IPty };
