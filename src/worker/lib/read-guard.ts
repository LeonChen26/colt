// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 给内核的 `read` 工具加**项目根边界**。
 *
 * 为什么需要这一层：内核 `createReadTool()` 经 `NodeExecutionEnv.absolutePath()`
 * 只做 `resolvePath(cwd, path)`——绝对路径、`~/`、`../../..` 都原样通过，没有任何
 * 根校验（见 `node_modules/@earendil-works/pi-agent-core/dist/harness/env/nodejs.js`）。
 * 而 `read` 在 `READONLY_TOOLS` 里**免审批**（`approval/policy.ts` 直接 allow，不看路径），
 * 于是不包这一层，模型一句 `read C:/Users/<user>/.ssh/id_rsa` 就能把项目外文件读进上下文。
 *
 * 判据复用 `@shared/path-guard` 的 `isWithinRootReal`（与审批闸门同源、全仓唯一实现）：
 * 先纯字符串判定（根外绝对路径不碰磁盘），再解真实路径挡「根内软链接指向根外」。
 * 越界时明确报错而不是返回空内容——模型需要知道这是被边界挡下的，不是文件是空的。
 *
 * 写侧（write / edit）不在这里包：它们走审批闸门，`policy.ts` 已经做了同一套判定
 * 并会弹卡，而 `read` 是唯一「免审批」的落盘读取入口。
 */
import { createReadTool } from "@earendil-works/pi-agent-core";
import { isWithinRootReal } from "@shared/path-guard";

type ReadTool = ReturnType<typeof createReadTool>;

export function createGuardedReadTool(cwd: string): ReadTool {
  const inner = createReadTool();
  return {
    ...inner,
    async execute(...args: Parameters<ReadTool["execute"]>) {
      const params = args[1] as { path: string };
      if (!isWithinRootReal(cwd, params.path)) {
        throw new Error(
          `拒绝读取项目外的文件：${params.path}。read 只能访问项目根（${cwd}）之内的路径。`,
        );
      }
      return inner.execute(...args);
    },
  };
}
