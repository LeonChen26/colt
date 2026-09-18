// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 键盘输入到 Windows SendKeys 序列的纯转换。
 *
 * 与 Electron 无依赖，便于单测：注入实现（子进程）不好测，但这层映射逻辑必须可信——
 * 转义漏一个字符就会把字面量变成控制键。
 */

/** SendKeys 中这些字符是元字符，需用花括号包裹才能按字面发送 */
const SENDKEYS_SPECIAL: ReadonlySet<string> = new Set([
  "+", "^", "%", "~", "(", ")", "{", "}", "[", "]",
]);

/** 把任意文本转成 SendKeys 可安全发送的字面量 */
export function escapeSendKeysText(text: string): string {
  let out = "";
  for (const ch of text) out += SENDKEYS_SPECIAL.has(ch) ? `{${ch}}` : ch;
  return out;
}

/** 具名按键 → SendKeys 记号 */
const NAMED_KEYS: Record<string, string> = {
  enter: "{ENTER}",
  return: "{ENTER}",
  tab: "{TAB}",
  esc: "{ESC}",
  escape: "{ESC}",
  backspace: "{BACKSPACE}",
  delete: "{DELETE}",
  del: "{DELETE}",
  space: " ",
  up: "{UP}",
  down: "{DOWN}",
  left: "{LEFT}",
  right: "{RIGHT}",
  home: "{HOME}",
  end: "{END}",
  pageup: "{PGUP}",
  pagedown: "{PGDN}",
};

/**
 * 把 ["ctrl","c"] 这类按键组合转成 SendKeys 序列。
 * SendKeys 要求修饰键排在主键之前（如 `^c`）；不支持 Win/Meta 键，遇到即抛错。
 */
export function toSendKeysCombo(keys: readonly string[]): string {
  const modifiers: string[] = [];
  let main = "";
  for (const raw of keys) {
    const key = raw.trim().toLowerCase();
    if (key.length === 0) continue;
    if (key === "ctrl" || key === "control") modifiers.push("^");
    else if (key === "alt") modifiers.push("%");
    else if (key === "shift") modifiers.push("+");
    else if (key === "win" || key === "meta" || key === "cmd" || key === "super") {
      throw new Error("SendKeys 不支持 Win/Meta 键");
    } else if (key.length === 1) {
      // 单字符主键与文本同规：SendKeys 元字符（~ + ^ % ( ) { } [ ]）必须包花括号，
      // 否则 `~` 会被解释成 Enter、`+` 解释成 Shift——字面量变控制键。
      main = SENDKEYS_SPECIAL.has(key) ? `{${key}}` : key;
    }
    else main = NAMED_KEYS[key] ?? `{${key.toUpperCase()}}`;
  }
  if (main.length === 0) throw new Error("按键组合缺少主键（如 ctrl+c 中的 c）");
  return modifiers.join("") + main;
}
