// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 浏览器工具：worker 侧的薄封装。
 *
 * 工具本身不实现浏览器——真正的页面由主进程（BrowserHost）持有，这里只负责
 * 把模型的结构化入参翻译成宿主调用、再把结果（文本/图片）转成内核的工具结果。
 * 读写拆成三个工具而非一个万能工具：审批签名、风险分级与错误信息都更准确。
 */
import { Type } from "typebox";
import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core";
import { definedParams, hostResultToContent, type HostBridge } from "./host-bridge";

const readSchema = Type.Object({
  action: Type.Union([
    Type.Literal("snapshot"),
    Type.Literal("text"),
    Type.Literal("url"),
    Type.Literal("title"),
    Type.Literal("console"),
    Type.Literal("network"),
    Type.Literal("downloads"),
  ]),
});

const screenshotSchema = Type.Object({});

const actSchema = Type.Object({
  action: Type.Union([
    Type.Literal("navigate"),
    Type.Literal("click"),
    Type.Literal("type"),
    Type.Literal("scroll"),
    Type.Literal("wait"),
    Type.Literal("viewport"),
    Type.Literal("upload"),
  ]),
  url: Type.Optional(Type.String()),
  ref: Type.Optional(Type.String()),
  text: Type.Optional(Type.String()),
  direction: Type.Optional(Type.Union([Type.Literal("up"), Type.Literal("down")])),
  mode: Type.Optional(Type.Union([Type.Literal("load"), Type.Literal("text"), Type.Literal("idle")])),
  timeoutMs: Type.Optional(Type.Number()),
  width: Type.Optional(Type.Number()),
  height: Type.Optional(Type.Number()),
  paths: Type.Optional(Type.Array(Type.String())),
});

/** 浏览器工具集：读、截图、操作三件套，均为对宿主 BrowserHost 的薄封装 */
export function createBrowserTools(bridge: HostBridge): AgentHarnessTool<ExecutionToolContext>[] {
  const readTool: AgentHarnessTool<ExecutionToolContext, typeof readSchema, undefined> = {
    name: "browser_read",
    label: "Browser Read",
    description:
      "读取当前浏览器页面的信息（只读、无副作用）。" +
      "snapshot：返回页面可交互元素列表，每项带 ref（供 browser_act 点击/输入）；" +
      "text：返回页面正文；url / title：返回当前地址与标题；" +
      "console：返回自上次导航以来的控制台输出（error/warning 优先），用于排查脚本报错；" +
      "network：返回网络请求概览与失败请求（4xx/5xx/网络错误，含状态码与 URL）；" +
      "downloads：返回本会话已下载的文件列表（文件名、状态、落盘路径与来源）——" +
      "页面触发下载不会打断任何动作，用这个动作确认文件到底下来没有。",
    parameters: readSchema,
    async execute(_toolCallId, params) {
      const result = await bridge.call("browser", params.action, {});
      return { content: hostResultToContent(result), details: undefined };
    },
  };

  const screenshotTool: AgentHarnessTool<ExecutionToolContext, typeof screenshotSchema, undefined> = {
    name: "browser_screenshot",
    label: "Browser Screenshot",
    description: "截取当前浏览器页面的可见截图，以图片返回，供你判断页面状态。",
    parameters: screenshotSchema,
    async execute() {
      const result = await bridge.call("browser", "screenshot", {});
      return { content: hostResultToContent(result), details: undefined };
    },
  };

  const actTool: AgentHarnessTool<ExecutionToolContext, typeof actSchema, undefined> = {
    name: "browser_act",
    label: "Browser Act",
    description:
      "操作浏览器页面（wait 与 viewport 除外，其余会改变页面状态）。" +
      "navigate：打开 url；click：点击 snapshot 返回的 ref；" +
      "type：向 ref 输入 text；scroll：按 direction（up/down）滚动；" +
      "wait：等待页面就绪（只等不改），mode=load 等加载完成、mode=text 等 text 出现、" +
      "mode=idle 等 DOM 停止变化；省略 mode 时给了 text 按 text，否则按 idle。" +
      "SPA 页面导航或点击后先 wait 再 snapshot/text，否则容易读到半渲染状态；" +
      "超时可传 timeoutMs（默认 10000，上限 60000）。" +
      "viewport：设 width 与 height 调整视口（响应式联调用），两者必须同时给，都不给则恢复默认；" +
      "upload：向 ref（必须是 file 类型的 input）选择本地文件，paths 传绝对路径数组，" +
      "用于验证页面的文件上传流程；" +
      "点击 target=_blank 的链接时新窗口会被拦截并在当前窗口打开，不会另开窗口。",
    parameters: actSchema,
    async execute(_toolCallId, params) {
      const { action, ...rest } = params;
      const result = await bridge.call("browser", action, definedParams(rest));
      return { content: hostResultToContent(result), details: undefined };
    },
  };

  return [readTool, screenshotTool, actTool];
}
