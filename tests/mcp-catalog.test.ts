// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 内置可选 MCP 目录的三层：目录数据 / 前置检查 / 安装与卸载。
 *
 * 三条判据各守一件最容易出的事：
 * 1. **目录**：钉住的版本与 `pip` 真正吃的依赖串必须一致——`pins` 是给人读的（`= 2.0.0`
 *    这种写法 pip 不认），两者一旦走散，界面写着「钉住 2.0.0」而装出来是别的版本。
 * 2. **探测**：每个分支都要能区分「没装」「装错版本」「没有 Python」——把它们混成一个 false
 *    就等于让用户自己去猜，而这层存在的理由正是「别让人猜」。
 * 3. **安装**：失败时**什么都不写**（尤其不写用户级配置）。半成品配置的后果是设置页显示
 *    「已安装」、一开会话却连不上，用户还得回头找原因。
 *
 * 全程不 spawn 真进程：`Runner` 是注入的（见 `probe.ts` 的设计约束 ①）。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findPreset, MCP_CATALOG } from "../src/shared/mcp-catalog.ts";
import type { McpProbeItem } from "../src/shared/mcp-catalog.ts";
import { atLeast, parseVersion, probeCodewiki, type CommandResult, type Runner } from "../src/main/mcp/probe.ts";
import { installPreset, uninstallPreset, venvBinary } from "../src/main/mcp/install.ts";
import { readUserConfig, removeUserServer, upsertUserServer } from "../src/main/mcp/user-config.ts";

const ok = (stdout = ""): CommandResult => ({ ok: true, code: 0, stdout, stderr: "", error: null });
const fail = (error = "ENOENT"): CommandResult => ({ ok: false, code: null, stdout: "", stderr: "", error });

/**
 * 假执行器：按「命令 + 参数尾部」查表。
 * 用**尾部匹配**而不是全串：venv 路径是临时目录，全串写死会让用例跟着 tmp 目录名漂。
 */
function fakeRunner(
  table: { match: (command: string, args: string[]) => boolean; result: CommandResult }[],
): Runner & { calls: string[][] } {
  const calls: string[][] = [];
  const run: Runner = async (command, args) => {
    calls.push([command, ...args]);
    for (const entry of table) {
      if (entry.match(command, args)) return entry.result;
    }
    return fail(`no fake for ${command} ${args.join(" ")}`);
  };
  return Object.assign(run, { calls });
}

/** 一台「什么都装好了」的机器（Python 3.13 / git / codewiki 2.0.0 / mcp 1.30） */
function healthyMachine(
  over: { python?: string; codewiki?: string; mcp?: string; node?: string } = {},
) {
  return fakeRunner([
    {
      // 按**命令名**限定，别只看 `--version`：`npm --version` 也是那个形状，
      // 早先这条把它们一起接走，于是 npm 那项的版本读成了 "Python 3.13.12"。
      // 路径也认（venv 里的 `/rt/Scripts/python.exe` 是「指定解释器」那条走的路）。
      match: (command, args) =>
        (["python", "python3", "py"].includes(command) ||
          /[\\/]python(\.exe)?$/i.test(command)) &&
        args.at(-1) === "--version",
      result: ok(`Python ${over.python ?? "3.13.12"}\n`),
    },
    { match: (command) => command === "git", result: ok("git version 2.47.1.windows.1\n") },
    { match: (command) => command === "node", result: ok(`v${over.node ?? "22.22.2"}\n`) },
    {
      match: (_command, args) => args.join(" ").includes("import codewiki"),
      result: ok(`${over.codewiki ?? "2.0.0"}\n`),
    },
    {
      match: (_command, args) => args.join(" ").includes("import mcp"),
      result: ok(`${over.mcp ?? "1.30.0"}\n`),
    },
  ]);
}

const itemOf = (items: McpProbeItem[], id: McpProbeItem["id"]): McpProbeItem => {
  const found = items.find((item) => item.id === id);
  assert.notEqual(found, undefined, `探测结果里应当有 ${id}`);
  return found!;
};

describe("目录：内置条目与钉住的版本", () => {
  test("codewiki 条目存在，且 server 名与安装声明对得上", () => {
    const preset = findPreset("codewiki");
    assert.notEqual(preset, undefined);
    assert.equal(preset!.serverName, "codewiki");
    assert.deepEqual(preset!.serverArgs, ["mcp"]);
    // 装进配置的是 venv 里的 console script，故它必须与 id 同名（venvBinary 按 id 拼路径）
    assert.equal(venvBinary("/tmp/rt", preset!.id).endsWith("codewiki" + (process.platform === "win32" ? ".exe" : "")), true);
  });

  test("pip 依赖串从 git 按 commit 装（PyPI 上的 codewiki 是别人的包）", () => {
    const preset = findPreset("codewiki")!;
    // 关键事实：`pip install codewiki` 装到的是另一个同名项目，`codewiki==2.0.0` 在 PyPI
    // 上根本不存在（实测 Could not find a version）。所以依赖串必须是 git 直引。
    assert.match(
      preset.requirements[0]!,
      /^codewiki\s@\sgit\+https:\/\/github\.com\/FSoft-AI4Code\/CodeWiki\.git@[0-9a-f]{40}$/,
      "依赖串不是 git 直引：按 PyPI 名装会装到别人的包或直接失败",
    );
    assert.equal(preset.requirements[1], "mcp<2");
    // 界面文案里说钉了什么，依赖串里就得真有那几条——两边走散就是「说得对、装得错」
    const labels = preset.pins.map((pin) => pin.label);
    assert.deepEqual(labels.sort(), ["CodeWiki", "Node.js", "Python", "mcp"].sort());
    const mcpPin = preset.pins.find((pin) => pin.label === "mcp")!;
    assert.match(mcpPin.why, /list_tools/, "必须写清为什么要钉 mcp<2（实测崩点）");
  });

  test("未知 id 返回 undefined（IPC 据此回一句人话，而不是抛）", () => {
    assert.equal(findPreset("no-such-preset"), undefined);
    assert.equal(MCP_CATALOG.length, 1);
  });
});

describe("前置检查：每个分支都说清「缺什么」", () => {
  test("parseVersion 只认三段版本号，读不出就 null（不猜成 0.0.0）", () => {
    assert.deepEqual(parseVersion("Python 3.13.12"), [3, 13, 12]);
    assert.deepEqual(parseVersion("git version 2.47.1.windows.1"), [2, 47, 1]);
    assert.equal(parseVersion("no digits here"), null);
    assert.deepEqual(atLeast([3, 12, 0], [3, 12, 0]), true);
    assert.deepEqual(atLeast([3, 11, 9], [3, 12, 0]), false);
    assert.deepEqual(atLeast([4, 0, 0], [3, 12, 0]), true);
  });

  test("全绿：四项都过时 ready=true", async () => {
    const result = await probeCodewiki(healthyMachine());
    assert.equal(result.items.length, 5);
    assert.equal(result.ready, true);
    assert.equal(result.python?.version, "3.13.12");
    assert.equal(itemOf(result.items, "codewiki").version, "2.0.0");
    assert.equal(itemOf(result.items, "mcp").version, "1.30.0");
  });

  test("Python 3.11：python 一项红，且给出「装 3.12+」的下一步", async () => {
    const result = await probeCodewiki(healthyMachine({ python: "3.11.9" }));
    assert.equal(result.ready, false);
    const python = itemOf(result.items, "python");
    assert.equal(python.ok, false);
    assert.match(python.detail, /3\.11\.9 低于 3\.12/);
    assert.match(python.hint ?? "", /python\.org/);
  });

  test("mcp 2.x：点明是「2.x 移除了 list_tools」，并给出 mcp<2 的命令", async () => {
    const result = await probeCodewiki(healthyMachine({ mcp: "2.1.0" }));
    assert.equal(result.ready, false);
    const mcp = itemOf(result.items, "mcp");
    assert.equal(mcp.ok, false);
    assert.match(mcp.detail, /list_tools/);
    assert.match(mcp.hint ?? "", /mcp<2/);
  });

  test("codewiki 不是 2.0.0：不许当通过（产物格式随版本变）", async () => {
    const result = await probeCodewiki(healthyMachine({ codewiki: "1.9.0" }));
    assert.equal(result.ready, false);
    const codewiki = itemOf(result.items, "codewiki");
    assert.equal(codewiki.ok, false);
    assert.match(codewiki.detail, /不是 2\.0\.0/);
  });

  test("压根没有 Python：后两项明说是「没有可用的 Python」，不诬赖用户没装包", async () => {
    const run = fakeRunner([
      // 只让「Python 那三个候选」失败：`git --version` 也以 --version 结尾，用参数区分不开
      { match: (command) => ["python", "py", "python3"].includes(command), result: fail("spawn ENOENT") },
      { match: (command) => command === "git", result: ok("git version 2.47.1\n") },
    ]);
    const result = await probeCodewiki(run);
    assert.equal(result.ready, false);
    assert.equal(result.python, null);
    assert.equal(itemOf(result.items, "python").ok, false);
    assert.match(itemOf(result.items, "codewiki").detail, /没有可用的 Python/);
    assert.match(itemOf(result.items, "mcp").detail, /没有可用的 Python/);
    // git 不因为 Python 缺失而受牵连
    assert.equal(itemOf(result.items, "git").ok, true);
  });

  test("指定解释器（装好的 venv）时只查它，不再去 PATH 上挑", async () => {
    const run = healthyMachine();
    const result = await probeCodewiki(run, { command: "/rt/Scripts/python.exe", args: [] });
    assert.equal(result.python?.command, "/rt/Scripts/python.exe");
    // 第一次调用就该是那个解释器的 --version（不再按 python / py -3 / python3 逐个试）
    assert.deepEqual(run.calls[0], ["/rt/Scripts/python.exe", "--version"]);
  });
});

describe("用户级配置：只动我们那一条", () => {
  const withHome = async (body: (home: string) => Promise<void>): Promise<void> => {
    const home = await mkdtemp(join(tmpdir(), "colt-mcp-home-"));
    try {
      await body(home);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  };

  test("没有文件时新建，只写我们那一条", async () => {
    await withHome(async (home) => {
      const written = await upsertUserServer(home, "codewiki", { command: "x", args: ["mcp"] });
      assert.equal(written.servers.includes("codewiki"), true);
      const raw = JSON.parse(await readFile(join(home, ".colt", "mcp.json"), "utf8")) as {
        mcpServers: Record<string, unknown>;
      };
      assert.deepEqual(Object.keys(raw.mcpServers), ["codewiki"]);
      assert.deepEqual(raw.mcpServers.codewiki, { command: "x", args: ["mcp"] });
    });
  });

  test("别人的 server 与顶层未知字段原样保留（键序也不动）", async () => {
    await withHome(async (home) => {
      await mkdir(join(home, ".colt"), { recursive: true });
      await writeFile(
        join(home, ".colt", "mcp.json"),
        JSON.stringify(
          {
            $schema: "https://example.invalid/mcp.schema.json",
            mcpServers: {
              alpha: { command: "a" },
              beta: { url: "https://b.invalid/mcp" },
            },
          },
          null,
          2,
        ),
        "utf8",
      );
      await upsertUserServer(home, "codewiki", { command: "x" });
      const raw = JSON.parse(await readFile(join(home, ".colt", "mcp.json"), "utf8")) as {
        $schema: string;
        mcpServers: Record<string, unknown>;
      };
      assert.equal(raw.$schema, "https://example.invalid/mcp.schema.json");
      assert.deepEqual(Object.keys(raw.mcpServers), ["alpha", "beta", "codewiki"]);
      assert.deepEqual(raw.mcpServers.alpha, { command: "a" });
    });
  });

  test("配置坏了：报错并**保留原文件**，不替你改写", async () => {
    await withHome(async (home) => {
      const path = join(home, ".colt", "mcp.json");
      const broken = '{ "mcpServers": { "a": { "command": "x" } } ';
      await mkdir(join(home, ".colt"), { recursive: true });
      await writeFile(path, broken, "utf8");
      await assert.rejects(() => readUserConfig(home), /不是合法 JSON/);
      await assert.rejects(() => upsertUserServer(home, "codewiki", { command: "x" }), /不是合法 JSON/);
      assert.equal(await readFile(path, "utf8"), broken, "坏文件必须一个字节都不动");
    });
  });

  test("卸载只删同名那一条；本来就没有时如实说「没删」", async () => {
    await withHome(async (home) => {
      await mkdir(join(home, ".colt"), { recursive: true });
      await writeFile(
        join(home, ".colt", "mcp.json"),
        JSON.stringify({ mcpServers: { keep: { command: "k" }, codewiki: { command: "c" } } }),
        "utf8",
      );
      const removed = await removeUserServer(home, "codewiki");
      assert.equal(removed.removed, true);
      const raw = JSON.parse(await readFile(join(home, ".colt", "mcp.json"), "utf8")) as {
        mcpServers: Record<string, unknown>;
      };
      assert.deepEqual(Object.keys(raw.mcpServers), ["keep"]);
      assert.equal((await removeUserServer(home, "codewiki")).removed, false);
    });
  });
});

describe("安装 / 卸载：失败时什么都不写", () => {
  const withDirs = async (
    body: (dirs: { home: string; runtime: string }) => Promise<void>,
  ): Promise<void> => {
    const base = await mkdtemp(join(tmpdir(), "colt-mcp-install-"));
    const home = join(base, "home");
    const runtime = join(base, "runtimes", "codewiki");
    try {
      await body({ home, runtime });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  };

  test("没有 Python：停在探测，既不建 venv 也不写配置", async () => {
    await withDirs(async ({ home, runtime }) => {
      const run = fakeRunner([]);
      const result = await installPreset({
        preset: findPreset("codewiki")!,
        home,
        runtimeDir: runtime,
        run,
        probe: async () => ({
          ready: false,
          python: null,
          items: [
            {
              id: "python",
              label: "Python",
              kind: "host",
              ok: false,
              version: null,
              detail: "没找到",
              hint: "装 Python 3.12+",
            },
          ],
        }),
      });
      assert.equal(result.ok, false);
      assert.equal(result.steps.at(0)?.state, "failed");
      assert.equal(existsSync(join(home, ".colt", "mcp.json")), false);
      // 只探过，没跑过 `-m venv`
      assert.equal(run.calls.some((call) => call.includes("venv")), false);
    });
  });

  test("成功路径：venv → pip → 复检 → 配置指向 venv 里的 codewiki", async () => {
    await withDirs(async ({ home, runtime }) => {
      // 探测注入成「这台机器什么都装好了」：用例的结论不该取决于跑测试的机器装了什么
      const run = fakeRunner([
        { match: (_command, args) => args.includes("venv"), result: ok("") },
        {
          match: (_command, args) => args.includes("pip"),
          result: ok("Successfully installed codewiki-2.0.0 mcp-1.30.0\n"),
        },
        {
          match: (_command, args) => args.join(" ").includes("import codewiki, mcp"),
          result: ok("2.0.0\n1.30.0\n"),
        },
      ]);
      const preset = findPreset("codewiki")!;
      const result = await installPreset({
        preset,
        home,
        runtimeDir: runtime,
        run,
        probe: async () => ({
          ready: true,
          python: { command: "python", args: [], version: "3.13.12" },
          items: [],
        }),
      });
      assert.equal(result.ok, true, result.error ?? "");
      // 步骤齐了、顺序对：建 venv → 装包 → 复检 → 写配置
      assert.deepEqual(
        result.steps.map((step) => [step.id, step.state]),
        [
          ["probe", "ok"],
          ["venv", "ok"],
          ["pip", "ok"],
          ["verify", "ok"],
          ["config", "ok"],
        ],
      );
      // pip 真的拿到的就是钉住的那两条（拼错一个符号就是装错版本）
      const pipCall = run.calls.find((call) => call.includes("pip"));
      assert.notEqual(pipCall, undefined);
      assert.equal(pipCall!.slice(-2)[1], "mcp<2");
      assert.match(pipCall!.slice(-2)[0]!, /^codewiki @ git\+https:/);

      const raw = JSON.parse(await readFile(join(home, ".colt", "mcp.json"), "utf8")) as {
        mcpServers: Record<string, { command: string; args: string[] }>;
      };
      // 配置指向 venv 里的 console script（不是 PATH 上的那个 codewiki：那个可能根本不存在）
      assert.equal(raw.mcpServers.codewiki?.command, venvBinary(runtime, "codewiki"));
      assert.deepEqual(raw.mcpServers.codewiki?.args, ["mcp"]);
    });
  });

  test("同一运行时并发安装只跑一遍（第二次复用同一个 Promise）", async () => {
    await withDirs(async ({ home, runtime }) => {
      const run = fakeRunner([
        { match: (_command, args) => args.includes("venv"), result: ok("") },
        { match: (_command, args) => args.includes("pip"), result: ok("Successfully installed\n") },
        {
          match: (_command, args) => args.join(" ").includes("import codewiki, mcp"),
          result: ok("2.0.0\n1.30.0\n"),
        },
      ]);
      const probe = async () => ({
        ready: true,
        python: { command: "python", args: [], version: "3.13.12" },
        items: [],
      });
      const deps = { preset: findPreset("codewiki")!, home, runtimeDir: runtime, run, probe };
      // 两次调用**同时**发出去：竞态窗口正是「第一次还没跑完」的那段
      const [first, second] = await Promise.all([installPreset(deps), installPreset(deps)]);
      assert.equal(first.ok, true);
      assert.deepEqual(first, second, "第二次拿到的应当是第一次的同一份结论");
      assert.equal(
        run.calls.filter((call) => call.includes("venv")).length,
        1,
        "建 venv 只该跑一次",
      );
    });
  });

  test("装完复检不过（mcp 被拉成 2.x）：报失败且不写配置", async () => {
    await withDirs(async ({ home, runtime }) => {
      const run = fakeRunner([
        { match: (_command, args) => args.includes("venv"), result: ok("") },
        { match: (_command, args) => args.includes("pip"), result: ok("Successfully installed\n") },
        {
          match: (_command, args) => args.join(" ").includes("import codewiki, mcp"),
          result: ok("2.0.0\n2.1.0\n"),
        },
      ]);
      const result = await installPreset({
        preset: findPreset("codewiki")!,
        home,
        runtimeDir: runtime,
        run,
        probe: async () => ({
          ready: true,
          python: { command: "python", args: [], version: "3.13.12" },
          items: [],
        }),
      });
      assert.equal(result.ok, false);
      assert.equal(result.steps.at(-1)?.id, "verify");
      assert.equal(result.steps.at(-1)?.state, "failed");
      assert.match(result.steps.at(-1)?.detail ?? "", /mcp 装成了 2\.1\.0/);
      assert.equal(existsSync(join(home, ".colt", "mcp.json")), false, "半成品不该留下一条配置");
    });
  });

  test("卸载默认保留运行时；勾了才删目录", async () => {
    await withDirs(async ({ home, runtime }) => {
      const preset = findPreset("codewiki")!;
      await upsertUserServer(home, "codewiki", { command: "x", args: ["mcp"] });
      const kept = await uninstallPreset({ preset, home, runtimeDir: runtime });
      assert.equal(kept.ok, true);
      assert.equal(kept.steps.at(-1)?.state, "skipped", "默认那一档是「保留运行时」");
      await upsertUserServer(home, "codewiki", { command: "x", args: ["mcp"] });
      const purged = await uninstallPreset({ preset, home, runtimeDir: runtime, removeRuntime: true });
      assert.equal(purged.ok, true);
      assert.equal(purged.steps.at(-1)?.state, "ok");
      assert.equal(existsSync(runtime), false);
    });
  });
});
