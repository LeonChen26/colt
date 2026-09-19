// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 技能**使用者偏好**（`.colt/skills.json`）的读写测试。
 *
 * 这一层最容易被写错的两件事，正好都在这里钉住：
 *   ① 两层是**并集**而不是「项目级覆盖用户级」——照抄 MCP 的覆盖语义会让项目里一个空数组
 *      意外**解开**用户级的全局禁用（那是提权，不是覆盖）；
 *   ② 写盘是**读-改-写**且**坏文件拒绝覆盖**——覆盖一份手写配置不可逆。
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  loadSkillsConfig,
  setSkillDisabled,
  skillsConfigPath,
  skillsUserHome,
  userSkillsConfigPath,
} from "@shared/skills-config";
import { makeTempDirAsync, removeTempDirAsync } from "./helpers/temp";

/** 本文件建过的目录（`removeTempDirAsync` 只认它自己登记的路径，故要自己记着） */
const dirs: string[] = [];
const makeDir = async (prefix: string): Promise<string> => {
  const dir = await makeTempDirAsync(prefix);
  dirs.push(dir);
  return dir;
};
/** 一个**不存在**的家目录：验「没配就是没配」 */
const missingHome = async (): Promise<string> => join(await makeDir("colt-skills-nohome-"), "nope");

after(async () => {
  await removeTempDirAsync(...dirs);
});

/** 写一份 `.colt/skills.json`；`dir` 是「项目根」或「家目录」 */
async function writeConfig(dir: string, content: unknown): Promise<void> {
  await mkdir(join(dir, ".colt"), { recursive: true });
  await writeFile(
    join(dir, ".colt", "skills.json"),
    typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`,
    "utf8",
  );
}

describe("路径口径", () => {
  test("项目级 / 用户级各自落在 `<根>/.colt/skills.json`（与 mcp.json 同一个目录）", () => {
    assert.equal(skillsConfigPath("/proj"), join("/proj", ".colt", "skills.json"));
    assert.equal(userSkillsConfigPath("/home/u"), join("/home/u", ".colt", "skills.json"));
  });

  test("用户级家目录可用 `COLT_MCP_HOME` 覆盖（与 MCP 共用同一个隔离口）", async () => {
    const previous = process.env.COLT_MCP_HOME;
    const home = await makeDir("colt-skills-home-");
    try {
      process.env.COLT_MCP_HOME = home;
      assert.equal(skillsUserHome(), home);
    } finally {
      if (previous === undefined) delete process.env.COLT_MCP_HOME;
      else process.env.COLT_MCP_HOME = previous;
    }
  });
});

describe("loadSkillsConfig：两层**并集**", () => {
  test("什么都没配：空名单、零告警（不是错误）", async () => {
    const config = await loadSkillsConfig(await makeDir("colt-skills-none-"), await missingHome());
    assert.deepEqual(config, { disabled: [], fromUser: [], diagnostics: [] });
  });

  test("只有项目级：名单生效", async () => {
    const cwd = await makeDir("colt-skills-proj-");
    await writeConfig(cwd, { disabled: ["pdf"] });
    const config = await loadSkillsConfig(cwd, await missingHome());
    assert.deepEqual(config.disabled, ["pdf"]);
    assert.deepEqual(config.fromUser, [], "项目级禁的不算「来自用户级」");
  });

  test("两层都禁：**并集**——项目里的空数组**不能**解开用户级的全局禁用", async () => {
    const cwd = await makeDir("colt-skills-union-");
    const home = await makeDir("colt-skills-union-home-");
    await writeConfig(home, { disabled: ["global"] });
    await writeConfig(cwd, { disabled: ["local"] });
    const config = await loadSkillsConfig(cwd, home);
    assert.deepEqual([...config.disabled].sort(), ["global", "local"]);
    assert.deepEqual(config.fromUser, ["global"]);

    // 关键的那一步：项目级改成空数组，用户级那条仍然关着
    await writeConfig(cwd, { disabled: [] });
    const after = await loadSkillsConfig(cwd, home);
    assert.deepEqual(after.disabled, ["global"], "「覆盖」会把它解开——那是提权");
    assert.deepEqual(after.fromUser, ["global"]);
  });

  test("两层同名只出现一次，且算作「来自用户级」（开关要据此置灰）", async () => {
    const cwd = await makeDir("colt-skills-dup-");
    const home = await makeDir("colt-skills-dup-home-");
    await writeConfig(home, { disabled: ["same"] });
    await writeConfig(cwd, { disabled: ["same"] });
    const config = await loadSkillsConfig(cwd, home);
    assert.deepEqual(config.disabled, ["same"]);
    assert.deepEqual(config.fromUser, ["same"]);
  });

  test("省略 `home` 就不读用户级（单测结论不随开发者的机器漂移）", async () => {
    const home = await makeDir("colt-skills-skip-home-");
    await writeConfig(home, { disabled: ["global"] });
    // 注意：第一参是**项目根**。这里传一个干净目录，那家用目录就不该被读到。
    const config = await loadSkillsConfig(await makeDir("colt-skills-skip-cwd-"), undefined);
    assert.deepEqual(config.disabled, []);
    assert.deepEqual(config.fromUser, []);
  });

  test("坏 JSON / 类型不对：如实诊断（带文件名），名单留空、不炸", async () => {
    const cwd = await makeDir("colt-skills-bad-");
    await writeConfig(cwd, "{ 这不是 JSON");
    const broken = await loadSkillsConfig(cwd, undefined);
    assert.deepEqual(broken.disabled, []);
    assert.equal(broken.diagnostics.length, 1);
    assert.match(broken.diagnostics[0] ?? "", /不是合法 JSON/);

    await writeConfig(cwd, { disabled: "pdf" });
    const wrongType = await loadSkillsConfig(cwd, undefined);
    assert.deepEqual(wrongType.disabled, []);
    assert.match(wrongType.diagnostics[0] ?? "", /字符串数组/);
  });

  test("顶层不是对象（`null` / 数组 / 标量）：如实诊断且**不抛**——这条读路径在装载链上", async () => {
    // 内容是 `null` 时若直接读 `parsed.disabled` 会抛 TypeError，而它一路走到 `init`（fatal）：
    // 一份坏配置就能让**会话打不开**。同族的数组 / 标量一并拒绝，口径与写路径一致。
    const cwd = await makeDir("colt-skills-toplevel-");
    for (const bad of ["null", "[]", "123", '"pdf"']) {
      await writeConfig(cwd, bad);
      const config = await loadSkillsConfig(cwd, undefined);
      assert.deepEqual(config.disabled, [], `顶层 ${bad} 不该给出名单`);
      assert.equal(config.diagnostics.length, 1, `顶层 ${bad} 要报一条诊断`);
      assert.match(config.diagnostics[0] ?? "", /顶层必须是一个对象/);
    }
  });

  test("名单里的空串与前后空白被归一到干净的名字", async () => {
    const cwd = await makeDir("colt-skills-trim-");
    await writeConfig(cwd, { disabled: ["  pdf  ", "", "  "] });
    const config = await loadSkillsConfig(cwd, undefined);
    assert.deepEqual(config.disabled, ["pdf"]);
  });
});

describe("setSkillDisabled：读-改-写", () => {
  test("还没有这个文件时建出目录写一份", async () => {
    const cwd = await makeDir("colt-skills-write-");
    await setSkillDisabled(cwd, "pdf", true);
    const written = JSON.parse(await readFile(skillsConfigPath(cwd), "utf8")) as {
      disabled?: string[];
    };
    assert.deepEqual(written.disabled, ["pdf"]);
  });

  test("关掉再打开：名字被移除（不留一条 allow）", async () => {
    const cwd = await makeDir("colt-skills-reopen-");
    await setSkillDisabled(cwd, "pdf", true);
    await setSkillDisabled(cwd, "pdf", false);
    const written = JSON.parse(await readFile(skillsConfigPath(cwd), "utf8")) as {
      disabled?: string[];
    };
    assert.deepEqual(written.disabled, []);
  });

  test("同一个名字关两次只留一条", async () => {
    const cwd = await makeDir("colt-skills-twice-");
    await setSkillDisabled(cwd, "pdf", true);
    await setSkillDisabled(cwd, "pdf", true);
    const written = JSON.parse(await readFile(skillsConfigPath(cwd), "utf8")) as {
      disabled?: string[];
    };
    assert.deepEqual(written.disabled, ["pdf"]);
  });

  test("文件坏掉时**拒绝覆盖**，原样留着等人来改", async () => {
    const cwd = await makeDir("colt-skills-refuse-");
    await writeConfig(cwd, "{ 这不是 JSON");
    await assert.rejects(() => setSkillDisabled(cwd, "pdf", true), /不是合法 JSON/);
    assert.equal(await readFile(skillsConfigPath(cwd), "utf8"), "{ 这不是 JSON");
  });
});
