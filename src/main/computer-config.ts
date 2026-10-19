// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 电脑控制（`computer_screenshot` / `computer_action`）的全局开关。
 *
 * **默认关**：这是实验能力，代价与风险都高于其余工具——
 * ① 仅 Windows 实现（每个动作 spawn 一次 PowerShell）；
 * ② 走 OS 级鼠标键盘注入，与浏览器工具在「操作页面」上职责重叠；
 * ③ 浏览器面板的「接管」只拦 `browser_act`，拦不住 OS 级点击。
 * 故默认不注册这两个工具，要用的人显式打开。
 *
 * 生效时机：工具清单在会话创建时确定，所以开关**对下个会话生效**——
 * 已开着的会话要重新打开才有（设置页文案也这么写）。这与写后诊断的
 * `diagnoseEnabled`（运行中即时下发）不同，别把两者混成一套。
 */
import { getSetting, setSetting } from "./db/repo";

const ENABLED_KEY = "computer.enabled";

/** 读取生效中的开关（从未配置过 = 关；坏记录也按关处理，与默认值一致） */
export function getComputerEnabled(): boolean {
  return getSetting(ENABLED_KEY) === "true";
}

/** 保存开关 */
export function setComputerEnabled(enabled: boolean): void {
  setSetting(ENABLED_KEY, enabled ? "true" : "false");
}
