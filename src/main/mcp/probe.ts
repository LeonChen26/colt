// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * CodeWiki 的**四连自检**（D7）：Python ≥ 3.12 / git / codewiki == 2.0.0 / mcp < 2。
 *
 * 为什么值得单独一层：这四项里有两项**不是理论风险**——
 * - `mcp>=2` 会让 CodeWiki 的 server 起不来（`Server.list_tools()` 装饰器 API 被移除），
 *   而它自己的依赖声明只写 `mcp>=1.0.0`，用户随手 `pip install -U` 就会踩；
 * - Python 3.11 及以下装得上、跑不起来（2.0 用了 3.12 的语法）。
 * 两件事的共同点：**报错现场与真实原因无关**。所以宁可在「装之前」逐项说清缺什么、
 * 附一条可执行的命令，也不要等用户在生成到一半时对着一句 AttributeError 猜。
 *
 * 设计约束：
 * 1. **执行器注入**（`Runner`）。单测要能覆盖「Python 3.11」「mcp 2.1」「压根没装 Python」
 *    这些分支，不能真去 spawn 用户的机器；生产走 `nodeSpawnRunner`。
 * 2. **只读**。探测不装东西、不写盘、不改配置——所以可以随设置页打开就刷，
 *    也可以在任何「要不要开始」之前跑。
 * 3. **不静默降级**。读不到版本时如实说「读不到」，不当作「通过」。
 */
import { spawn } from "node:child_process";
import type { McpProbeItem } from "@shared/mcp-catalog";
import { findPreset } from "@shared/mcp-catalog";

/** 一次命令执行的结果（只关心「跑起来了没、说了什么」） */
export interface CommandResult {
  /** 进程真的起来了且退出码为 0 */
  ok: boolean;
  /** 退出码；spawn 失败（ENOENT 等）为 null */
  code: number | null;
  stdout: string;
  stderr: string;
  /** spawn 层面的失败原因（命令不存在 / 超时被杀），与「跑起来但返回非 0」区分开 */
  error: string | null;
}

/** 执行一条命令（不经 shell，参数走数组） */
export type Runner = (command: string, args: string[]) => Promise<CommandResult>;

/** 单条命令的超时上限：版本查询本就是毫秒级，卡住说明这台机器有别的问题 */
const PROBE_TIMEOUT_MS = 8_000;

/**
 * 造一个执行器。超时可调——安装那几步（`python -m venv` / `pip install`）是分钟级的，
 * 拿版本查询的 8s 去套它们必然假红；而探针也不该等 pip 那么久。同一份实现、两种时限。
 */
export function createSpawnRunner(timeoutMs = PROBE_TIMEOUT_MS): Runner {
  return (command, args) =>
    new Promise<CommandResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      const done = (result: CommandResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(command, args, {
          windowsHide: true,
          shell: false,
          // stdin 必须显式 ignore：默认 "pipe" 会给子进程一个永不关闭的 stdin，
          // rg / pip 这类会「检测到可读就去读」的程序会挂到超时才失败（AGENTS.md §五）。
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        resolve({
          ok: false,
          code: null,
          stdout: "",
          stderr: "",
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      const timer = setTimeout(() => {
        child.kill();
        done({ ok: false, code: null, stdout, stderr, error: `超时（${timeoutMs}ms）` });
      }, timeoutMs);
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        done({ ok: false, code: null, stdout, stderr, error: error.message });
      });
      child.on("close", (code) => {
        done({ ok: code === 0, code, stdout, stderr, error: null });
      });
    });
}

/**
 * 生产执行器：`spawn` + 收集输出 + 超时兜底。
 *
 * `windowsHide` 不能省：Windows 上每探一次 `python` 都会闪一个黑框（设置页每次打开都探）。
 * 不经 shell 也不能省：命令与参数全来自代码里的常量，但仍然不该给 shell 一次解释机会。
 */
export const nodeSpawnRunner: Runner = createSpawnRunner();

/** 一次探测的结论 */
export interface ProbeResult {
  /** 四项全过才算「能跑」——界面据此决定「生成」入口亮不亮 */
  ready: boolean;
  /** 用哪个解释器（后面所有 python 检查都用它；没找到为 null） */
  python: { command: string; args: string[]; version: string } | null;
  items: McpProbeItem[];
}

/** `Python 3.13.12` → `[3, 13, 12]`；读不出返回 null（**不**猜成 0.0.0） */
export function parseVersion(text: string): [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** 版本比较：a >= b */
export function atLeast(a: [number, number, number], b: [number, number, number]): boolean {
  for (let index = 0; index < 3; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

/**
 * Python 解释器候选。Windows 上 `py -3` 常常是唯一在 PATH 上的那个（商店版 python 的
 * `python.exe` 是别名，反而会弹应用商店），所以三个都试，谁先报出版本就用谁。
 */
const PYTHON_CANDIDATES: { command: string; args: string[] }[] = [
  { command: "python", args: [] },
  { command: "py", args: ["-3"] },
  { command: "python3", args: [] },
];

/** `python -c "<code>"` 的一行输出（取最后一个非空行，脚本里 print 的东西可能多行） */
function lastLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.at(-1) ?? "";
}

const HINT_PYTHON =
  "装 Python 3.12+：https://www.python.org/downloads/ （Windows 安装时勾选 Add python.exe to PATH）";
const HINT_GIT = "装 git：https://git-scm.com/downloads （CodeWiki 用 git 判断产物落后几个提交）";
const HINT_NODE =
  "装 Node.js 18+：https://nodejs.org/ （npm 随它一起装；装期 PythonMonkey 会调 npm）";

/**
 * 跑一次前置检查（五项）。
 *
 * 顺序有讲究：先 Python（后面两项包里版本都要用它），再 git 与 npm（两个宿主机条件，
 * 与 Python 无关，缺了也照样报），最后才查包里那两个——没有 Python 时不能把
 * 「没装 codewiki」当成用户的问题。
 *
 * 这五项分两类（`kind`）：`host` 是机器上本来就该有的，`payload` 是装这一项时才由我们装的。
 * 界面据此只把 `host` 当「能不能装」的门禁——未装时 `payload` 必然是「未安装」，摆出来是废话。
 */
export async function probeCodewiki(
  run: Runner = nodeSpawnRunner,
  pythonOverride?: { command: string; args: string[] },
): Promise<ProbeResult> {
  const items: McpProbeItem[] = [];
  let python: ProbeResult["python"] = null;

  if (pythonOverride !== undefined) {
    // 指定了解释器就**只**用它（装好的 venv）。它的版本也要照章检查：venv 用的是建它的
    // 那个 Python，低于 3.12 时照样跑不起来，不能因为「这是我们自己装的」就免检。
    const result = await run(pythonOverride.command, [...pythonOverride.args, "--version"]);
    const text = `${result.stdout}\n${result.stderr}`;
    const parsed = result.ok ? parseVersion(text) : null;
    if (parsed !== null) {
      python = {
        command: pythonOverride.command,
        args: pythonOverride.args,
        version: `${parsed[0]}.${parsed[1]}.${parsed[2]}`,
      };
    }
  } else {
    for (const candidate of PYTHON_CANDIDATES) {
      const result = await run(candidate.command, [...candidate.args, "--version"]);
      if (!result.ok) continue;
      // Windows 的 `py -3 --version` 把版本写在 stdout；某些发行版写 stderr——两处都看
      const text = `${result.stdout}\n${result.stderr}`;
      const parsed = parseVersion(text);
      if (parsed === null) continue;
      python = { ...candidate, version: `${parsed[0]}.${parsed[1]}.${parsed[2]}` };
      break;
    }
  }

  if (python === null) {
    items.push({
      id: "python",
      label: "Python",
      kind: "host",
      ok: false,
      version: null,
      detail: "没找到可用的 Python 解释器（试过 python / py -3 / python3）",
      hint: HINT_PYTHON,
    });
  } else {
    const parsed = parseVersion(python.version) ?? [0, 0, 0];
    const ok = atLeast(parsed, [3, 12, 0]);
    items.push({
      id: "python",
      label: "Python",
      kind: "host",
      ok,
      version: python.version,
      detail: ok
        ? `${python.command} ${python.version}`
        : `${python.command} ${python.version} 低于 3.12（CodeWiki 2.0 用到了 3.12 的语法）`,
      hint: ok ? null : HINT_PYTHON,
    });
  }

  const git = await run("git", ["--version"]);
  const gitVersion = parseVersion(git.ok ? git.stdout : "");
  items.push({
    id: "git",
    label: "git",
    kind: "host",
    ok: git.ok,
    version: gitVersion === null ? null : gitVersion.join("."),
    detail: git.ok
      ? lastLine(git.stdout)
      : `git 不可用：${git.error ?? (lastLine(git.stderr) || `退出码 ${String(git.code)}`)}`,
    hint: git.ok ? null : HINT_GIT,
  });

  /**
   * Node.js：这是**装期**依赖，不在任何 Python 依赖声明里。
   *
   * 依赖链是 `mermaid-parser-py` → PythonMonkey → 安装时 `pminit` 调 npm 拉 JS 依赖。
   * 缺了 npm，pip 会在构建阶段失败，报错还不在 Python 的栈里——用户完全看不出
   * "装个 Python 包为什么要 Node"。所以必须提前查、提前说。
   *
   * 探 `node` 而不是 `npm`：Windows 上 npm 是 `npm.cmd`，`spawn` 不能直接执行它
   * （要 `shell: true`，而我们刻意不用 shell——那条路会把命令串交给 cmd.exe 解析）。
   * `node` 是 `node.exe`，可以直连。npm 随 Node 一起装，存在性等同。
   */
  const node = await run("node", ["--version"]);
  const nodeVersion = node.ok ? lastLine(node.stdout).replace(/^v/, "") : null;
  items.push({
    id: "node",
    label: "Node.js",
    kind: "host",
    ok: node.ok,
    version: nodeVersion,
    detail: node.ok
      ? `node ${nodeVersion ?? "已安装"}（npm 随它一起装）`
      : `node 不可用：${node.error ?? (lastLine(node.stderr) || `退出码 ${String(node.code)}`)}`,
    hint: node.ok ? null : HINT_NODE,
  });

  // 后面两项都要用**选中的那个**解释器跑：`py -3` 与 `python` 可能是两个不同的环境
  const pyArgs = python === null ? null : [...python.args];
  const readPackageVersion = async (module: string): Promise<{
    version: string | null;
    detail: string;
  }> => {
    if (pyArgs === null) {
      return { version: null, detail: "没有可用的 Python，无从检查" };
    }
    const result = await run(python?.command ?? "python", [
      ...pyArgs,
      "-c",
      `import ${module} as m; print(getattr(m, "__version__", ""))`,
    ]);
    if (!result.ok) {
      const reason = lastLine(result.stderr) || result.error || `退出码 ${String(result.code)}`;
      return { version: null, detail: `未安装（${reason.split(/\r?\n/).at(-1) ?? reason}）` };
    }
    const version = lastLine(result.stdout);
    return {
      version: version === "" ? null : version,
      detail: version === "" ? "已安装但读不到版本号" : `已安装 ${version}`,
    };
  };

  const codewiki = await readPackageVersion("codewiki");
  const codewikiVersion = codewiki.version === null ? null : parseVersion(codewiki.version);
  const codewikiOk =
    codewikiVersion !== null &&
    codewikiVersion[0] === 2 &&
    codewikiVersion[1] === 0 &&
    codewikiVersion[2] === 0;
  items.push({
    id: "codewiki",
    label: "codewiki",
    kind: "payload",
    ok: codewikiOk,
    version: codewiki.version,
    detail:
      codewikiVersion === null
        ? codewiki.detail
        : codewikiOk
          ? codewiki.detail
          : `${codewiki.version} 不是 2.0.0（工具入参与产物格式随版本变，必须钉住）`,
    // 手动命令**从目录里取**，不在这里重写一遍：安装串一变（比如从 PyPI 名改成 git 地址），
    // 两处就会各说各的——而用户照着这里抄的那条才是他真会执行的
    hint: codewikiOk ? null : (findPreset("codewiki")?.manualCommands[0] ?? null),
  });

  const mcp = await readPackageVersion("mcp");
  const mcpVersion = mcp.version === null ? null : parseVersion(mcp.version);
  const mcpOk = mcpVersion !== null && mcpVersion[0] < 2;
  items.push({
    id: "mcp",
    label: "mcp",
    kind: "payload",
    ok: mcpOk,
    version: mcp.version,
    detail:
      mcpVersion === null
        ? mcp.detail
        : mcpOk
          ? mcp.detail
          : `${mcp.version} 是 2.x：它移除了 Server.list_tools() 装饰器 API，CodeWiki 的 server 会 import 失败`,
    hint: mcpOk ? null : 'pip install "mcp<2"',
  });

  return { ready: items.every((item) => item.ok), python, items };
}
