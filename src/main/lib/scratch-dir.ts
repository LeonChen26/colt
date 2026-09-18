// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 「新建工作目录」的路径算术（纯函数，可单测）。
 *
 * 用途：用户在草稿态什么都不选时，给他一个能立刻开工的目录——
 * `~/.colt/<年月日-时分秒>/workspace`。
 * 为什么要有这条出口：会话必须落在一个真实目录上（worker 的 cwd，内核据此读 AGENTS.md、
 * 记忆也按它做项目隔离），而「先去文件管理器里造一个文件夹」不该是开始对话的前置步骤。
 *
 * 三段各有分工：
 * - **`~/.colt`** 沿用仓库既有的用户级命名空间（用户级记忆就在 `~/.colt/memory.md`，
 *   见 `worker/lib/memory.ts` 的 `USER_MEMORY_RELATIVE_PATH`）——家目录里只开这一个口子，
 *   比另起一个 `Colt/` 更一致。Windows 资源管理器里点号目录并不隐藏，仍然找得到。
 * - **`<年月日-时分秒>`** 精确到**秒**。这是刻意的：两次「新建工作目录」只要是**两个不同时刻的
 *   意图**，就必须落到两个不同目录。只到**分钟**是不够的——一分钟里连点两次（完全可能：
 *   点完发现想换个地方，或者手滑双击之后又点一次）会拿到**同一个**目录，而那时它已经装上了
 *   上一次的东西，「给我一块干净的地方」当场落空。到秒后，任何两次人类操作的间隔都会跨秒。
 *   而同一**秒**内重复点仍然落到同一路径（由 `upsertProject` 按 root_key 去重）：那几乎只可能是
 *   一次双击，一次意图不该攒出两个空目录、两行项目。
 * - **`workspace/`** 才是**真正的项目根**：时间戳那层留给「这一次用到的其它东西」
 *   （以后要放日志、产物都在同一层），项目根的名字固定，脚本/提示词引用它不必跟着时间戳变。
 */
import { join } from "node:path";

/** 项目根那一层的固定目录名（见文件头：时间戳那层留给同一次用到的其它东西） */
export const WORKSPACE_LEAF = "workspace";

/** 默认的父目录：家目录下的 `.colt/`——与用户级记忆同一个命名空间，家目录里不多开口子 */
export function defaultScratchBase(home: string): string {
  return join(home, ".colt");
}

/** 目录名：本地时间的 `YYYYMMDD-HHmmss`（如 `20260919-153045`） */
export function scratchDirName(at: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  return (
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  );
}

/**
 * 新建工作目录的完整路径（= 项目根）：默认 `<base>/<年月日-时分秒>/workspace`。
 *
 * `override` 非空时**直接用它本身**（不再拼时间戳、也不拼 `workspace/`）：它是
 * 「把新建工作目录指到别处」的出口，指过去的人要的就是那个确定的目录；冒烟也靠它把产物
 * 钉在 `out/` 下——**固定路径**，因此每跑一次不会在家目录里攒一个目录、在库里多一行项目。
 */
export function scratchRootPath(base: string, at: Date, override?: string): string {
  const trimmed = override?.trim();
  if (trimmed) return trimmed;
  return join(base, scratchDirName(at), WORKSPACE_LEAF);
}
