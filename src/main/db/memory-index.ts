/**
 * 记忆检索索引：把记忆文件拆条入库，供 memory_search 跨会话检索（L3a）。
 *
 * 定位（docs/SECURITY.md「记忆系统」节）：记忆文件（项目级 `.colt/memory.md` 与
 * 用户级 `~/.colt/memory.md`）是记忆的**唯一真源**，本库只是可随时删除重建的
 * **派生索引**，两层语义：
 * - 热层（active）：当前文件里还存在的条目——每请求整份注入上下文，模型本就看得见；
 * - 冷层（archived）：从文件里被移除的条目——「从文件删掉」不等于「记忆消失」，
 *   模型仍可通过 memory_search 检索到原文；彻底清除靠删除本库文件。
 *
 * 库文件独立于 colt.db（`data/memory.db`），两个理由：
 * - 故障隔离：FTS5 缺失（node:sqlite 编译差异）时检索降级为子串匹配，绝不拖累核心库；
 * - 数据可弃：索引坏了删文件重建即可，不碰会话元数据。
 *
 * FTS5：node:sqlite 实测可用（Node 24 / SQLite 3.53，见 2026-09 探针记录）；
 * trigram 分词对中文有 **3 字符下限**——二字词（记忆/偏好）由 LIKE 子串兜底，
 * 故 FTS 路径只接 ≥3 字查询，<3 字恒走 LIKE，两条路都不依赖查询分词。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * 条目拆分规则：非空行即条目；标题行（# 开头）是结构不是记忆，跳过。
 * 刻意保留行首的 `-` 等 bullet 标记——拆条要无损，呈现（工具结果）时才考虑格式。
 */
export function parseMemoryEntries(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith("#");
    });
}

export interface MemorySnapshot {
  scope: "project" | "user";
  /** 规范化项目键（normalizeRootKey）；用户级条目跨项目共享，恒为 "" */
  projectKey: string;
  sourcePath: string;
  /** 文件当前内容；null = 文件不存在（该文件现行条目全部归档） */
  content: string | null;
  /** 快照来源的会话，仅作溯源记录 */
  sessionId: string;
}

export interface MemoryIndexResult {
  indexed: number;
  archived: number;
}

export interface MemoryHit {
  content: string;
  scope: "project" | "user";
  status: "active" | "archived";
  sourcePath: string;
  lastSeenAt: number;
}

export interface MemorySearchOptions {
  /** 发起检索的会话所属项目键；检索只返回该项目 + 用户级条目 */
  projectKey: string;
  query: string;
  limit?: number;
}

const SCHEMA_CORE = `
CREATE TABLE IF NOT EXISTS memory_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  project_key TEXT NOT NULL,
  content TEXT NOT NULL,
  source_path TEXT NOT NULL,
  source_session TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_identity ON memory_entries(scope, project_key, content);
CREATE INDEX IF NOT EXISTS idx_memory_browse ON memory_entries(scope, project_key, status, last_seen_at DESC);
`;

/**
 * FTS 侧车表（external content 模式：正文只存 memory_entries 一份，FTS 只存倒排）。
 * 同步交给触发器；FTS5 不可用时整段跳过，检索走 LIKE 兜底。
 */
const SCHEMA_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  content,
  content='memory_entries',
  content_rowid='id',
  tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS memory_fts_ai AFTER INSERT ON memory_entries BEGIN
  INSERT INTO memory_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS memory_fts_ad AFTER DELETE ON memory_entries BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS memory_fts_au AFTER UPDATE OF content ON memory_entries BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO memory_fts(rowid, content) VALUES (new.id, new.content);
END;
`;

let db: DatabaseSync | undefined;
let reopenUserDataPath: string | undefined;
let fts5Available = false;

/** FTS5 是否可用（开库时探测）；false = 检索恒走 LIKE 子串兜底 */
export function isFts5Available(): boolean {
  return fts5Available;
}

/** 打开（并按需建表）记忆索引库；与核心库分开的独立单例 */
export function openMemoryDatabase(userDataPath: string): DatabaseSync {
  if (db) return db;
  reopenUserDataPath = userDataPath;
  const dir = join(userDataPath, "data");
  mkdirSync(dir, { recursive: true });
  const instance = new DatabaseSync(join(dir, "memory.db"));
  instance.exec(SCHEMA_CORE);
  try {
    instance.exec(SCHEMA_FTS);
    fts5Available = true;
  } catch {
    // FTS5 缺失：留 fts5Available = false，检索降级，不拖累核心功能
    fts5Available = false;
  }
  db = instance;
  return instance;
}

/** 取当前连接，未开库时惰性重开（与核心库 getDatabase 同款自愈） */
function getMemoryDatabase(): DatabaseSync {
  if (db) return db;
  if (reopenUserDataPath) return openMemoryDatabase(reopenUserDataPath);
  throw new Error("记忆索引库尚未初始化，请先调用 openMemoryDatabase()");
}

/** 关闭连接（测试与「清空重来」用）；保留路径供下次惰性重开 */
export function closeMemoryDatabase(): void {
  db?.close();
  db = undefined;
}

/**
 * 一份文件快照入库：现行条目 upsert（含「曾归档又回来」的复活），
 * 该文件里没再出现的条目转入冷层。幂等——同一内容反复上报只刷新时间戳。
 */
export function indexMemorySnapshot(snapshot: MemorySnapshot): MemoryIndexResult {
  const instance = getMemoryDatabase();
  const now = Date.now();
  const lines = snapshot.content === null ? [] : parseMemoryEntries(snapshot.content);
  let archived = 0;

  instance.exec("BEGIN");
  try {
    const find = instance.prepare(
      "SELECT id, status FROM memory_entries WHERE scope = ? AND project_key = ? AND content = ?",
    );
    const activate = instance.prepare(
      "UPDATE memory_entries SET status = 'active', last_seen_at = ?, source_path = ?, source_session = ? WHERE id = ?",
    );
    const insert = instance.prepare(
      "INSERT INTO memory_entries (scope, project_key, content, source_path, source_session, status, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)",
    );
    const seen = new Set<string>();
    for (const content of lines) {
      seen.add(content);
      const row = find.get(snapshot.scope, snapshot.projectKey, content) as
        | { id: number; status: string }
        | undefined;
      if (row !== undefined) {
        activate.run(now, snapshot.sourcePath, snapshot.sessionId, row.id);
      } else {
        insert.run(snapshot.scope, snapshot.projectKey, content, snapshot.sourcePath, snapshot.sessionId, now, now);
      }
    }
    const stale = instance
      .prepare(
        "SELECT id, content FROM memory_entries WHERE scope = ? AND project_key = ? AND source_path = ? AND status = 'active'",
      )
      .all(snapshot.scope, snapshot.projectKey, snapshot.sourcePath) as unknown as {
      id: number;
      content: string;
    }[];
    const markArchived = instance.prepare("UPDATE memory_entries SET status = 'archived' WHERE id = ?");
    for (const row of stale) {
      if (seen.has(row.content)) continue;
      markArchived.run(row.id);
      archived++;
    }
    instance.exec("COMMIT");
  } catch (error) {
    instance.exec("ROLLBACK");
    throw error;
  }
  return { indexed: lines.length, archived };
}

/**
 * 检索：本项目 + 用户级条目（跨项目一律不可见），现行与冷层都参与。
 * ≥3 字查询走 FTS（bm25 相关度排序，失败回落 LIKE）；<3 字恒走 LIKE（trigram 下限）。
 */
export function searchMemory(options: MemorySearchOptions): MemoryHit[] {
  const instance = getMemoryDatabase();
  const query = options.query.trim();
  if (query.length === 0) return [];
  const limit = Math.min(Math.max(options.limit ?? 8, 1), 50);
  const scopeFilter = "(scope = 'user' OR project_key = ?)";

  if (fts5Available && query.length >= 3) {
    try {
      const rows = instance
        .prepare(
          `SELECT e.content AS content, e.scope AS scope, e.status AS status, e.source_path AS sourcePath, e.last_seen_at AS lastSeenAt, bm25(memory_fts) AS rank
           FROM memory_fts f JOIN memory_entries e ON e.id = f.rowid
           WHERE memory_fts MATCH ? AND ${scopeFilter}
           ORDER BY rank, e.last_seen_at DESC LIMIT ?`,
        )
        .all(query, options.projectKey, limit) as unknown as {
        content: string;
        scope: "project" | "user";
        status: "active" | "archived";
        sourcePath: string;
        lastSeenAt: number;
        rank: number;
      }[];
      return rows.map(({ rank: _rank, ...hit }) => hit);
    } catch {
      // MATCH 不认的查询表达式（引号/括号等）→ 落到 LIKE，功能不断
    }
  }

  const pattern = `%${query.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const rows = instance
    .prepare(
      `SELECT content, scope, status, source_path AS sourcePath, last_seen_at AS lastSeenAt
       FROM memory_entries
       WHERE content LIKE ? ESCAPE '\\' AND ${scopeFilter}
       ORDER BY last_seen_at DESC LIMIT ?`,
    )
    .all(pattern, options.projectKey, limit) as unknown as {
    content: string;
    scope: "project" | "user";
    status: "active" | "archived";
    sourcePath: string;
    lastSeenAt: number;
  }[];
  return rows;
}
