/**
 * 电脑控制键盘映射的纯函数测试。
 * 转义漏一个元字符就会把字面量变成控制键，这层必须可信。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { escapeSendKeysText, toSendKeysCombo } from "../src/main/host/input-keys.ts";

describe("escapeSendKeysText", () => {
  test("普通文本原样保留", () => {
    assert.equal(escapeSendKeysText("hello world 123"), "hello world 123");
  });

  test("元字符用花括号转义", () => {
    assert.equal(escapeSendKeysText("a+b"), "a{+}b");
    assert.equal(escapeSendKeysText("(x)"), "{(}x{)}");
    assert.equal(escapeSendKeysText("100%"), "100{%}");
    assert.equal(escapeSendKeysText("{a}[b]"), "{{}a{}}{[}b{]}");
  });

  test("中文等多字节字符不改写", () => {
    assert.equal(escapeSendKeysText("你好"), "你好");
  });
});

describe("toSendKeysCombo", () => {
  test("修饰键排在主键之前", () => {
    assert.equal(toSendKeysCombo(["ctrl", "c"]), "^c");
    assert.equal(toSendKeysCombo(["ctrl", "shift", "t"]), "^+t");
    assert.equal(toSendKeysCombo(["alt", "f4"]), "%{F4}");
  });

  test("具名按键映射为记号", () => {
    assert.equal(toSendKeysCombo(["enter"]), "{ENTER}");
    assert.equal(toSendKeysCombo(["ctrl", "delete"]), "^{DELETE}");
  });

  test("大小写与空白不敏感", () => {
    assert.equal(toSendKeysCombo(["CTRL", " C "]), "^c");
  });

  test("缺少主键时抛错", () => {
    assert.throws(() => toSendKeysCombo(["ctrl"]));
  });

  test("Win/Meta 键不支持，明确抛错", () => {
    assert.throws(() => toSendKeysCombo(["win", "r"]));
  });
});
