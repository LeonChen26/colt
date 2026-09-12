/**
 * schema 迁移测试：造各种旧库形态，验证 openDatabase 能补齐列并置对版本号。
 * openDatabase 内部有模块级单例，每个用例结束必须 closeDatabase()。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, closeDatabase, getDatabase } from "../src/main/db/index.ts";

/** 当前目标版本，与 db/index.ts 的 SCHEMA_VERSION 保持一致 */
const LATEST = 5;

let root: string;

beforeEach(() => {
  closeDatabase();
  root = mkdtempSync(join(tmpdir(), "banyan-migrate-"));
});

afterEach(() => {
  closeDatabase();
  rmSync(root, { recursive: true, force: true });
});

function columns(db: DatabaseSync, table: string): string[] {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => (row as { name: string }).name);
}

function userVersion(db: DatabaseSync): number {
  return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

/** 直接在目标位置造一个已存在的库文件，模拟旧版本 */
function seedLegacy(
  userDataPath: string,
  statements: string[],
  version = 0,
): void {
  mkdirSync(join(userDataPath, "data"), { recursive: true });
  const raw = new DatabaseSync(join(userDataPath, "data", "banyan.db"));
  for (const sql of statements) raw.exec(sql);
  raw.exec(`PRAGMA user_version = ${version}`);
  raw.close();
}

/** M1 时代的完整建表语句（缺后加的列） */
const LEGACY_SCHEMA = [
  `CREATE TABLE sessions (
     id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, jsonl_path TEXT NOT NULL,
     kernel_session_id TEXT, preset_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
     message_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active')`,
  `CREATE TABLE file_changes (
     id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_call_id TEXT,
     file_path TEXT NOT NULL, change_kind TEXT NOT NULL, diff_text TEXT,
     added_lines INTEGER NOT NULL DEFAULT 0, removed_lines INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL)`,
  `CREATE TABLE usage_records (
     id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, run_id TEXT, provider TEXT,
     model TEXT, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
     cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
     cost_usd REAL NOT NULL DEFAULT 0, latency_ms INTEGER, created_at INTEGER NOT NULL)`,
];

describe("openDatabase 迁移", () => {
  test("全新库直接建到最新版本", () => {
    const db = openDatabase(root);
    assert.equal(userVersion(db), LATEST);
    assert.ok(columns(db, "sessions").includes("model_ref"));
    assert.ok(columns(db, "file_changes").includes("client_change_id"));
    assert.ok(columns(db, "usage_records").includes("kernel_usage_id"));
  });

  test("重开同一库版本号不变", () => {
    openDatabase(root);
    closeDatabase();
    const db = openDatabase(root);
    assert.equal(userVersion(db), LATEST);
  });

  test("旧库从 v0 补齐全部后加列", () => {
    seedLegacy(root, LEGACY_SCHEMA, 0);
    const db = openDatabase(root);
    assert.equal(userVersion(db), LATEST);
    assert.ok(columns(db, "sessions").includes("kernel_session_id"));
    assert.ok(columns(db, "sessions").includes("model_ref"));
    assert.ok(columns(db, "file_changes").includes("client_change_id"));
    assert.ok(columns(db, "usage_records").includes("kernel_usage_id"));
  });

  test("列已补但版本号仍为 0 的库（历史 try/catch 遗留）幂等迁移成功", () => {
    // 这正是从旧实现升级上来的真实库形态
    seedLegacy(
      root,
      [
        `CREATE TABLE sessions (
           id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, jsonl_path TEXT NOT NULL,
           kernel_session_id TEXT, preset_id TEXT, model_ref TEXT, created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL, message_count INTEGER NOT NULL DEFAULT 0,
           status TEXT NOT NULL DEFAULT 'active')`,
        `CREATE TABLE file_changes (
           id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, client_change_id TEXT,
           tool_call_id TEXT, file_path TEXT NOT NULL, change_kind TEXT NOT NULL, diff_text TEXT,
           added_lines INTEGER NOT NULL DEFAULT 0, removed_lines INTEGER NOT NULL DEFAULT 0,
           created_at INTEGER NOT NULL)`,
        `CREATE TABLE usage_records (
           id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, kernel_usage_id TEXT,
           run_id TEXT, provider TEXT, model TEXT, input_tokens INTEGER NOT NULL DEFAULT 0,
           output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
           cache_write_tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
           latency_ms INTEGER, created_at INTEGER NOT NULL)`,
      ],
      0,
    );
    const db = openDatabase(root);
    assert.equal(userVersion(db), LATEST);
  });

  test("从中间版本（v2）继续升级，只补剩下的列", () => {
    // 造一个真正停在 v2 的库：前两个迁移已应用，后续的还没有
    seedLegacy(
      root,
      [
        `CREATE TABLE sessions (
           id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, jsonl_path TEXT NOT NULL,
           kernel_session_id TEXT, preset_id TEXT, model_ref TEXT, created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL, message_count INTEGER NOT NULL DEFAULT 0,
           status TEXT NOT NULL DEFAULT 'active')`,
        // v3 的 client_change_id 尚未加
        `CREATE TABLE file_changes (
           id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_call_id TEXT,
           file_path TEXT NOT NULL, change_kind TEXT NOT NULL, diff_text TEXT,
           added_lines INTEGER NOT NULL DEFAULT 0, removed_lines INTEGER NOT NULL DEFAULT 0,
           created_at INTEGER NOT NULL)`,
        // v4 的 kernel_usage_id 尚未加
        `CREATE TABLE usage_records (
           id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, run_id TEXT, provider TEXT,
           model TEXT, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
           cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
           cost_usd REAL NOT NULL DEFAULT 0, latency_ms INTEGER, created_at INTEGER NOT NULL)`,
      ],
      2,
    );
    const db = openDatabase(root);
    assert.equal(userVersion(db), LATEST);
    assert.ok(columns(db, "file_changes").includes("client_change_id"));
    assert.ok(columns(db, "usage_records").includes("kernel_usage_id"));
  });

  test("旧库带存量用量数据升级：数据不丢，唯一索引仍能建立", () => {
    seedLegacy(root, LEGACY_SCHEMA, 0);
    // 存量行的 kernel_usage_id 均为 NULL，依赖 SQLite「多个 NULL 互不相等」才能建唯一索引
    const raw = new DatabaseSync(join(root, "data", "banyan.db"));
    for (let i = 0; i < 5; i += 1) {
      raw
        .prepare(
          "INSERT INTO usage_records (session_id, provider, model, input_tokens, created_at)" +
            " VALUES ('s1','deepseek','v4',?,?)",
        )
        .run(100 + i, 1700000000 + i);
    }
    raw.close();

    const db = openDatabase(root);
    assert.equal(userVersion(db), LATEST);

    const count = db.prepare("SELECT COUNT(*) AS c FROM usage_records").get() as { c: number };
    assert.equal(count.c, 5, "存量数据不应丢失");

    const index = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_usage_kernel_id'")
      .get();
    assert.ok(index, "幂等唯一索引应已建立");

    // 升级后幂等键真实生效
    db.prepare(
      "INSERT INTO usage_records (session_id, kernel_usage_id, created_at) VALUES ('s1','k-1',1)",
    ).run();
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT INTO usage_records (session_id, kernel_usage_id, created_at) VALUES ('s1','k-1',2)",
          )
          .run(),
      /UNIQUE/,
    );
  });

  test("迁移后 getDatabase 返回可用连接", () => {
    openDatabase(root);
    const db = getDatabase();
    // 建表成功即可查
    const row = db.prepare("SELECT COUNT(*) AS c FROM sessions").get() as { c: number };
    assert.equal(row.c, 0);
  });

  test("新库 projects 含 root_key 且唯一索引生效", () => {
    const db = openDatabase(root);
    assert.ok(columns(db, "projects").includes("root_key"));
    const index = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_projects_root_key'")
      .get();
    assert.ok(index, "root_key 唯一索引应已建立");
  });

  test("v5 迁移合并同一目录的不同路径写法，并迁移其会话", () => {
    seedLegacy(
      root,
      [
        `CREATE TABLE projects (
           id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL UNIQUE,
           created_at INTEGER NOT NULL, last_opened_at INTEGER NOT NULL)`,
        `CREATE TABLE sessions (
           id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, jsonl_path TEXT NOT NULL,
           kernel_session_id TEXT, preset_id TEXT, model_ref TEXT, created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL, message_count INTEGER NOT NULL DEFAULT 0,
           status TEXT NOT NULL DEFAULT 'active')`,
        // 同一目录的三种写法
        `INSERT INTO projects VALUES ('p1','banyan','E:/code/banyan',100,100)`,
        `INSERT INTO projects VALUES ('p2','banyan','e:\\code\\banyan',200,300)`,
        `INSERT INTO projects VALUES ('p3','banyan','E:\\code\\banyan',150,150)`,
        `INSERT INTO sessions (id, project_id, title, jsonl_path, created_at, updated_at, message_count, status)
           VALUES ('s2','p2','会话2','x',1,1,0,'active')`,
        `INSERT INTO sessions (id, project_id, title, jsonl_path, created_at, updated_at, message_count, status)
           VALUES ('s3','p3','会话3','y',1,1,0,'active')`,
      ],
      4,
    );

    const db = openDatabase(root);
    assert.equal(userVersion(db), LATEST);

    const projects = db.prepare("SELECT id, root_key FROM projects").all() as unknown as {
      id: string;
      root_key: string;
    }[];
    assert.equal(projects.length, 1, "三处写法应合并为一条项目");
    // 保留 last_opened_at 最新的 p2
    assert.equal(projects[0]?.id, "p2");
    assert.equal(projects[0]?.root_key, "e:/code/banyan");

    const sessions = db.prepare("SELECT project_id FROM sessions ORDER BY id").all() as unknown as {
      project_id: string;
    }[];
    assert.deepEqual(sessions.map((s) => s.project_id), ["p2", "p2"], "被合并项目的会话应改挂到保留项目");
  });
});
