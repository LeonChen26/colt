/**
 * 审批分析器解析测试。
 *
 * 分析器调用真实模型的部分依赖网络，不便单测；但「模型回复 → 放行结论」的
 * 解析是安全关键路径：解析失败必须回退到拒绝，绝不能把噪声当成放行。
 * 这里只覆盖纯函数 parseVerdict。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseVerdict } from "../src/main/approval/analyzer.ts";

describe("parseVerdict", () => {
  test("解析裸 JSON", () => {
    const verdict = parseVerdict('{"allow": true, "reason": "常规操作"}');
    assert.deepEqual(verdict, { allow: true, reason: "常规操作" });
  });

  test("解析 ```json 包裹", () => {
    const verdict = parseVerdict('```json\n{"allow": false, "reason": "删除系统文件"}\n```');
    assert.equal(verdict?.allow, false);
    assert.equal(verdict?.reason, "删除系统文件");
  });

  test("容忍前后噪声文字", () => {
    const verdict = parseVerdict('好的，结论如下：{"allow": true, "reason": "写入项目内"}\n以上。');
    assert.equal(verdict?.allow, true);
  });

  test("allow 缺失返回 null", () => {
    assert.equal(parseVerdict('{"reason": "没说 allow"}'), null);
  });

  test("allow 不是布尔返回 null", () => {
    assert.equal(parseVerdict('{"allow": "yes", "reason": "x"}'), null);
  });

  test("非 JSON 返回 null", () => {
    assert.equal(parseVerdict("这次调用看起来没问题"), null);
  });

  test("空字符串返回 null", () => {
    assert.equal(parseVerdict(""), null);
  });

  test("reason 缺失时给默认文案", () => {
    const allow = parseVerdict('{"allow": true}');
    assert.equal(allow?.allow, true);
    assert.ok((allow?.reason.length ?? 0) > 0);

    const deny = parseVerdict('{"allow": false}');
    assert.equal(deny?.allow, false);
    assert.match(deny?.reason ?? "", /高风险/);
  });

  test("空 reason 视为缺失", () => {
    const verdict = parseVerdict('{"allow": true, "reason": "   "}');
    assert.ok((verdict?.reason.length ?? 0) > 0);
  });
});
