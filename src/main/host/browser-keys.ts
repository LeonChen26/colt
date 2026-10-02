// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 按键表与修饰键校验：把模型给的键名翻译成 CDP `Input.dispatchKeyEvent` 需要的三元组
 * （`key` / `code` / `windowsVirtualKeyCode`）。
 *
 * 为什么独立成一个文件：这张表是「允许按哪些键」的**唯一真源**——宿主侧发键、审批侧归一化
 * 签名、报错文案里列可用键，都从它取。三处各写一份的话，改一处忘两处，表现是
 * 「签名记忆对不上」或「报错里列的键其实按不了」。
 *
 * 键名一律**小写、不带修饰**：组合键走独立的 `modifiers` 字段（`shift` + `tab`），
 * 而不是 `"Shift+Tab"` 这种字符串——后者要么自己解析一遍、要么多一套语法，
 * 而解析出来的东西又没法与 `modifiers` 的参数校验共用。
 *
 * 需要 shift 才能打出的**符号**（`+` `{` `?` 之类）刻意不收：那属于「输入文本」，
 * 该走 `type`（`Input.insertText`）；按键只负责「按哪个物理键」。两套说法都允许会打架。
 */

/** 允许的修饰键（对应 CDP 的位掩码，见 `modifierMask`） */
export const MODIFIERS = ["alt", "ctrl", "meta", "shift"] as const;
export type Modifier = (typeof MODIFIERS)[number];

/** CDP `Input.dispatchKeyEvent` 的修饰键位掩码：Alt=1 / Ctrl=2 / Meta=4 / Shift=8 */
const MODIFIER_MASK: Record<Modifier, number> = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

/** 摘要与回话里用的显示名 */
const MODIFIER_LABEL: Record<Modifier, string> = {
  alt: "Alt",
  ctrl: "Ctrl",
  meta: "Meta",
  shift: "Shift",
};

export interface KeySpec {
  /** CDP `key` 字段（字符键就是那个字符，功能键是 `Enter` 这类名字） */
  key: string;
  /** CDP `code` 字段（物理键位，如 `KeyA` / `Enter`） */
  code: string;
  /** Windows 虚拟键码 */
  vk: number;
}

/** 功能键（非字符）：键名 → 三元组。值显式含 undefined，好让「查不到」在类型上也看得见 */
const NAMED_KEYS: Record<string, KeySpec | undefined> = {
  enter: { key: "Enter", code: "Enter", vk: 13 },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  tab: { key: "Tab", code: "Tab", vk: 9 },
  space: { key: " ", code: "Space", vk: 32 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  delete: { key: "Delete", code: "Delete", vk: 46 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  home: { key: "Home", code: "Home", vk: 36 },
  end: { key: "End", code: "End", vk: 35 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 },
  pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
};

/**
 * 可打印字符键（US 布局的物理键位）。
 *
 * 只收**不需要 shift** 的基础键：字母、数字、以及 US 布局下直接可打的符号。
 * 带 shift 的符号（`!@#$%^&*()_+{}|:"<>?~`）由 shift + 基础键表达，
 * 但它们产生的**字符**该走 `type`，所以这里不给它们单独立名。
 */
const CHAR_KEYS: Record<string, { code: string; vk: number } | undefined> = (() => {
  const table: Record<string, { code: string; vk: number }> = {
    "-": { code: "Minus", vk: 189 },
    "=": { code: "Equal", vk: 187 },
    "[": { code: "BracketLeft", vk: 219 },
    "]": { code: "BracketRight", vk: 221 },
    "\\": { code: "Backslash", vk: 220 },
    ";": { code: "Semicolon", vk: 186 },
    "'": { code: "Quote", vk: 222 },
    ",": { code: "Comma", vk: 188 },
    ".": { code: "Period", vk: 190 },
    "/": { code: "Slash", vk: 191 },
    "`": { code: "Backquote", vk: 192 },
  };
  for (let index = 0; index < 26; index += 1) {
    const letter = String.fromCharCode(97 + index);
    table[letter] = { code: `Key${letter.toUpperCase()}`, vk: 65 + index };
  }
  for (let digit = 0; digit < 10; digit += 1) {
    table[String(digit)] = { code: `Digit${digit}`, vk: 48 + digit };
  }
  return table;
})();

/** 报错时列的可用键：分两组给，别糊成一行 */
function availableKeys(): string {
  const named = Object.keys(NAMED_KEYS).join(" / ");
  const chars = "a-z / 0-9 / - = [ ] \\ ; ' , . / `";
  return `功能键：${named}；字符键：${chars}`;
}

/**
 * 归一化键名（不抛错）：签名与「本会话不再询问」的记忆都靠它。
 *
 * 大小写、首尾空白不同必须落到**同一个签名**上，否则模型写 `Enter` 与 `enter`
 * 会被当成两件事，用户批准过的又被问一遍。
 */
export function normalizeKey(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const name = raw.trim().toLowerCase();
  if (name.length === 0) return undefined;
  if (NAMED_KEYS[name] !== undefined) return name;
  if (CHAR_KEYS[name] !== undefined) return name;
  return undefined;
}

/**
 * 查表：先找功能键、再找字符键，统一成 `KeySpec`。
 * `resolveKey` 与 `keyLabel` 共用它——两处各查一遍的话，「某个键只加了一张表」就会变成
 * 「能按但显示不出来」或反之。
 */
function lookupKey(name: string): KeySpec | undefined {
  const named = NAMED_KEYS[name];
  if (named !== undefined) return named;
  const char = CHAR_KEYS[name];
  if (char === undefined) return undefined;
  return { key: name, code: char.code, vk: char.vk };
}

/**
 * 把键名解析成 CDP 需要的三元组。
 *
 * 未知键名**如实报错并列出可用键**——按错键的代价是「页面上发生了别的事」，
 * 比「什么都不做」贵得多，所以宁可拒绝也不猜。
 */
export function resolveKey(raw: unknown): KeySpec {
  const name = normalizeKey(raw);
  const spec = name === undefined ? undefined : lookupKey(name);
  if (spec === undefined) {
    const shown = typeof raw === "string" && raw.trim().length > 0 ? `「${raw.trim()}」` : "";
    throw new Error(
      `未知或缺失的按键名${shown}。可用 ${availableKeys()}。` +
        `若要输入文本（含 + { ? 这类符号）请改用 type，组合键请传基础键 + modifiers（如 Ctrl+A 传 key:"a"、modifiers:["ctrl"]）`,
    );
  }
  return spec;
}

/**
 * 人读标签（与签名不同：**不抛错**、保留正式写法）：审批摘要与回话用它。
 *
 * 签名走 `comboSignature`（全小写、固定顺序，同一按键只能有一个），
 * 而给人看的应当是 `Ctrl+Enter` 这种。两者混用会出现「摘要写 enter」或「记忆分裂成两套」。
 */
export function keyLabel(rawKey: unknown, rawModifiers: unknown): string | undefined {
  const name = normalizeKey(rawKey);
  const spec = name === undefined ? undefined : lookupKey(name);
  if (spec === undefined) return undefined;
  const modifiers = Array.isArray(rawModifiers)
    ? MODIFIERS.filter((modifier) =>
        rawModifiers.some(
          (item) => typeof item === "string" && item.trim().toLowerCase() === modifier,
        ),
      )
    : [];
  return formatCombo(spec, modifiers);
}

/** 校验修饰键数组：未知项报错，重复项去重，顺序按调用方给的来 */
export function readModifiers(raw: unknown): Modifier[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`modifiers 需要数组（可用：${MODIFIERS.join(" / ")}）`);
  }
  const result: Modifier[] = [];
  for (const item of raw) {
    const name = typeof item === "string" ? item.trim().toLowerCase() : "";
    const known = MODIFIERS.find((modifier) => modifier === name);
    if (known === undefined) {
      throw new Error(`未知的修饰键「${String(item)}」（可用：${MODIFIERS.join(" / ")}）`);
    }
    if (!result.includes(known)) result.push(known);
  }
  return result;
}

/** CDP 的修饰键位掩码 */
export function modifierMask(modifiers: readonly Modifier[]): number {
  return modifiers.reduce((mask, modifier) => mask | MODIFIER_MASK[modifier], 0);
}

/** 人读的组合串，如 `Ctrl+Shift+A`——给回话与审批摘要用 */
export function formatCombo(spec: KeySpec, modifiers: readonly Modifier[]): string {
  const key = spec.key === " " ? "Space" : spec.key.length === 1 ? spec.key.toUpperCase() : spec.key;
  return [...modifiers.map((modifier) => MODIFIER_LABEL[modifier]), key].join("+");
}

/** 归一化后的组合签名（审批记忆用）：大小写与键序都钉死，`ctrl+a` 与 `a`+`ctrl` 是同一件事 */
export function comboSignature(rawKey: unknown, rawModifiers: unknown): string | undefined {
  const name = normalizeKey(rawKey);
  if (name === undefined) return undefined;
  // 修饰键在这里按固定顺序归一化：readModifiers 会抛错，签名路径上不该抛，故自己排一遍
  const mask = Array.isArray(rawModifiers)
    ? rawModifiers
        .map((item) => (typeof item === "string" ? item.trim().toLowerCase() : ""))
        .filter((item): item is Modifier => (MODIFIERS as readonly string[]).includes(item))
    : [];
  const ordered = MODIFIERS.filter((modifier) => mask.includes(modifier));
  return [...ordered, name].join("+");
}
