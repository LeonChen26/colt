/**
 * Colt 自有 SQLite：工作台元数据（会话本体在 JSONL，不在此库）
 * 驱动：node:sqlite（Electron 44 / Node 24 内置，零原生编译）
 */
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";

/**
 * 计算项目的规范化去重键。
 * Windows 下盘符大小写不敏感、分隔符可混用，故统一为小写盘符 + 正斜杠；
 * 非 Windows 仅做绝对路径归一（消除 . .. 与多余分隔符）。
 * 与 repo.ts 中 upsertProject 的写入键保持一致。
 */
export function normalizeRootKey(rootPath: string): string {
  const abs = resolve(rootPath).replace(/\\/g, "/");
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  /** 原始显示路径（保留用户/系统提供的写法） */
  root_path TEXT NOT NULL,
  /** 规范化后的去重键：盘符小写 + 正斜杠，用于跨写法识别同一目录 */
  root_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_opened_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_root_key ON projects(root_key);

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
  /** 内核 usage 行 ID，作为幂等键防重放，可为 NULL（历史数据） */
  kernel_usage_id TEXT,
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_kernel_id ON usage_records(kernel_usage_id);
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

/** 通用键值设置：审批策略等运行期可配置项（值统一存 JSON 字符串） */
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * 迁移版本号，存储于 PRAGMA user_version。
 * 每次改 schema 递增，并在 MIGRATIONS 里补一条对应迁移。
 */
const SCHEMA_VERSION = 6;

/** 判断某表是否已含某列 */
function hasColumn(instance: DatabaseSync, table: string, column: string): boolean {
  const rows = instance.prepare(`PRAGMA table_info(${table})`).all() as unknown as {
    name: string;
  }[];
  return rows.some((row) => row.name === column);
}

/** 幂等加列：旧库可能已通过历史 try/catch 补过列，且 user_version 仍为 0 */
function addColumnIfMissing(
  instance: DatabaseSync,
  table: string,
  column: string,
  definition: string,
): void {
  if (hasColumn(instance, table, column)) return;
  instance.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/**
 * 有序迁移列表。只针对「已存在的旧库」补跑，
 * 每个条目负责把它之前的版本升到 version。
 * 迁移须幂等：旧库的 user_version 可能为 0 而列已补。
 */
const MIGRATIONS: { version: number; up: (db: DatabaseSync) => void }[] = [
  {
    version: 1,
    up: (instance) => addColumnIfMissing(instance, "sessions", "kernel_session_id", "TEXT"),
  },
  {
    version: 2,
    up: (instance) => addColumnIfMissing(instance, "sessions", "model_ref", "TEXT"),
  },
  {
    version: 3,
    up: (instance) =>
      addColumnIfMissing(instance, "file_changes", "client_change_id", "TEXT"),
  },
  {
    version: 4,
    up: (instance) =>
      addColumnIfMissing(instance, "usage_records", "kernel_usage_id", "TEXT"),
  },
  {
    version: 5,
    up: (instance) => migrateProjectsRootKey(instance),
  },
  {
    version: 6,
    up: (instance) =>
      instance.exec(
        "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      ),
  },
];

/**
 * v5：为 projects 引入 root_key（规范化去重键）。
 * 步骤：加列 → 回填 → 合并历史重复项目（会话迁移到保留记录）→ 建唯一索引。
 * 需幂等：旧库可能已有 root_key 列但无索引。
 */
function migrateProjectsRootKey(instance: DatabaseSync): void {
  // 旧库（如仅含 sessions/usage 的早期形态）可能还没 projects 表，
  // 此时交给后续 SCHEMA 建表（新表已含 root_key），跳过合并逻辑。
  const hasProjects = instance
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects'")
    .get();
  if (!hasProjects) return;

  addColumnIfMissing(instance, "projects", "root_key", "TEXT");

  const rows = instance
    .prepare("SELECT id, name, root_path, created_at, last_opened_at FROM projects")
    .all() as unknown as {
    id: string;
    name: string;
    root_path: string;
    created_at: number;
    last_opened_at: number;
  }[];

  // 按规范化键分组，每组保留 last_opened_at 最新的一条
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = normalizeRootKey(row.root_path);
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  for (const [key, list] of groups) {
    const keep = list.reduce((a, b) => (b.last_opened_at > a.last_opened_at ? b : a));
    const opened = list.reduce((max, row) => Math.max(max, row.last_opened_at), keep.last_opened_at);
    const created = list.reduce((min, row) => Math.min(min, row.created_at), keep.created_at);

    for (const row of list) {
      if (row.id === keep.id) continue;
      // 被合并项目的会话改挂到保留项目，避免 ON DELETE CASCADE 丢数据
      instance.prepare("UPDATE sessions SET project_id = ? WHERE project_id = ?").run(keep.id, row.id);
      instance.prepare("DELETE FROM projects WHERE id = ?").run(row.id);
    }

    instance
      .prepare("UPDATE projects SET root_key = ?, last_opened_at = ?, created_at = ? WHERE id = ?")
      .run(key, opened, created, keep.id);
  }

  // 兜底：任何仍为 NULL 的 root_key 补上（防御历史脏行）
  const pending = instance
    .prepare("SELECT id, root_path FROM projects WHERE root_key IS NULL")
    .all() as unknown as { id: string; root_path: string }[];
  for (const row of pending) {
    instance.prepare("UPDATE projects SET root_key = ? WHERE id = ?").run(normalizeRootKey(row.root_path), row.id);
  }

  instance.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_root_key ON projects(root_key)");
}

let db: DatabaseSync | undefined;

/** 判断工作台库是否已初始化（以 sessions 表是否存在为标志） */
function hasExistingSchema(instance: DatabaseSync): boolean {
  const row = instance
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'")
    .get();
  return row !== undefined;
}

function readUserVersion(instance: DatabaseSync): number {
  const row = instance.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return row?.user_version ?? 0;
}

/** 依次执行未应用的迁移，迁移过程整体包在事务里 */
function migrate(instance: DatabaseSync, from: number): void {
  const pending = MIGRATIONS.filter((item) => item.version > from).sort(
    (a, b) => a.version - b.version,
  );
  if (pending.length === 0) return;

  instance.exec("BEGIN");
  try {
    for (const item of pending) item.up(instance);
    instance.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    instance.exec("COMMIT");
  } catch (error) {
    instance.exec("ROLLBACK");
    throw error;
  }
}

/** 打开（并按需建表、迁移）工作台数据库 */
export function openDatabase(userDataPath: string): DatabaseSync {
  if (db) return db;
  const dir = join(userDataPath, "data");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "colt.db");
  const instance = new DatabaseSync(file);

  const existing = hasExistingSchema(instance);
  const currentVersion = readUserVersion(instance);

  // 迁移先行：先把旧库的列补齐，
  // 否则 SCHEMA 里的索引语句会依赖尚未存在的列而失败
  if (existing) {
    migrate(instance, currentVersion);
  }

  instance.exec(SCHEMA);

  // 新库由 SCHEMA 建到最新形态，直接置版本号
  if (!existing) {
    instance.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
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
