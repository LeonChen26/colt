/**
 * 项目与会话的数据访问
 * 作者：陕耀云栈WorkMate
 */
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { Project, ProjectFileChange, SessionInfo } from "@shared/protocol";
import type { ViewFileChange } from "@shared/worker-protocol";
import { getDatabase } from "./index";

interface ProjectRow {
  id: string;
  name: string;
  root_path: string;
  created_at: number;
  last_opened_at: number;
}

interface SessionRow {
  id: string;
  project_id: string;
  title: string;
  jsonl_path: string;
  kernel_session_id: string | null;
  preset_id: string | null;
  model_ref: string | null;
  created_at: number;
  updated_at: number;
  message_count: number;
  status: string;
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    createdAt: row.created_at,
    lastOpenedAt: row.last_opened_at,
  };
}

function toSession(row: SessionRow): SessionInfo {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    jsonlPath: row.jsonl_path,
    kernelSessionId: row.kernel_session_id,
    presetId: row.preset_id,
    modelRef: row.model_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: row.message_count,
    status: row.status === "archived" ? "archived" : "active",
  };
}

/** 按根路径登记项目；已存在则更新最近打开时间 */
export function upsertProject(rootPath: string): Project {
  const db = getDatabase();
  const now = Date.now();
  const existing = db.prepare("SELECT * FROM projects WHERE root_path = ?").get(rootPath) as
    | unknown as ProjectRow | undefined;

  if (existing) {
    db.prepare("UPDATE projects SET last_opened_at = ? WHERE id = ?").run(now, existing.id);
    return toProject({ ...existing, last_opened_at: now });
  }

  const row: ProjectRow = {
    id: randomUUID(),
    name: basename(rootPath) || rootPath,
    root_path: rootPath,
    created_at: now,
    last_opened_at: now,
  };
  db.prepare(
    "INSERT INTO projects (id, name, root_path, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?)",
  ).run(row.id, row.name, row.root_path, row.created_at, row.last_opened_at);
  return toProject(row);
}

export function listProjects(): Project[] {
  const db = getDatabase();
  const rows = db
    .prepare("SELECT * FROM projects ORDER BY last_opened_at DESC")
    .all() as unknown as ProjectRow[];
  return rows.map(toProject);
}

export function createSession(projectId: string, jsonlPath: string, presetId?: string): SessionInfo {
  const db = getDatabase();
  const now = Date.now();
  const row: SessionRow = {
    id: randomUUID(),
    project_id: projectId,
    title: "新会话",
    jsonl_path: jsonlPath,
    kernel_session_id: null,
    preset_id: presetId ?? null,
    model_ref: null,
    created_at: now,
    updated_at: now,
    message_count: 0,
    status: "active",
  };
  db.prepare(
    `INSERT INTO sessions (id, project_id, title, jsonl_path, preset_id, created_at, updated_at, message_count, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.project_id,
    row.title,
    row.jsonl_path,
    row.preset_id,
    row.created_at,
    row.updated_at,
    row.message_count,
    row.status,
  );
  return toSession(row);
}

/** 记录内核会话 ID，下次打开时续接历史 */
export function setKernelSessionId(sessionId: string, kernelSessionId: string): void {
  getDatabase()
    .prepare("UPDATE sessions SET kernel_session_id = ?, updated_at = ? WHERE id = ?")
    .run(kernelSessionId, Date.now(), sessionId);
}

/** 记录会话当前选定的模型（"providerId/modelId"），下次打开时恢复 */
export function setSessionModel(sessionId: string, modelRef: string): void {
  getDatabase()
    .prepare("UPDATE sessions SET model_ref = ?, updated_at = ? WHERE id = ?")
    .run(modelRef, Date.now(), sessionId);
}

/** 记录一次文件改动 */
export function recordFileChange(
  sessionId: string,
  change: {
    id: string;
    path: string;
    kind: string;
    patch: string | null;
    addedLines: number;
    removedLines: number;
    timestamp: number;
  },
): void {
  getDatabase()
    .prepare(
      `INSERT INTO file_changes (session_id, client_change_id, file_path, change_kind, diff_text, added_lines, removed_lines, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sessionId,
      change.id,
      change.path,
      change.kind,
      change.patch,
      change.addedLines,
      change.removedLines,
      change.timestamp,
    );
}

/**
 * 会话级改动列表，按时间升序，供 ConversationView 投影。
 * 改动的真源是数据库而非 worker 内存，这样 worker 被回收后重启仍能完整重建。
 */
export function listSessionFileChanges(sessionId: string): ViewFileChange[] {
  const rows = getDatabase()
    .prepare(
      `SELECT client_change_id, file_path, change_kind, diff_text, added_lines, removed_lines, created_at
       FROM file_changes
       WHERE session_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(sessionId) as unknown as {
    client_change_id: string | null;
    file_path: string;
    change_kind: string;
    diff_text: string | null;
    added_lines: number;
    removed_lines: number;
    created_at: number;
  }[];

  return rows.map((row, index) => ({
    // 旧数据可能没有 client_change_id，回退为基于数据库自增行的稳定占位
    id: row.client_change_id ?? `db-${row.created_at}-${index}`,
    path: row.file_path,
    kind: row.change_kind === "edit" ? "edit" : "write",
    patch: row.diff_text,
    addedLines: row.added_lines,
    removedLines: row.removed_lines,
    timestamp: row.created_at,
  }));
}

/** 项目级改动汇总：跨会话，按时间倒序 */
export function listProjectChanges(projectId: string): ProjectFileChange[] {
  const rows = getDatabase()
    .prepare(
      `SELECT c.id, c.session_id, s.title, c.file_path, c.change_kind,
              c.diff_text, c.added_lines, c.removed_lines, c.created_at
       FROM file_changes c
       JOIN sessions s ON s.id = c.session_id
       WHERE s.project_id = ?
       ORDER BY c.created_at DESC`,
    )
    .all(projectId) as unknown as {
    id: number;
    session_id: string;
    title: string;
    file_path: string;
    change_kind: string;
    diff_text: string | null;
    added_lines: number;
    removed_lines: number;
    created_at: number;
  }[];

  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    sessionTitle: row.title,
    path: row.file_path,
    kind: row.change_kind,
    patch: row.diff_text,
    addedLines: row.added_lines,
    removedLines: row.removed_lines,
    createdAt: row.created_at,
  }));
}

/** 读取单个会话 */
export function getSession(sessionId: string): SessionInfo | undefined {
  const row = getDatabase()
    .prepare("SELECT * FROM sessions WHERE id = ?")
    .get(sessionId) as unknown as SessionRow | undefined;
  return row ? toSession(row) : undefined;
}

/** 更新会话标题与消息数 */
export function touchSession(sessionId: string, messageCount: number, title?: string): void {
  const db = getDatabase();
  if (title) {
    db.prepare("UPDATE sessions SET updated_at = ?, message_count = ?, title = ? WHERE id = ?").run(
      Date.now(),
      messageCount,
      title,
      sessionId,
    );
  } else {
    db.prepare("UPDATE sessions SET updated_at = ?, message_count = ? WHERE id = ?").run(
      Date.now(),
      messageCount,
      sessionId,
    );
  }
}

export function listSessions(projectId?: string): SessionInfo[] {
  const db = getDatabase();
  const rows = (
    projectId
      ? db
          .prepare("SELECT * FROM sessions WHERE project_id = ? ORDER BY updated_at DESC")
          .all(projectId)
      : db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC").all()
  ) as unknown as SessionRow[];
  return rows.map(toSession);
}
