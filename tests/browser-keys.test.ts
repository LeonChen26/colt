/**
 * 按键表与修饰键校验的测试。
 *
 * 这层决定「模型说的键名会变成哪个键」：三元组（key / code / vk）对不上，按下去的是另一个键，
 * 页面照样会返回「已按键 Enter」——模型据此以为提交过了。所以常用键逐个钉住。
 *
 * 签名归一化同样在这里：`Enter` 与 `enter` 若落到两个签名上，用户批准过的会被再问一遍；
 * 而 `+` 这种要 shift 的符号必须**拒绝**（它的字符该走 type，不是按键），
 * 否则「输入 + 号」会变成「按 = 键」——静默按错键。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  comboSignature,
  formatCombo,
  keyLabel,
  modifierMask,
  normalizeKey,
  readModifiers,
  resolveKey,
} from "../src/main/host/browser-keys";

describe("resolveKey：键名 → CDP 三元组", () => {
  test("功能键给出正确的 key / code / vk", () => {
    assert.deepEqual(resolveKey("Enter"), { key: "Enter", code: "Enter", vk: 13 });
    assert.deepEqual(resolveKey("Escape"), { key: "Escape", code: "Escape", vk: 27 });
    assert.deepEqual(resolveKey("Tab"), { key: "Tab", code: "Tab", vk: 9 });
    assert.deepEqual(resolveKey("Backspace"), { key: "Backspace", code: "Backspace", vk: 8 });
    assert.deepEqual(resolveKey("ArrowDown"), { key: "ArrowDown", code: "ArrowDown", vk: 40 });
    assert.deepEqual(resolveKey("space"), { key: " ", code: "Space", vk: 32 });
  });

  test("字母 / 数字 / 基础符号：code 是物理键位，key 是字符本身", () => {
    assert.deepEqual(resolveKey("a"), { key: "a", code: "KeyA", vk: 65 });
    assert.deepEqual(resolveKey("Z"), { key: "z", code: "KeyZ", vk: 90 });
    assert.deepEqual(resolveKey("7"), { key: "7", code: "Digit7", vk: 55 });
    assert.deepEqual(resolveKey("/"), { key: "/", code: "Slash", vk: 191 });
  });

  test("大小写与首尾空白归一到同一个键（否则签名会分裂成两套）", () => {
    assert.deepEqual(resolveKey("  ENTER "), resolveKey("enter"));
    assert.equal(normalizeKey("  Enter "), "enter");
    assert.equal(normalizeKey("A"), "a");
  });

  test("未知键名报错，且错误里要给出可用键与替代办法", () => {
    assert.throws(() => resolveKey("F5"), /未知或缺失的按键名.*功能键/s);
    assert.throws(() => resolveKey("cmd"), /未知或缺失的按键名/);
  });

  test("要 shift 的符号被拒，并指向 type / 基础键+shift——不能静默按成别的键", () => {
    assert.throws(() => resolveKey("+"), /modifiers/);
    assert.throws(() => resolveKey("?"), /未知或缺失/);
    assert.equal(normalizeKey("+"), undefined);
  });

  test("缺失或非字符串一律拒绝（不能默默当成某个默认键）", () => {
    assert.throws(() => resolveKey(undefined), /未知或缺失/);
    assert.throws(() => resolveKey(""), /未知或缺失/);
    assert.throws(() => resolveKey(42), /未知或缺失/);
  });
});

describe("readModifiers：修饰键数组", () => {
  test("归一化大小写并去重，顺序按调用方给的来", () => {
    assert.deepEqual(readModifiers(["CTRL", "shift", "ctrl"]), ["ctrl", "shift"]);
  });

  test("不给就是不按修饰键", () => {
    assert.deepEqual(readModifiers(undefined), []);
    assert.deepEqual(readModifiers(null), []);
  });

  test("给了但形状不对 / 有未知项 → 报错并列出可用值", () => {
    assert.throws(() => readModifiers("ctrl"), /modifiers 需要数组/);
    assert.throws(() => readModifiers(["cmd"]), /未知的修饰键「cmd」/);
  });
});

describe("modifierMask：CDP 位掩码", () => {
  test("Alt=1 / Ctrl=2 / Meta=4 / Shift=8，可叠加", () => {
    assert.equal(modifierMask([]), 0);
    assert.equal(modifierMask(["ctrl"]), 2);
    assert.equal(modifierMask(["shift"]), 8);
    assert.equal(modifierMask(["ctrl", "shift"]), 10);
    assert.equal(modifierMask(["alt", "ctrl", "meta", "shift"]), 15);
  });
});

describe("formatCombo / comboSignature：给人看与给记忆用", () => {
  test("人读组合串按 Windows 习惯拼", () => {
    assert.equal(formatCombo(resolveKey("Enter"), ["ctrl"]), "Ctrl+Enter");
    assert.equal(formatCombo(resolveKey("a"), ["ctrl", "shift"]), "Ctrl+Shift+A");
    assert.equal(formatCombo(resolveKey("space"), []), "Space");
    assert.equal(formatCombo(resolveKey("Enter"), []), "Enter");
  });

  test("签名与顺序、大小写无关——同一次按键只能有一个签名", () => {
    assert.equal(comboSignature("a", ["shift", "ctrl"]), comboSignature("A", ["ctrl", "shift"]));
    assert.equal(comboSignature("  ENTER ", []), "enter");
    assert.equal(comboSignature("a", ["ctrl"]), "ctrl+a");
  });

  test("键名无法归一化时返回 undefined（调用方据此不落签名，而不是落一个假的）", () => {
    assert.equal(comboSignature("+", ["ctrl"]), undefined);
    assert.equal(comboSignature(undefined, []), undefined);
  });
});

describe("keyLabel：审批摘要用的人读写法（与签名分开）", () => {
  test("保留正式写法，修饰键用显示名", () => {
    assert.equal(keyLabel("Enter", []), "Enter");
    assert.equal(keyLabel("enter", ["ctrl"]), "Ctrl+Enter");
    assert.equal(keyLabel("  ENTER ", []), "Enter");
    assert.equal(keyLabel("a", ["shift", "ctrl"]), "Ctrl+Shift+A");
    assert.equal(keyLabel("space", []), "Space");
  });

  test("签名小写归一、标签保持可读——两者不得混用", () => {
    assert.equal(comboSignature("Enter", ["ctrl"]), "ctrl+enter");
    assert.equal(keyLabel("Enter", ["ctrl"]), "Ctrl+Enter");
  });

  test("认不出来就返回 undefined（调用方兑底），不抛错——摘要路径上不该因参数差而爆炸", () => {
    assert.equal(keyLabel("+", ["ctrl"]), undefined);
    assert.equal(keyLabel(undefined, []), undefined);
    assert.equal(keyLabel("a", "ctrl"), "A");
  });
});
