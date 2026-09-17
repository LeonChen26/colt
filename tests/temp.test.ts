/**
 * 临时目录助手自身的测试。
 *
 * 重点不是「能建能删」，而是**守卫真的会拦**：`removeTempDir` 存在的意义是
 * 「绝不删错地方」，这条不变量如果只写不验，就等于把「删错也不会响」换了个地方藏。
 * 所以「未登记的路径被拒」必须同时断言两件事——**抛错**、且**目录还在**。
 * 只断言抛错的话，一个「先删再报错」的实现也能过。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isTempDirTracked,
  makeTempDir,
  makeTempDirAsync,
  removeTempDir,
  removeTempDirAsync,
} from "./helpers/temp";

describe("makeTempDir", () => {
  test("建在系统临时目录下，且带调用方给的前缀", () => {
    const dir = makeTempDir("colt-helper-");
    try {
      assert.equal(existsSync(dir), true);
      assert.equal(dir.startsWith(join(tmpdir(), "")), true, `实际路径：${dir}`);
      assert.match(dir, /colt-helper-/);
    } finally {
      removeTempDir(dir);
    }
  });

  test("登记在册；删掉后真的从盘上消失", () => {
    const dir = makeTempDir("colt-helper-");
    writeFileSync(join(dir, "a.txt"), "x", "utf8");
    assert.equal(isTempDirTracked(dir), true);

    removeTempDir(dir);

    assert.equal(existsSync(dir), false);
  });

  test("同一路径删两次：第二次是空操作，不抛", () => {
    const dir = makeTempDir("colt-helper-");
    removeTempDir(dir);
    assert.doesNotThrow(() => removeTempDir(dir));
  });

  test("一次传多个：都删掉", () => {
    const a = makeTempDir("colt-helper-a-");
    const b = makeTempDir("colt-helper-b-");
    removeTempDir(a, b);
    assert.equal(existsSync(a), false);
    assert.equal(existsSync(b), false);
  });

  test("带尾分隔符的写法也能认出来（登记的是规范化路径）", () => {
    const dir = makeTempDir("colt-helper-");
    removeTempDir(`${dir}/`);
    assert.equal(existsSync(dir), false);
  });
});

describe("removeTempDir 的守卫", () => {
  test("拒绝删除不是本模块建的目录，且拒绝时不删——目录仍在盘上", () => {
    // 绕开助手直接建：这正是守卫要挡下的用法
    const foreign = mkdtempSync(join(tmpdir(), "colt-helper-foreign-"));
    writeFileSync(join(foreign, "keep.txt"), "必须保住", "utf8");
    try {
      assert.throws(() => removeTempDir(foreign), /拒绝删除不是本模块创建的路径/);
      // 关键断言：抛了错但没动手。少了这一条，「先删再报错」也算过。
      assert.equal(existsSync(join(foreign, "keep.txt")), true);
    } finally {
      rmSync(foreign, { recursive: true, force: true });
    }
  });

  test("空串 / 相对路径这类「变量没赋上」的值，一律拒绝", () => {
    assert.throws(() => removeTempDir(""), /拒绝删除/);
    assert.throws(() => removeTempDir("."), /拒绝删除/);
    assert.throws(() => removeTempDir("tests"), /拒绝删除/);
  });

  test("删过之后仍认得这条路径（删除不撤销归属，重复清理才安全）", () => {
    const dir = makeTempDir("colt-helper-");
    removeTempDir(dir);
    assert.equal(isTempDirTracked(dir), true);
  });
});

describe("异步版", () => {
  test("makeTempDirAsync 建出来的，removeTempDirAsync 删得掉", async () => {
    const dir = await makeTempDirAsync("colt-helper-async-");
    assert.equal(existsSync(dir), true);
    await removeTempDirAsync(dir);
    assert.equal(existsSync(dir), false);
  });

  test("异步版的守卫同样生效", async () => {
    const foreign = await mkdtemp(join(tmpdir(), "colt-helper-foreign-"));
    try {
      await assert.rejects(() => removeTempDirAsync(foreign), /拒绝删除不是本模块创建的路径/);
      assert.equal(existsSync(foreign), true);
    } finally {
      rmSync(foreign, { recursive: true, force: true });
    }
  });

  test("两侧共用同一份登记表：异步建、同步删，走得通", async () => {
    const dir = await makeTempDirAsync("colt-helper-async-");
    removeTempDir(dir);
    assert.equal(existsSync(dir), false);
  });
});
