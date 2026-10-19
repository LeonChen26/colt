/**
 * `collectMcpEnvKeys`：fork worker 前，把 mcp.json 里 `${VAR}` 点名的变量挑出来，
 * 交给 `buildWorkerEnv` 按需透传。
 *
 * 为什么要钉：worker 环境是白名单投影，不含用户自定义变量；而 MCP 的既定写法就是
 * 「密钥写成 `${VAR}` 引用环境变量」。漏了这条，配置里所有 `${GITHUB_TOKEN}` 都会
 * 报「引用了未定义的环境变量」并整条跳过——是一次静默的能力缺失。
 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir, removeTempDir } from "./helpers/temp";
import { collectMcpEnvKeys } from "../src/main/mcp/env-keys.ts";

let root = "";
let home = "";
let previousHome: string | undefined;

beforeEach(() => {
  root = makeTempDir("colt-mcp-env-root-");
  home = makeTempDir("colt-mcp-env-home-");
  mkdirSync(join(root, ".colt"), { recursive: true });
  mkdirSync(join(home, ".colt"), { recursive: true });
  previousHome = process.env.COLT_MCP_HOME;
  process.env.COLT_MCP_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.COLT_MCP_HOME;
  else process.env.COLT_MCP_HOME = previousHome;
  removeTempDir(root);
  removeTempDir(home);
});

describe("collectMcpEnvKeys", () => {
  test("项目级与用户级的 ${VAR} 都收齐，同名去重", () => {
    writeFileSync(
      join(root, ".colt", "mcp.json"),
      JSON.stringify({
        mcpServers: { local: { command: "npx", env: { TOKEN: "${GITHUB_TOKEN}" } } },
      }),
      "utf8",
    );
    writeFileSync(
      join(home, ".colt", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          remote: {
            url: "https://example.com",
            headers: { Authorization: "Bearer ${GITHUB_TOKEN} ${API_KEY}" },
          },
        },
      }),
      "utf8",
    );
    assert.deepEqual(collectMcpEnvKeys(root).sort(), ["API_KEY", "GITHUB_TOKEN"]);
  });

  test("两份配置都不存在 → 空数组（读不到不能让会话起不来）", () => {
    assert.deepEqual(collectMcpEnvKeys(root), []);
  });

  test("坏 JSON 不抛错：只当作没有引用", () => {
    writeFileSync(join(root, ".colt", "mcp.json"), "{ not json", "utf8");
    assert.deepEqual(collectMcpEnvKeys(root), []);
  });
});
