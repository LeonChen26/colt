/**
 * Banyan 自有 SQLite：工作台元数据（会话本体在 JSONL，不在此库）
 * 驱动：node:sqlite（Electron 44 / Node 24 内置，零原生编译）
 * 作者：陕耀云栈WorkMate
 */
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_opened_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  jsonl_path TEXT NOT NULL,
  kernel_session_id TEXT,
  preset_id TEXT,
  /** 会话选定模型，格式 "providerId/modelId"，未选时为 NULL */
  model_ref TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS usage_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  run_id TEXT,
  provider TEXT,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_records(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  run_id TEXT,
  tool_name TEXT NOT NULL,
  input_json TEXT,
  is_error INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS file_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  /** worker 侧生成的改动 UUID，投影时作为 ViewFileChange.id，保证进程重启后 ID 稳定 */
  client_change_id TEXT,
  tool_call_id TEXT,
  file_path TEXT NOT NULL,
  change_kind TEXT NOT NULL,
  diff_text TEXT,
  added_lines INTEGER NOT NULL DEFAULT 0,
  removed_lines INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_file_changes_session ON file_changes(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  base_url TEXT NOT NULL,
  models_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  system_prompt TEXT,
  enabled_tools_json TEXT,
  skills_json TEXT,
  model_ref TEXT,
  thinking_level TEXT,
  updated_at INTEGER NOT NULL
);
`;

let db: DatabaseSync | undefined;

/** 打开（并按需建表）工作台数据库 */
export function openDatabase(userDataPath: string): DatabaseSync {
  if (db) return db;
  const dir = join(userDataPath, "data");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "banyan.db");
  const instance = new DatabaseSync(file);
  instance.exec(SCHEMA);
  // 旧库补列（M1 新增）
  try {
    instance.exec("ALTER TABLE sessions ADD COLUMN kernel_session_id TEXT");
  } catch {
    // 列已存在
  }
  try {
    instance.exec("ALTER TABLE sessions ADD COLUMN model_ref TEXT");
  } catch {
    // 列已存在
  }
  try {
    instance.exec("ALTER TABLE file_changes ADD COLUMN client_change_id TEXT");
  } catch {
    // 列已存在
  }
  db = instance;
  return instance;
}

export function getDatabase(): DatabaseSync {
  if (!db) throw new Error("数据库尚未初始化，请先调用 openDatabase()");
  return db;
}

export function closeDatabase(): void {
  db?.close();
  db = undefined;
}
