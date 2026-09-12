/**
 * Deferred 单元测试。
 *
 * 这个抽象存在的唯一理由是给就绪信号一个可用的失败出口：worker 在发回
 * 就绪事件前崩溃时，等待方必须被 reject 而不是永久挂起，否则上层的
 * session.open 会把界面永远卡在「正在启动会话进程…」。这里把该不变量锁住。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createDeferred } from "../src/main/lib/deferred.ts";

describe("createDeferred", () => {
  test("resolve 后 promise 兑现，settled 为真", async () => {
    const d = createDeferred<number>();
    assert.equal(d.settled, false);
    d.resolve(42);
    assert.equal(d.settled, true);
    assert.equal(await d.promise, 42);
  });

  test("reject 后 promise 失败，等待方能拿到原因", async () => {
    const d = createDeferred<void>();
    d.reject(new Error("进程在就绪前退出"));
    assert.equal(d.settled, true);
    await assert.rejects(d.promise, /就绪前退出/);
  });

  test("void 泛型可无参 resolve", async () => {
    const d = createDeferred<void>();
    d.resolve();
    await d.promise;
    assert.equal(d.settled, true);
  });

  test("重复 settle 只生效第一次", async () => {
    const d = createDeferred<string>();
    d.resolve("首次");
    d.resolve("第二次");
    d.reject(new Error("迟到"));
    assert.equal(await d.promise, "首次");
  });

  test("已 resolve 后 reject 不改变结果（exit 回调的空操作语义）", async () => {
    const d = createDeferred<void>();
    d.resolve();
    d.reject(new Error("worker 随后退出"));
    await d.promise; // 不该抛
    assert.equal(d.settled, true);
  });
});
