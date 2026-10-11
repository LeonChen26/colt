// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * worker 进程的环境装配：**白名单投影**，不是 `...process.env`。
 *
 * 为什么必须收敛（`docs/impl-plan-three-gaps-2026-10.md` 工作包 B）：fork 时全量继承
 * 环境变量 + 内核 bash 工具的 `inheritEnv: true`（`harness/tools/bash.js:33` /
 * `harness/env/nodejs.js` 的 `getShellEnv`）＝ 模型一条 `env`（或 `set`、`echo $XXX`）
 * 就能把密钥读回去。密钥本来只该活在**主进程内存 → init 消息体 → worker 内存**这条线上，
 * 一旦落进环境变量，那条线就白画了。
 *
 * ⚠️ 这份名单是**实测出来的**，不是凭印象列的（列法见下面的注释分节）。漏加一个键
 * 的症状往往很隐蔽：bash 工具找不到 Git Bash（少了 `ProgramFiles`/`PATH`）、
 * `os.homedir()` 落到 `C:\Windows\System32`（少了 `USERPROFILE`）、
 * 公司代理用户的模型请求全部超时（少了 `HTTPS_PROXY`）——都不会报「环境变量缺了」。
 *
 * ⚠️ 刻意**排除**的（写下来，免得将来被当成漏加）：
 *   - `NODE_OPTIONS`：它是**给每个 node 进程注入任意代码**的开关，等价于把
 *     「谁能写环境变量谁就能在 worker 里执行代码」这条通道留着；
 *   - `ELECTRON_RUN_AS_NODE`：把 Electron 按成 Node 启动的开关，worker 是
 *     `utilityProcess` 拉起的，不需要它；
 *   - 宿主进程自己的私有变量（`CODEBUDDY_*` / `WORKBUDDY_*` / `SANDBOX_*` 等）：
 *     与本应用无关，且这类名字里常带令牌。
 */
/**
 * 直接透传的宿主环境变量（非密钥）。
 *
 * 分节的理由：每一节都对应一类「少了它就静默出问题」的键，删改时能看出删的是哪一类。
 */
export const WORKER_ENV_PASSTHROUGH: readonly string[] = [
  // ① 进程与 shell 基础。PATH 还兼着内核 `findBashOnPath()` 的 `where bash.exe` 一职
  "PATH",
  "PATHEXT",
  "COMSPEC",
  "SystemRoot",
  "SystemDrive",
  "windir",
  // ② Windows 上定位 Git Bash：内核 `getShellConfig()` **直接读** ProgramFiles /
  //    ProgramFiles(x86)，读不到才回落 `where bash.exe`（那就得靠 PATH）
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "CommonProgramFiles",
  "CommonProgramFiles(x86)",
  "PROGRAMDATA",
  "ALLUSERSPROFILE",
  "PUBLIC",
  // ③ 家目录与临时目录：`os.homedir()` / `os.tmpdir()` 在 Windows 上就是读这几个
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "HOME",
  "APPDATA",
  "LOCALAPPDATA",
  // ④ 机器信息（日志 / 诊断展示用）
  "USERNAME",
  "USERDOMAIN",
  "COMPUTERNAME",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
  // ⑤ 语言 / 时区 / 运行模式
  "LANG",
  "LC_ALL",
  "TZ",
  "NODE_ENV",
  // ⑥ 网络出口：worker 自己就要发模型请求，公司代理与自签 CA 都挂在下面这几个名字上。
  //    少一个的症状是「模型请求全部超时／证书校验失败」，而没有任何一行代码会提到环境变量。
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "NODE_EXTRA_CA_CERTS",
];

/**
 * Colt 自己需要传给 worker 的**非密钥**控制变量。
 *
 * 三个都是 worker 侧真的会读的：`COLT_APPROVAL_DEBUG` 打审批链路日志、
 * `COLT_MCP_HOME` 决定 `~/.colt/mcp.json` 与 `~/.agents/skills` 落在哪、
 * `COLT_BUILTIN_SKILLS_DIR` 指内置技能目录（冒烟夹具靠它换一套技能）。
 * 它们过去是跟着 `...process.env` 一起过去的，白名单化之后必须显式转发——
 * 漏了就是「装好的技能突然看不见」「测试夹具失效」这类静默回归。
 */
export const WORKER_ENV_CONTROL: readonly string[] = [
  "COLT_APPROVAL_DEBUG",
  "COLT_BUILTIN_SKILLS_DIR",
  "COLT_MCP_HOME",
];

/**
 * 绝不允许出现在 worker 环境里的名字。
 *
 * 这不是「顺手加的防御」，而是本模块**唯一要保证的那件事**（worker env 里没有任何密钥）
 * 的可执行形态：白名单投影会把它们挡在外面，而控制变量这条显式通道必须由代码自己守住——
 * 传进来就直接抛，不静默丢弃（静默丢弃会让下一次有人在控制变量里塞密钥时**什么都没发生**，
 * 直到某天有人发现密钥又泄漏了）。
 */
export const FORBIDDEN_WORKER_ENV: readonly string[] = [
  "COLT_PROVIDER_KEY",
  "DEEPSEEK_API_KEY",
];

/** 环境名的比较口径：Windows 上不区分大小写，别让 `colt_provider_key` 绕过去 */
function envKeyOf(record: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  return Object.keys(record).find((key) => key.toLowerCase() === lower);
}

/**
 * 装配 worker 的环境。
 *
 * 语义三条：① 只放行 `WORKER_ENV_PASSTHROUGH` 里**在宿主机上确实存在且非空**的键——
 * 缺的键不写 `undefined`（写进去会被 Node 展开成字符串 `"undefined"`，
 * 比「没有这个变量」更糟：下游 `if (!value)` 判不出来）；
 * ② `control` 里的键一律覆盖并放行（调用方负责只放非密钥的东西）；
 * ③ 控制变量命中 `FORBIDDEN_WORKER_ENV` 直接抛错。
 */
export function buildWorkerEnv(
  source: NodeJS.ProcessEnv,
  control: Record<string, string> = {},
): Record<string, string> {
  for (const name of FORBIDDEN_WORKER_ENV) {
    const hit = envKeyOf(control, name);
    if (hit !== undefined) {
      throw new Error(
        `拒绝把密钥写进 worker 环境：${hit}。密钥只经 init 命令消息体传递（见 docs/impl-plan-three-gaps-2026-10.md 工作包 B）。`,
      );
    }
  }
  const out: Record<string, string> = {};
  for (const name of WORKER_ENV_PASSTHROUGH) {
    const value = source[name];
    if (typeof value === "string" && value !== "") out[name] = value;
  }
  for (const [key, value] of Object.entries(control)) out[key] = value;
  return out;
}

/** 从宿主环境里挑出 Colt 自己的非密钥控制变量（缺的 / 空的都不产生键） */
export function collectWorkerControl(source: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of WORKER_ENV_CONTROL) {
    const value = source[name];
    if (typeof value === "string" && value !== "") out[name] = value;
  }
  return out;
}
