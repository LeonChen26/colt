// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * **内置可选 MCP 目录**——纯数据，不读盘、不起进程。
 *
 * 为什么要有这一层：现在的设置页只能「读声明」——用户在 `.colt/mcp.json` 里写了什么就显示
 * 什么。于是「Colt 支持 CodeWiki」这件事只存在于文档里，装不装、怎么装全靠用户自己知道。
 * 目录要解决的是「**看得见、点得动、卸得掉**」，而不是「首启往用户机器上塞东西」：
 * 默认一个都不装（`AGENTS.md` §3.6 的另一面——不能是死控件，也不能是隐形控件）。
 *
 * 三条边界：
 * 1. **这里只有数据**。探测、安装、卸载都在 `main/mcp/` 下——同一条目录要能被单测直接
 *    比对（形状、钉住的版本、server 名），不该为了读一行常量把 child_process 拖进来。
 * 2. **装的是「用户级」声明**（`~/.colt/mcp.json`，对全部项目生效）。写之前必须显式同意，
 *    这一点由界面负责说清（见 `docs/design-codewiki-integration-2026-10.md` §4 P1 纪律 ③）。
 * 3. **不夹带密钥**。目录里的条目一律是「本地 stdio + 无需密钥」那种；需要凭据的 server
 *    属于用户自己的配置，不进目录（进了就等于我们替用户决定把 key 放在哪）。
 */

/** 一条「钉死」的版本约束：探测项据此判定，界面据此说明为什么必须钉住 */
export interface McpPresetPin {
  /** 界面上的短标签，如「mcp」 */
  label: string;
  /** 人读的版本要求，如 `mcp < 2` */
  requirement: string;
  /** 为什么必须钉住——不写清楚，用户升级时只会觉得我们多事 */
  why: string;
}

/** 目录里的一个可选安装项 */
export interface McpPreset {
  /** 稳定 id：IPC 用它，**不要**用名字（名字是给人看的，会改） */
  id: string;
  /** 设置页里那一行的标题 */
  name: string;
  /** 一句话说清「装了能得到什么」 */
  tagline: string;
  /**
   * 装进 `~/.colt/mcp.json` 的 server 名（也是 `mcp__<name>__*` 工具前缀的来源）。
   * 卸载时**只**删这一条，别人的 entry 一行不动。
   */
  serverName: string;
  /** 该 server 启动参数（可执行文件由安装器按实际落点填） */
  serverArgs: string[];
  /**
   * 交给 pip 的**精确**依赖串（含版本钉死）。写成数组而不是从 `pins` 拼字符串：
   * `pins` 是给人读的（`= 2.0.0` 这种写法 pip 并不认），两者混用迟早出「看起来对、
   * 装出来错」的事。
   */
  requirements: string[];
  /** 不自动安装时的兜底：给用户自己粘的命令（逐条，界面照原样展示） */
  manualCommands: string[];
  /** 版本钉死（见 `docs/design-codewiki-integration-2026-10.md` D7） */
  pins: McpPresetPin[];
  /** 卸载时那句「要不要连运行时一起清」的说明 */
  runtimeNote: string;
}

/**
 * 首个条目：CodeWiki（仓库文档生成）。
 *
 * 实测结论都写进 `pins`，因为它们是这个条目存在的理由：`mcp>=2` 会让 CodeWiki 的 server
 * 直接起不来（2.x 移除了 `Server.list_tools()` 装饰器 API，`import codewiki.mcp.server`
 * 抛 AttributeError），而它自己的 `pyproject.toml` 只写了 `mcp>=1.0.0`——不钉就是我们
 * 把一个必然崩的组合推给用户。
 */
const CODEWIKI: McpPreset = {
  id: "codewiki",
  name: "CodeWiki（仓库文档生成）",
  tagline: "把仓库拆成模块树，逐页写 Markdown + Mermaid；模型据此先读文档、再读源码。",
  serverName: "codewiki",
  serverArgs: ["mcp"],
  requirements: ["codewiki==2.0.0", "mcp<2"],
  manualCommands: [
    'pip install "codewiki==2.0.0" "mcp<2"',
    '再在 ~/.colt/mcp.json 里加一条：{ "mcpServers": { "codewiki": { "command": "codewiki", "args": ["mcp"] } } }',
  ],
  pins: [
    {
      label: "Python",
      requirement: ">= 3.12",
      why: "CodeWiki 2.0 用了 3.12 的语法与标准库，3.11 及以下装得上也跑不起来。",
    },
    {
      label: "codewiki",
      requirement: "= 2.0.0",
      why: "MCP 工具的入参与模块树格式随版本变；跨版本混用会写出半份产物。",
    },
    {
      label: "mcp",
      requirement: "< 2",
      why: "2.x 移除了 Server.list_tools() 装饰器 API——装了就 import 失败，server 起不来（实测）。",
    },
  ],
  runtimeNote: "运行时是装在家目录里的独立 venv（约 60MB）。留着它，重装是秒级；清掉它，下次要重新下载。",
};

/** 全部可选安装项（顺序即界面顺序） */
export const MCP_CATALOG: readonly McpPreset[] = [CODEWIKI];

/** 按 id 取条目；未知 id 返回 undefined（IPC 据此回「没有这一项」而不是抛） */
export function findPreset(id: string): McpPreset | undefined {
  return MCP_CATALOG.find((preset) => preset.id === id);
}

/** 探测结果的单条读数（主进程产出、设置页展示，故类型放 shared） */
export interface McpProbeItem {
  /** 与 `McpPresetPin.label` 对齐的机器可读 id */
  id: "python" | "git" | "codewiki" | "mcp";
  label: string;
  ok: boolean;
  /** 读到的版本串（读不到为 null）——比「通过/不通过」多一层信息，排障时值这个宽度 */
  version: string | null;
  /** 一句人读的结论（缺什么、差在哪个版本） */
  detail: string;
  /** 可执行的下一步（缺件时才有；通过时为 null） */
  hint: string | null;
}

/** 目录项的完整状态：设置页那一行要显示的全部事实 */
export interface McpPresetState {
  id: string;
  name: string;
  tagline: string;
  /** 用户级配置里已经有一条同名的 server 声明 */
  installed: boolean;
  /** 运行时（venv）还在不在——`installed` 但这里 false，说明配置指向的路径已经没了 */
  runtime: boolean;
  /** 四连检（D7）：任何一项不过都不该让用户去点「生成」 */
  probe: { ready: boolean; items: McpProbeItem[] };
  /** 用户级配置的绝对路径（界面照原样显示，不让人猜） */
  configPath: string;
  manualCommands: string[];
  pins: McpPresetPin[];
  runtimeNote: string;
}

/** `mcp.catalog` 的响应：目录 + 每一项的现况 */
export interface McpCatalogView {
  presets: McpPresetState[];
  /**
   * 用户级配置读不了时的原话（能读为 null）。
   * 必须单独给：读不了的时候 `installed` 一律是 false，界面若不说这一句，
   * 「未安装」就成了一个不可信的结论——它可能只是「配置文件坏了」。
   */
  configError: string | null;
}

/** 安装 / 卸载的一步（进度事件与最终结果共用同一形状） */
export interface McpInstallStep {
  /** 机器可读的步骤 id */
  id: string;
  /** 人读的步骤名 */
  label: string;
  state: "running" | "ok" | "failed" | "skipped";
  /** 失败原因 / 关键输出（成功时给「装到哪、读到什么版本」） */
  detail: string | null;
}

/** `mcp.install` / `mcp.uninstall` 的响应 */
export interface McpInstallResult {
  ok: boolean;
  steps: McpInstallStep[];
  /** 失败时的收口结论（成功为 null） */
  error: string | null;
}

/** `mcp.installProgress` 事件载荷：**逐步**推送，免得一次几十秒的安装在界面上没有下文 */
export interface McpInstallProgress {
  presetId: string;
  action: "install" | "uninstall";
  step: McpInstallStep;
}
