// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 真实输入：凡会改变页面的动作都走 Chromium 的**输入管线**（CDP `Input.*`），
 * 而不是往页面里注入 JS 合成事件。
 *
 * 为什么换：合成的 `el.click()` 只派发一条 `click`，而真实鼠标点击实测会派发
 * `pointerdown → mousedown → focus → mouseup → click`（`isTrusted: true`）。
 * 差别不是「像不像人」，而是**功能上少了一整层**：监听 pointerdown/mousedown 的组件库
 * 不响应、点击后焦点不落到元素上、`:hover` / `:active` 伪类不变、依赖浏览器默认行为的
 * 按键（Tab 移焦点、Backspace 删字）不生效。同理 `el.value = text` 不产生 keydown/keyup。
 *
 * 通道用 Electron 内置的 `webContents.debugger`（upload 早已在用它），不引入 Playwright
 * 之类的额外依赖，也不额外起一个浏览器。
 *
 * 两条实测结论决定了这里的实现形态（都是探针跑出来的，不是推的）：
 *   ① **attach 与 DevTools 双向共存**：先 attach 再开 DevTools、先开 DevTools 再 attach，
 *      两种顺序都成功，`sendCommand` 全程可用。所以通道可以**常驻不摘**——反复 attach/detach
 *      每次都要重协商，且中间任何一个动作失败都会让后续动作没通道。
 *      （重复 attach 会抛「Debugger is already attached」，故入口做了 `isAttached` 幂等判断。）
 *   ② **不需要窗口聚焦、也不需要视图可见**：`show: false`、`isFocused: false` 的窗口上，
 *      鼠标与键盘事件照样送达页面且为 `isTrusted`。这条对自动化冒烟尤其重要——
 *      冒烟跑的时候窗口通常不在前台。
 *
 * ⚠️ 反过来说，这一层**只管把事件送进去**：事件会不会被页面接住、元素这一层能不能收到，
 * 由调用方在动作前用 `hitScript` 判定（见 `browser-scripts.ts`）。
 */

import type { WebContents } from "electron";
import { modifierMask, type KeySpec, type Modifier } from "./browser-keys";

/** Electron 的 debugger 只接受 "1.3"（其内部做真实版本协商） */
const PROTOCOL_VERSION = "1.3";

/**
 * 幂等挂上调试协议通道。
 *
 * 挂不上就**如实抛错**，绝不悄悄回落到合成事件——那会让「点击」在同一会话里有两套行为，
 * 而模型与用户都无从知道这次是哪种（比直接失败更贵：失败至少能被看见）。
 */
export function ensureInputChannel(contents: WebContents): void {
  const cdp = contents.debugger;
  if (cdp.isAttached()) return;
  try {
    cdp.attach(PROTOCOL_VERSION);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`无法挂载浏览器的输入通道（CDP）：${reason}`);
  }
}

/** 统一出口：保证通道已挂 + 把协议错误翻成能给模型读的话 */
async function send(
  contents: WebContents,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  ensureInputChannel(contents);
  try {
    return await contents.debugger.sendCommand(method, params);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`浏览器输入失败（${method}）：${reason}`);
  }
}

/**
 * 在视口坐标 (x, y) 处按下并释放左键——真实的鼠标事件。
 *
 * 坐标是**视口 CSS 像素**，与 `getBoundingClientRect()` 同一基准（实测 zoom 下亦然），
 * 所以调用方把 `hitScript` 算出的中心点原样传进来即可。
 *
 * 先 `mouseMoved` 再按下：鼠标先移过去这件事本身有副作用——`:hover` 伪类会生效
 * （实测：元素背景色真的变了），靠 hover 展开的菜单因此才点得到。少了这一步就是
 * 「在控件还没出现的状态下按下」。
 */
export async function clickAt(contents: WebContents, x: number, y: number): Promise<void> {
  const base = { x: x, y: y, button: "left" as const };
  await send(contents, "Input.dispatchMouseEvent", { type: "mouseMoved", x: x, y: y });
  await send(contents, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    clickCount: 1,
    ...base,
  });
  await send(contents, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    clickCount: 1,
    ...base,
  });
}

/**
 * 把文本插进**当前焦点**（调用方须先聚焦并全选，见 `focusScript`）。
 *
 * 走的是 Chromium 的文本插入路径，实测会派发 `input` 事件（`isTrusted: true`），
 * 且支持任意 Unicode（中文实测可用）。两条要知道的边界：
 *   - **不派发 keydown/keyup**：依赖按键联想的控件（自动补全、输入掩码）不会触发；
 *   - **不派发 change**：`change` 由失焦触发，这是真实打字的行为，不是缺陷。
 * 空串同样走这条路（实测：对全选的 input / contenteditable 都能清空，不是空操作）。
 */
export async function insertText(contents: WebContents, text: string): Promise<void> {
  await send(contents, "Input.insertText", { text: text });
}

/**
 * 按一次键（keyDown + keyUp），可带修饰键。
 *
 * 用 `keyDown` 而不是 `rawKeyDown`：后者不产生字符、pi 那边用它发组合键，但**本项目没实测过**；
 * 而 `keyDown` 已实测能触发页面 keydown 监听与浏览器默认行为（Backspace 删字符、Tab 移焦点、
 * Enter 被页面收到）。字符输入不依赖它——`keyDown` 不带 `text` 字段就不会插入文本。
 */
export async function pressKey(
  contents: WebContents,
  spec: KeySpec,
  modifiers: readonly Modifier[],
): Promise<void> {
  const base = {
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.vk,
    nativeVirtualKeyCode: spec.vk,
    modifiers: modifierMask(modifiers),
  };
  await send(contents, "Input.dispatchKeyEvent", { type: "keyDown", ...base });
  await send(contents, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
}
