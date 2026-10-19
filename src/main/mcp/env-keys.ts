// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 收集 MCP 配置里 `${VAR}` 引用的环境变量名，供 fork worker 时**按需**透传。
 *
 * 为什么需要这一步：worker 的环境是白名单投影（`main/lib/worker-env.ts`），
 * 而 `mcp.json` 的既定写法就是「密钥写成 `${VAR}` 引用环境变量」
 * （系统提示词与 `SECURITY.md` 都这么教）。两条规则叠加后，`${GITHUB_TOKEN}`
 * 这类引用在 worker 里必然取不到值——`interpolateConfig` 会报「引用了未定义的环境变量」
 * 并整条跳过该 server。
 *
 * 这里**只透传配置真正点名的键**，不做全量继承：白名单要防的是「模型一条 `env`
 * 就把宿主所有密钥读回去」，而用户自己在 MCP 配置里点名的变量本来就是给 MCP
 * 子进程用的。`FORBIDDEN_WORKER_ENV` 仍然优先（见 `buildWorkerEnv`）。
 *
 * 读不到文件（不存在 / 无权限）一律视为「没有引用」——MCP 配置读不了不能
 * 让会话起不来，真正的报错由 worker 侧的配置读取负责。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mcpUserHome, userMcpConfigPath } from "@shared/mcp-config";

const VAR_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** 项目级 + 用户级 mcp.json 里出现过的变量名（去重，保持配置顺序） */
export function collectMcpEnvKeys(projectRoot: string): string[] {
  const files = [join(projectRoot, ".colt", "mcp.json"), userMcpConfigPath(mcpUserHome())];
  const keys = new Set<string>();
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const match of text.matchAll(VAR_REF)) keys.add(match[1]);
  }
  return [...keys];
}
