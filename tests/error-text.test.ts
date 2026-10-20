/**
 * 失败文案的翻译（`lib/error-text.ts`）。
 *
 * 约束来自 `docs/ERRORS.md` §四：给「原因 + 建议动作」，不透传底层原始报错；
 * 认不出的错误**原样保留**（不臆造原因），原始信息始终留在 `raw` 里供详情折叠。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { describeError, errorSummary } from "../src/renderer/src/lib/error-text.ts";

describe("describeError", () => {
  test("剥掉 Electron invoke 的包装前缀，raw 保持干净", () => {
    const result = describeError(
      "Error invoking remote method 'session.open': Error: ENOENT: no such file or directory, open 'C:\\x'",
    );
    assert.equal(result.summary, "文件或目录不存在");
    assert.ok(result.raw.startsWith("ENOENT: no such file"));
  });

  test("Error 实例与字符串走同一条路", () => {
    assert.equal(errorSummary(new Error("EACCES: permission denied")), "没有访问权限");
  });

  test("常见系统错误各给一句人话 + 建议动作", () => {
    assert.equal(errorSummary("ECONNREFUSED 127.0.0.1:5173"), "连接被拒绝");
    assert.equal(errorSummary("ETIMEDOUT"), "连接中断或超时");
    assert.equal(errorSummary("ENOSPC: no space left on device"), "磁盘空间不足");
    assert.equal(errorSummary("EISDIR: illegal operation on a directory"), "目标是一个目录，不是文件");
  });

  test("模型侧的鉴权 / 限流 / 额度 / 上下文分别归类", () => {
    assert.equal(errorSummary("Request failed with status 401"), "模型服务拒绝了鉴权");
    assert.equal(errorSummary("403 Forbidden"), "模型服务拒绝访问");
    assert.equal(errorSummary("429 Too Many Requests"), "请求太频繁，被服务商限流");
    assert.equal(errorSummary("insufficient_quota"), "账户额度不足");
    assert.equal(
      errorSummary("This model's maximum context length is 128000 tokens"),
      "上下文超出模型上限",
    );
  });

  test("状态码按整词匹配，不把 4011 当成 401", () => {
    const raw = "内部编号 #4011 处理失败";
    const result = describeError(raw);
    assert.equal(result.summary, raw);
    assert.equal(result.hint, undefined);
  });

  test("应用自己的开发者错误也翻成人话", () => {
    assert.equal(
      errorSummary("数据库尚未初始化，请先调用 openDatabase()"),
      "应用数据尚未就绪",
    );
    assert.equal(errorSummary("未找到 bash，命令工具不可用"), "没有找到可用的命令行环境");
  });

  test("认不出的错误原样返回，不臆造原因，也不给空提示", () => {
    const result = describeError("Something odd happened");
    assert.equal(result.summary, "Something odd happened");
    assert.equal(result.raw, "Something odd happened");
    assert.equal(result.hint, undefined);
  });

  test("空输入也有话说（不返回空串）", () => {
    assert.equal(describeError("").summary, "操作失败（没有更多信息）");
  });
});
