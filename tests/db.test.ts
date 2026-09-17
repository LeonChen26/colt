/**
 * 数据库连接生命周期测试：重点是「连接丢失后的自愈」（getDatabase 惰性重开）。
 *
 * 背景：首启门选「清空重来」时链路是「关连接 → 删业务数据 → 重开」，中途任一步失败
 * 都会让连接停在「已关闭」；旧实现下此后每个依赖库的 IPC 都持续报「数据库尚未初始化」，
 * 一次瞬时故障被放大成整场会话不可用。
 *
 * openDatabase 内部是模块级单例，每个用例前后都要把连接与记忆路径一并清干净。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir, removeTempDir } from "./helpers/temp";
import { openDatabase, closeDatabase, getDatabase, shutdownDatabase } from "../src/main/db/index.ts";

let root: string;

beforeEach(() => {
  shutdownDatabase();
  root = makeTempDir("colt-db-");
});

afterEach(() => {
  shutdownDatabase();
  removeTempDir(root);
});

function dbFile(userDataPath: string): string {
  return join(userDataPath, "data", "colt.db");
}

describe("getDatabase 自愈", () => {
  test("closeDatabase 之后：下次访问透明重开，且是同一个库（数据仍在）", () => {
    const db = openDatabase(root);
    db.exec("CREATE TABLE probe(x INTEGER)");
    db.prepare("INSERT INTO probe VALUES (1)").run();
    closeDatabase();

    const again = getDatabase();
    const row = again.prepare("SELECT x FROM probe").get() as { x: number };
    assert.equal(row.x, 1);
  });

  test("重开失败不会钉死会话：障碍排除后同一次运行内即可恢复", () => {
    openDatabase(root);
    closeDatabase();

    // 让重建必然失败：把 data 目录换成同名文件，mkdirSync 会抛错
    rmSync(join(root, "data"), { recursive: true, force: true });
    writeFileSync(join(root, "data"), "block", "utf8");
    assert.throws(() => getDatabase());

    // 排除障碍后无需重启，下一次访问自动重试成功
    rmSync(join(root, "data"), { force: true });
    const recovered = getDatabase();
    assert.equal(existsSync(dbFile(root)), true);
    assert.notEqual(recovered.prepare("PRAGMA user_version").get(), undefined);
  });

  test("从未 openDatabase 过：仍按原契约抛错", () => {
    assert.throws(() => getDatabase(), /数据库尚未初始化/);
  });

  test("shutdownDatabase 之后放弃自愈：抛错且不重建库文件", () => {
    openDatabase(root);
    shutdownDatabase();
    rmSync(join(root, "data"), { recursive: true, force: true });

    assert.throws(() => getDatabase(), /数据库尚未初始化/);
    assert.equal(existsSync(dbFile(root)), false);
  });
});
