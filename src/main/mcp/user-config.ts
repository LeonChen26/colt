// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 用户级 MCP 配置（`~/.colt/mcp.json`）的**读写**——只做「加一条 / 删一条」，不做别的。
 *
 * 为什么单独成一个文件、并且要这么小心：这份配置对**全部项目**生效，用户很可能已经手工
 * 维护了很久（自己的 server、自己的 env、自己写的注释式字段）。安装器往这里写东西时，
 * 唯一可接受的行为是「**只动我们那一条**」：
 *
 * - 其它 server 原样保留（含它们的键序——用户按自己的习惯排的，我们没资格重排）；
 * - 顶层的未知字段（`mcpServers` 之外的东西，比如某些客户端认的 `$schema`）原样保留；
 * - **解析不了就报错，不覆盖**。这一点比什么都重要：把一份手写的、可能只是少了个逗号的
 *   配置直接冲成 `{"mcpServers":{...}}`，等于替用户删了他的配置——而且悄无声息。
 * - 写入走「临时文件 + rename」：中途崩溃不会留下半份 JSON（下次启动读不了整份）。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { userMcpConfigPath } from "@shared/mcp-config";

/** 用户级配置的原始内容 + 解析结果（`exists=false` 表示这份文件还不存在） */
export interface UserConfigFile {
  path: string;
  exists: boolean;
  /** 完整的顶层对象（保留未知字段） */
  root: Record<string, unknown>;
  /** `mcpServers` 视图；不存在时为空对象 */
  servers: Record<string, unknown>;
}

/**
 * 读用户级配置。
 *
 * 文件不存在 → 空配置（不是错误：绝大多数用户第一次装时都没有这个文件）。
 * 存在但不是合法 JSON / 顶层不是对象 → **抛错**，调用方必须原样把这句话摆给用户看。
 */
export async function readUserConfig(home: string): Promise<UserConfigFile> {
  const path = userMcpConfigPath(home);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { path, exists: false, root: {}, servers: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${path} 不是合法 JSON（${error instanceof Error ? error.message : String(error)}）——` +
        "没有替你改写：先手工修好它，再来安装",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} 的顶层不是对象——没有替你改写：先手工修好它，再来安装`);
  }
  const root = parsed as Record<string, unknown>;
  const servers = root.mcpServers;
  if (servers !== undefined && (typeof servers !== "object" || servers === null || Array.isArray(servers))) {
    throw new Error(`${path} 的 mcpServers 不是对象——没有替你改写：先手工修好它，再来安装`);
  }
  return {
    path,
    exists: true,
    root,
    servers: (servers as Record<string, unknown> | undefined) ?? {},
  };
}

/** 写回：临时文件 + rename，保留缩进（两空格）与结尾换行——手写文件读起来还是手写的样子 */
async function writeUserConfig(config: UserConfigFile, servers: Record<string, unknown>): Promise<void> {
  const next: Record<string, unknown> = { ...config.root, mcpServers: servers };
  await mkdir(dirname(config.path), { recursive: true });
  const temp = `${config.path}.tmp`;
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await rename(temp, config.path);
}

/**
 * 加/改一条 server。同名条目会被**覆盖**（重装就是把路径改到新 venv 上）。
 * 返回写后的完整 server 名清单，供调用方如实回显「现在有哪几条」。
 */
export async function upsertUserServer(
  home: string,
  name: string,
  config: unknown,
): Promise<{ path: string; servers: string[] }> {
  const file = await readUserConfig(home);
  const servers: Record<string, unknown> = { ...file.servers, [name]: config };
  await writeUserConfig(file, servers);
  return { path: file.path, servers: Object.keys(servers) };
}

/**
 * 删一条 server。**只删同名的那一条**，别人的 entry 一行不动。
 * 返回值说明「原本有没有这一条」——没有时界面该说「本来就没装」，而不是假装卸载成功。
 */
export async function removeUserServer(
  home: string,
  name: string,
): Promise<{ path: string; removed: boolean }> {
  const file = await readUserConfig(home);
  if (!(name in file.servers)) return { path: file.path, removed: false };
  const servers = { ...file.servers };
  delete servers[name];
  await writeUserConfig(file, servers);
  return { path: file.path, removed: true };
}
