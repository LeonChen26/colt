// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 写后诊断的检查器表与计划构造（纯函数，`docs/archive/DESIGN-afterwrite.md` D6）。
 *
 * 通道安全性由两条不变量支撑，缺一不可：
 * 1. **命令不是模型给的**——命令模板写死在这张表里，模型的唯一输入是文件路径
 *    （且该路径刚被审批闸门放行的 write/edit 成功写过）；
 * 2. **模型输入必须 POSIX 引号转义后才能拼进命令**（内核 exec 全平台走 bash，
 *    见 `pi-agent-core/dist/harness/env/nodejs.js` 的 shell 选择）——
 *    转义在 `posixQuotePath`，是路径进命令的唯一通道。
 *
 * 越界校验**刻意不做**：`main/lib/path-guard.ts` 是全仓唯一实现且在 main 层，
 * worker 不可跨层引入；而这里判越界防不住任何东西——检查器只读，模型能把
 * path 写出项目本来就要过 dangerous 审批。复制一份判定只会造出第二套会漂移的真相。
 */
import { extname } from "node:path";

/** 一个诊断检查项：命令模板与执行参数，不含任何模型可控的裸文本 */
export interface DiagnoseCheck {
  /** 展示名（追加段与「诊断跳过」行用） */
  readonly label: string;
  readonly kind: "fast" | "slow";
  /**
   * 命令（bash，项目根执行）。fast 项含 `{file}` 占位符，
   * 由 `materializeCommand` 用**已转义**的绝对路径替换。
   */
  readonly command: string;
  readonly timeoutSec: number;
}

/** 单项超时：快检查允许冷启动（eslint 首跑数秒），慢检查容忍中型仓库的全量编译 */
export const FAST_TIMEOUT_SEC = 60;
export const SLOW_TIMEOUT_SEC = 120;

/** 检查器输出上限（字节）：与内核 bash 工具同量级，防单个检查器刷爆上下文 */
export const DIAGNOSE_OUTPUT_LIMIT_BYTES = 8 * 1024;
export const DIAGNOSE_OUTPUT_LIMIT_LINES = 200;

/** 慢检查防抖：写入停止 2s 后才执行（docs/archive/DESIGN-afterwrite.md D3） */
export const SLOW_DEBOUNCE_MS = 2000;

/** TS 系扩展名：tsc 与 eslint 的适用面 */
const TS_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

/**
 * POSIX 单引号转义：把任意字符串变成 bash 里字面安全的单引号串。
 * 是路径进命令的**唯一**通道——模型可控文本不经它不得出现在命令里。
 */
export function posixQuotePath(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** 把 fast 模板里的 `{file}` 替换为已转义的路径；slow 模板不得含占位符 */
export function materializeCommand(check: DiagnoseCheck, absolutePath: string): string {
  if (check.kind === "slow") return check.command;
  return check.command.replace("{file}", posixQuotePath(absolutePath.replaceAll("\\", "/")));
}

/** fast 检查按扩展名挑；不认识的扩展名返回空（静默跳过是「没得查」，不是失败） */
export function fastChecksFor(filePath: string): DiagnoseCheck[] {
  const ext = extname(filePath).toLowerCase();
  if (!TS_EXTENSIONS.has(ext)) return [];
  return [
    {
      label: "eslint",
      kind: "fast",
      command: "npx eslint --no-warn-ignored {file}",
      timeoutSec: FAST_TIMEOUT_SEC,
    },
  ];
}

/**
 * slow 检查同样按扩展名挑，但**生效与否取决于项目根的标记文件**——
 * 由 `slowMarkersFor` 列出需要探测的标记，`planSlowChecks` 据此过滤。
 */
export function slowChecksFor(filePath: string): DiagnoseCheck[] {
  const ext = extname(filePath).toLowerCase();
  if (TS_EXTENSIONS.has(ext)) {
    return [{ label: "tsc", kind: "slow", command: "npx tsc --noEmit", timeoutSec: SLOW_TIMEOUT_SEC }];
  }
  if (ext === ".go") {
    return [{ label: "go vet", kind: "slow", command: "go vet ./...", timeoutSec: SLOW_TIMEOUT_SEC }];
  }
  if (ext === ".rs") {
    return [{ label: "cargo check", kind: "slow", command: "cargo check", timeoutSec: SLOW_TIMEOUT_SEC }];
  }
  return [];
}

/** 某个 slow 检查器的前置标记（相对项目根）。缺任何一项即跳过该检查器 */
export function slowMarkerFor(check: DiagnoseCheck): string[] {
  switch (check.label) {
    case "tsc":
      return ["tsconfig.json"];
    case "go vet":
      return ["go.mod"];
    case "cargo check":
      return ["Cargo.toml"];
    default:
      return [];
  }
}

/** eslint 的项目级配置标记（存在其一才跑；否则每次写 TS 都白起一个进程再报「没配置」） */
export const ESLINT_MARKERS = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.json",
  ".eslintrc.yaml",
  ".eslintrc.yml",
];

/** ruff 的项目级配置标记（ruff 没有配置也能跑默认规则，故 pyproject.toml 也算标记） */
export const RUFF_MARKERS = ["ruff.toml", ".ruff.toml", "pyproject.toml"];

/** fast 检查的前置标记（eslint 是唯一一个；它没有配置文件时跑了也是噪声） */
export function fastMarkerFor(check: DiagnoseCheck): string[] {
  if (check.label === "eslint") return ESLINT_MARKERS;
  return [];
}

export interface DiagnosePlan {
  /** 已物化（路径已转义、可直接 exec）的 fast 命令，随标签一起返回 */
  readonly fast: { check: DiagnoseCheck; command: string }[];
  /** slow 检查器去重集合：防抖窗口内多个文件命中同一个全仓检查只跑一次 */
  readonly slow: DiagnoseCheck[];
}

/**
 * 为一次成功的 write/edit 生成诊断计划。
 *
 * `exists` 由调用方注入（`existsSync(join(cwd, marker))` 的包装）——纯函数不碰磁盘，
 * 测试用假探测驱动。前置标记不满足的检查器**直接不进计划**：那是「没得查」，
 * 与「跑了但失败」不同，后者才配得上一行「诊断跳过」。
 */
export function planDiagnose(
  absolutePath: string,
  exists: (relativeMarker: string) => boolean,
): DiagnosePlan {
  const fast = fastChecksFor(absolutePath)
    .filter((check) => fastMarkerFor(check).some(exists))
    .map((check) => ({ check, command: materializeCommand(check, absolutePath) }));

  const slow: DiagnoseCheck[] = [];
  for (const check of slowChecksFor(absolutePath)) {
    const markers = slowMarkerFor(check);
    if (!markers.every(exists)) continue;
    if (slow.some((item) => item.label === check.label)) continue;
    slow.push(check);
  }
  return { fast, slow };
}
