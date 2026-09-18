/**
 * 工具图片落盘约定的单测：**命名与校验是 worker 写、主进程读之间唯一的共识**。
 *
 * 这里重点守的是 `safePathSegment` —— 它的输入（toolCallId 来自模型，sessionId 来自渲染层）
 * 是**不可信**的，而输出会被拼进文件路径。这条一旦漏，就是「用一张截图的名字去读写任意路径」。
 * 所以用例里把各类越界写法（`..`、绝对路径、分隔符）逐个喂进去，必须全部被拒。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  imageExtension,
  mimeForExtension,
  safePathSegment,
  toolImageFileName,
} from "../src/shared/tool-output.ts";

describe("safePathSegment：可拼进路径的标识", () => {
  test("正常的工具调用 id / 会话 id 放行", () => {
    assert.equal(safePathSegment("call_b44776378fba4487b7f6c130"), "call_b44776378fba4487b7f6c130");
    assert.equal(safePathSegment("01a0b298-d675-7488-b74a-d17ae5d411c4"), "01a0b298-d675-7488-b74a-d17ae5d411c4");
    assert.equal(safePathSegment("a"), "a");
  });

  test("上跳与相对路径片段一律拒绝——这是这条守卫存在的理由", () => {
    for (const evil of ["..", ".", "../foo", "../../etc/passwd", "..\\..\\win.ini"]) {
      assert.equal(safePathSegment(evil), undefined, `${evil} 不该被放行`);
    }
  });

  test("带分隔符 / 绝对路径 / 盘符的写法一律拒绝", () => {
    for (const evil of ["/etc/passwd", "C:\\Windows\\x", "a/b", "a\\b", "a.b/c"]) {
      assert.equal(safePathSegment(evil), undefined, `${evil} 不该被放行`);
    }
  });

  test("空串、以点或短横开头、超长一律拒绝", () => {
    assert.equal(safePathSegment(""), undefined);
    assert.equal(safePathSegment(".hidden"), undefined);
    assert.equal(safePathSegment("-x"), undefined);
    assert.equal(safePathSegment("_x"), undefined);
    assert.equal(safePathSegment("a".repeat(128)), "a".repeat(128));
    assert.equal(safePathSegment("a".repeat(129)), undefined);
  });

  test("对照：把校验去掉，同一批恶意值就会原样通过——证明断言不是空转", () => {
    const passthrough = (value: string): string => value;
    assert.equal(passthrough("../../etc/passwd"), "../../etc/passwd");
    assert.equal(safePathSegment("../../etc/passwd"), undefined);
  });
});

describe("图片扩展名 ↔ mimeType", () => {
  test("已知类型往返一致", () => {
    for (const [mime, ext] of [
      ["image/png", "png"],
      ["image/jpeg", "jpg"],
      ["image/webp", "webp"],
      ["image/gif", "gif"],
    ] as const) {
      assert.equal(imageExtension(mime), ext);
      assert.equal(mimeForExtension(ext), mime);
    }
  });

  test("大小写与空白不影响判定", () => {
    assert.equal(imageExtension("  IMAGE/PNG "), "png");
    assert.equal(mimeForExtension("PNG"), "image/png");
  });

  test("认不出的一律 undefined——宁可回落到内联，也不瞎猜一个扩展名", () => {
    assert.equal(imageExtension("image/tiff"), undefined);
    assert.equal(imageExtension("application/octet-stream"), undefined);
    assert.equal(imageExtension(""), undefined);
    assert.equal(mimeForExtension("tiff"), undefined);
  });

  test("jpeg 归一化到 jpg（两个扩展名都读得回来）", () => {
    assert.equal(imageExtension("image/jpeg"), "jpg");
    assert.equal(mimeForExtension("jpg"), "image/jpeg");
    assert.equal(mimeForExtension("jpeg"), "image/jpeg");
  });
});

describe("toolImageFileName：文件名 = 安全基名 + 已知扩展名", () => {
  test("两者都合法才给名字", () => {
    assert.equal(toolImageFileName("call_abc", "image/png"), "call_abc.png");
    assert.equal(toolImageFileName("call_abc", "image/jpeg"), "call_abc.jpg");
  });

  test("基名不安全 → undefined（越界值连文件名都拼不出来）", () => {
    assert.equal(toolImageFileName("../../x", "image/png"), undefined);
    assert.equal(toolImageFileName("a/b", "image/png"), undefined);
  });

  test("扩展名认不出 → undefined（调用方据此保留内联）", () => {
    assert.equal(toolImageFileName("call_abc", "image/tiff"), undefined);
  });
});
