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
import type { HostResult } from "@shared/worker-protocol";
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
  /**
   * 动作链：一次调用依次执行多个同页动作（填表场景不用逐字段往返）。
   * 只允许 click / type / scroll / wait——navigate 会换页（链的前提没了）、
   * upload / viewport 涉及审批粒度与本地磁盘，v1 都让模型单发。
   */
  actions: Type.Optional(
    Type.Array(
      Type.Object({
        action: Type.Union([
          Type.Literal("click"),
          Type.Literal("type"),
          Type.Literal("scroll"),
          Type.Literal("wait"),
        ]),
        ref: Type.Optional(Type.String()),
        text: Type.Optional(Type.String()),
        direction: Type.Optional(Type.Union([Type.Literal("up"), Type.Literal("down")])),
        mode: Type.Optional(Type.Union([Type.Literal("load"), Type.Literal("text"), Type.Literal("idle")])),
        timeoutMs: Type.Optional(Type.Number()),
      }),
    ),
  ),
});

type ChainItem = {
  action: "click" | "type" | "scroll" | "wait";
  ref?: string;
  text?: string;
  direction?: "up" | "down";
  mode?: "load" | "text" | "idle";
  timeoutMs?: number;
};

/** 链循环依赖的最小桥接口：只用到 call，冒烟装置用它接主进程的 hostBridge.handle */
export type ActionChainBridge = Pick<HostBridge, "call">;

/**
 * 执行动作链：逐动作走宿主 RPC（每次单独计时，不会占满 90s 上限），
 * 每个动作之后查页面指纹，页面跳转即中止并如实报告——后续动作的 ref 在新页面上
 * 已失效，继续执行只会把内容输进错误的页面。
 * 指纹竞态（跳转还没开始指纹未变）由下一个动作的「未找到元素」自然兜底，同样中止整链。
 */
export async function runActionChain(bridge: ActionChainBridge, items: ChainItem[]): Promise<HostResult> {
  const baseline = await bridge.call("browser", "fingerprint", {});
  const lines: string[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const { action, ...rest } = items[i];
    let result: HostResult;
    try {
      result = await bridge.call("browser", action, definedParams(rest));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        text:
          `动作链在第 ${i + 1} 个动作（${action}）失败，已中止：\n` +
          (lines.length > 0 ? lines.join("\n") + "\n" : "") +
          `失败原因：${reason}`,
      };
    }
    lines.push(`${i + 1}. ${result.text}`);
    // click 可能触发导航（链接 / 表单提交），但导航**开始**晚于 click 脚本的返回——
    // 提交任务排在渲染进程的队列里，立即查指纹会漏检（实测 GET 表单提交）。
    // 给一个稳定窗口，让提交任务跑起来、did-start-navigation 派发到位。
    if (action === "click") {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const fp = await bridge.call("browser", "fingerprint", {});
    if (fp.text !== baseline.text) {
      const remaining = items.length - i - 1;
      if (remaining === 0) {
        // 链尾触发跳转是常态（链尾常是提交按钮）：全部动作已执行完，这是「完成 + 换页」，
        // 报成「中止」会让模型误以为链出了问题。
        return {
          text:
            `动作链完成（共 ${items.length} 个动作），末个动作后页面已跳转：\n` +
            lines.join("\n") +
            `\n跳转后页面：${fp.text}\n请 wait 后重新 snapshot 再继续。`,
        };
      }
      return {
        text:
          `动作链在第 ${i + 1} 个动作后页面已跳转，已中止：\n` +
          lines.join("\n") +
          `\n跳转后页面：${fp.text}\n余下 ${remaining} 个动作未执行。` +
          "请 wait 后重新 snapshot 再继续。",
      };
    }
  }
  return { text: `动作链完成（共 ${items.length} 个动作）：\n${lines.join("\n")}` };
}

/** 浏览器工具集：读、截图、操作三件套，均为对宿主 BrowserHost 的薄封装 */
export function createBrowserTools(bridge: HostBridge): AgentHarnessTool<ExecutionToolContext>[] {
  const readTool: AgentHarnessTool<ExecutionToolContext, typeof readSchema, undefined> = {
    name: "browser_read",
    label: "Browser Read",
    description:
      "读取当前浏览器页面的信息（只读、无副作用）。" +
      "snapshot：返回页面**可见**可交互元素列表，每项带 ref（供 browser_act 点击/输入）；" +
      "隐藏元素与视口外元素不进清单——目标不在清单里时先 browser_act 滚动再重新 snapshot" +
      "（ref 是持久编号，滚动后不变）；**本页首次进入清单的元素前缀为 `*[`**，" +
      "滚动 / 页面变化后重新 snapshot 时用它快速定位新增元素；" +
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
    description:
      "截取当前浏览器页面的可见截图，以图片返回，供你判断页面状态。" +
      "截图上会给可见的交互元素叠画边框与 ref 编号，与 snapshot 清单一一对应——" +
      "看图即可把画面元素与 ref 对上号。",
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
      "点击 target=_blank 的链接时新窗口会被拦截并在当前窗口打开，不会另开窗口。" +
      "actions：动作链——同一页面上依次执行 click/type/scroll/wait（如多字段表单一次填完提交），" +
      "页面一旦跳转（含表单提交成功）链会自动中止并报告进度，跳转后请 wait + 重新 snapshot；" +
      "navigate / upload / viewport 不能进链，需要时单发。action 与 actions 二选一。",
    parameters: actSchema,
    async execute(_toolCallId, params) {
      if (params.actions !== undefined) {
        if (params.action !== undefined) throw new Error("action 与 actions 不能同时提供（二选一）");
        if (params.actions.length === 0) throw new Error("actions 不能为空数组");
        // type 缺 text 是「假成功」陷阱：host 侧把缺省当空串输入（清空字段）却回报
        // 「已输入到 eN」——链里漏写一个字段，得到的是「链完成、数据没填上」。
        // 显式 text:""（有意清空）照常放行。
        params.actions.forEach((item, index) => {
          if (item.action === "type" && item.text === undefined) {
            throw new Error(`actions[${index}] 的 type 动作缺少 text（要清空请显式传 text:""）`);
          }
        });
        return { content: hostResultToContent(await runActionChain(bridge, params.actions)), details: undefined };
      }
      const { action, ...rest } = params;
      const result = await bridge.call("browser", action, definedParams(rest));
      return { content: hostResultToContent(result), details: undefined };
    },
  };

  return [readTool, screenshotTool, actTool];
}
