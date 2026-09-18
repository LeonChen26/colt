// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 电脑控制工具：worker 侧的薄封装，实际截屏与键鼠注入由主进程 ComputerHost 完成。
 *
 * 强约束「先观察再操作」：ComputerHost 要求先截图、操作后作废截图，因此模型必须
 * 按 截图 → 操作 → 截图 的闭环推进。工具本身不做校验，保持薄。
 */
import { Type } from "typebox";
import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core";
import { definedParams, hostResultToContent, type HostBridge } from "./host-bridge";

const screenshotSchema = Type.Object({});

const actionSchema = Type.Object({
  action: Type.Union([
    Type.Literal("click"),
    Type.Literal("type"),
    Type.Literal("key"),
    Type.Literal("scroll"),
  ]),
  x: Type.Optional(Type.Number()),
  y: Type.Optional(Type.Number()),
  button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right")])),
  text: Type.Optional(Type.String()),
  keys: Type.Optional(Type.Array(Type.String())),
  delta: Type.Optional(Type.Number()),
});

/** 电脑控制工具集：截图 + 桌面操作 */
export function createComputerTools(bridge: HostBridge): AgentHarnessTool<ExecutionToolContext>[] {
  const screenshotTool: AgentHarnessTool<ExecutionToolContext, typeof screenshotSchema, undefined> = {
    name: "computer_screenshot",
    label: "Computer Screenshot",
    description:
      "截取整个屏幕画面（图片），用于观察当前桌面状态。任何电脑操作前都必须先执行本工具，" +
      "并基于返回画面中元素的像素坐标给出点击位置。",
    parameters: screenshotSchema,
    async execute() {
      const result = await bridge.call("computer", "screenshot", {});
      return { content: hostResultToContent(result), details: undefined };
    },
  };

  const actionTool: AgentHarnessTool<ExecutionToolContext, typeof actionSchema, undefined> = {
    name: "computer_action",
    label: "Computer Action",
    description:
      "操作整个桌面（会真实控制鼠标键盘）。" +
      "click：在 (x,y) 点击，button 可选 left/right；type：在当前焦点输入 text；" +
      "key：发送按键组合，如 [\"ctrl\",\"c\"]；scroll：在 (x,y) 按 delta 步数滚动，" +
      "delta 为正向下、为负向上。" +
      "每次操作前需先 computer_screenshot，操作后需再次截图确认结果。",
    parameters: actionSchema,
    async execute(_toolCallId, params) {
      const { action, ...rest } = params;
      const result = await bridge.call("computer", action, definedParams(rest));
      return { content: hostResultToContent(result), details: undefined };
    },
  };

  return [screenshotTool, actionTool];
}
