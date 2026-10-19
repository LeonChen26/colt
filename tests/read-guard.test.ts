/**
 * `read` 工具的项目根边界。
 *
 * 内核的 `createReadTool()` 只做 `resolvePath(cwd, path)`，绝对路径 / `..` 原样通过；
 * 而 `read` 在只读白名单里**免审批**（审批不看路径）。这层包装是唯一闸门，
 * 失败方式是**静默**的（文件被读进上下文而没有任何提示），所以把越界与放行两侧都钉住。
 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { makeTempDir, removeTempDir } from "./helpers/temp";
import { createGuardedReadTool } from "../src/worker/lib/read-guard.ts";

let root = "";
let outside = "";

beforeEach(() => {
  root = makeTempDir("colt-read-guard-root-");
  outside = makeTempDir("colt-read-guard-out-");
  writeFileSync(join(root, "inside.txt"), "hello\n", "utf8");
  writeFileSync(join(outside, "secret.txt"), "top-secret\n", "utf8");
});

afterEach(() => {
  removeTempDir(root);
  removeTempDir(outside);
});

function run(path: string): Promise<unknown> {
  const tool = createGuardedReadTool(root);
  const env = new NodeExecutionEnv({ cwd: root });
  // 越界分支在调用内核之前就抛错，`env` 只服务根内那一条用例。
  return tool.execute("call-1", { path }, () => undefined, { env } as never, undefined as never, {} as never);
}

describe("createGuardedReadTool：项目根边界", () => {
  test("根内相对路径正常读到内容", async () => {
    const result = (await run("inside.txt")) as {
      content: { type: string; text?: string }[];
    };
    assert.ok(result.content.some((block) => block.text?.includes("hello")));
  });

  test("`..` 逃出项目根 → 拒绝，且报错说清是边界而不是文件不存在", async () => {
    await assert.rejects(
      () => run(`../${outside.split(/[\\/]/).pop()}/secret.txt`),
      /拒绝读取项目外的文件/,
    );
  });

  test("根外绝对路径 → 拒绝（这是白名单放行时唯一能挡住它的地方）", async () => {
    await assert.rejects(() => run(join(outside, "secret.txt")), /拒绝读取项目外的文件/);
  });
});
