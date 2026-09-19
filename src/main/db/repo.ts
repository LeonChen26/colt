// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 项目与会话的数据访问
 */
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { Project, ProjectFileChange, SessionEvent, SessionInfo, SessionUsage, ToolCallRecord, UsageRecord } from "@shared/protocol";
import type { ViewFileChange } from "@shared/worker-protocol";
import type { ViewTodo } from "@shared/todo";
import { toStoredThinkingLevel } from "@shared/thinking-level";
import { getDatabase, normalizeRootKey } from "./index";

interface ProjectRow {
  id: string;
  name: string;
  root_path: string;
  root_key: string;
  created_at: number;
  last_opened_at: number;
}

interface SessionRow {
  id: string;
  project_id: string;
  title: string;
  jsonl_path: string;
  kernel_session_id: string | null;
  model_ref: string | null;
  thinking_level: string | null;
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
    modelRef: row.model_ref,
    thinkingLevel: toStoredThinkingLevel(row.thinking_level),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: row.message_count,
    status: row.status === "archived" ? "archived" : "active",
  };
}

/** 按根路径登记项目；已存在（规范化后同一目录）则更新最近打开时间 */
export function upsertProject(rootPath: string): Project {
  const db = getDatabase();
  const now = Date.now();
  const rootKey = normalizeRootKey(rootPath);
  const existing = db.prepare("SELECT * FROM projects WHERE root_key = ?").get(rootKey) as
    | unknown as ProjectRow | undefined;

  if (existing) {
    db.prepare("UPDATE projects SET last_opened_at = ? WHERE id = ?").run(now, existing.id);
    return toProject({ ...existing, last_opened_at: now });
  }

  const row: ProjectRow = {
    id: randomUUID(),
    name: basename(rootPath) || rootPath,
    root_path: rootPath,
    root_key: rootKey,
    created_at: now,
    last_opened_at: now,
  };
  db.prepare(
    "INSERT INTO projects (id, name, root_path, root_key, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(row.id, row.name, row.root_path, row.root_key, row.created_at, row.last_opened_at);
  return toProject(row);
}

export function listProjects(): Project[] {
  const db = getDatabase();
  const rows = db
    .prepare("SELECT * FROM projects ORDER BY last_opened_at DESC")
    .all() as unknown as ProjectRow[];
  return rows.map(toProject);
}

/**
 * 读取单个项目。
 * 用途：把会话解析到它的工作目录——`sessions` 表故意不存 cwd，根只在项目上，
 * 于是「读项目内文件」的根只能由主进程经 `sessionId → project_id → root_path` 推出。
 */
export function getProject(projectId: string): Project | undefined {
  const row = getDatabase()
    .prepare("SELECT * FROM projects WHERE id = ?")
    .get(projectId) as unknown as ProjectRow | undefined;
  return row ? toProject(row) : undefined;
}

/**
 * 新建会话行。
 *
 * `id` 用于**草稿会话落库**：id 在 `session.create` 时就交给了渲染层，
 * 首次发消息时落库必须沿用同一个，否则界面持有的 id 指向的是一条不存在的会话。
 */
export function createSession(
  projectId: string,
  jsonlPath: string,
  id?: string,
): SessionInfo {
  const db = getDatabase();
  const now = Date.now();
  const row: SessionRow = {
    id: id ?? randomUUID(),
    project_id: projectId,
    title: "新会话",
    jsonl_path: jsonlPath,
    kernel_session_id: null,
    model_ref: null,
    thinking_level: null,
    created_at: now,
    updated_at: now,
    message_count: 0,
    status: "active",
  };
  db.prepare(
    `INSERT INTO sessions (id, project_id, title, jsonl_path, created_at, updated_at, message_count, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.project_id,
    row.title,
    row.jsonl_path,
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

/** 记录会话思考等级，下次打开时恢复 */
export function setSessionThinkingLevel(sessionId: string, level: string): void {
  getDatabase()
    .prepare("UPDATE sessions SET thinking_level = ?, updated_at = ? WHERE id = ?")
    .run(level, Date.now(), sessionId);
}

/**
 * 记录一次文件改动，返回新行的自增 id。
 *
 * 返回 id 是为了让调用方**紧接着**把这条改动的净值写回去（`setChangeNet`）——
 * 净值要读盘算，算完才知道，所以只能分两步：先落改动，再补净值。
 */
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
): number {
  const result = getDatabase()
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
  return Number(result.lastInsertRowid);
}

/**
 * 把某条改动的**净变化**写回去（基线 → 当前）。
 * 传 null 表示算不出（没有基线 / 文件读不到）——写 NULL 而不是 0，界面才能区分
 * 「没改」与「不知道」，这也正是净变化这件事最容易撒谎的地方。
 */
export function setChangeNet(changeId: number, net: { added: number; removed: number } | null): void {
  getDatabase()
    .prepare("UPDATE file_changes SET net_added_lines = ?, net_removed_lines = ? WHERE id = ?")
    .run(net === null ? null : net.added, net === null ? null : net.removed, changeId);
}

/**
 * 记录一个文件的基线（本次会话首次改动它之前的内容）。
 *
 * **只认最早的一份**：worker 被回收重启后不记得发过基线，会把「当时已经改过」的内容
 * 再报一次——若允许覆盖，净值就会从那一刻重新起算，把会话前段的变化吃掉。
 */
export function recordFileBaseline(
  sessionId: string,
  path: string,
  baseline: { existed: boolean; text: string | null },
): void {
  getDatabase()
    .prepare(
      `INSERT INTO file_baselines (session_id, file_path, existed, content, captured_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id, file_path) DO NOTHING`,
    )
    .run(sessionId, path, baseline.existed ? 1 : 0, baseline.text, Date.now());
}

/** 取某文件的基线；undefined = 本次会话还没抓过（净值算不出） */
export function getFileBaseline(
  sessionId: string,
  path: string,
): { existed: boolean; text: string | null } | undefined {
  const row = getDatabase()
    .prepare("SELECT existed, content FROM file_baselines WHERE session_id = ? AND file_path = ?")
    .get(sessionId, path) as unknown as { existed: number; content: string | null } | undefined;
  if (row === undefined) return undefined;
  return { existed: row.existed === 1, text: row.content };
}

/**
 * 记录一次工具调用。以内核 toolCallId 为主键，
 * 重复上报（如重试）用 UPSERT 覆盖而非报错。
 */
export function recordToolCall(input: {
  toolCallId: string;
  sessionId: string;
  runId?: string | null;
  toolName: string;
  inputJson: string | null;
  isError: boolean;
  durationMs: number | null;
  timestamp: number;
}): void {
  getDatabase()
    .prepare(
      `INSERT INTO tool_calls
         (id, session_id, run_id, tool_name, input_json, is_error, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         is_error = excluded.is_error,
         duration_ms = excluded.duration_ms`,
    )
    .run(
      input.toolCallId,
      input.sessionId,
      input.runId ?? null,
      input.toolName,
      input.inputJson,
      input.isError ? 1 : 0,
      input.durationMs,
      input.timestamp,
    );
}

/** 会话工具调用历史，按时间倒序 */
export function listSessionToolCalls(sessionId: string): ToolCallRecord[] {
  const rows = getDatabase()
    .prepare(
      `SELECT id, run_id, tool_name, input_json, is_error, duration_ms, created_at
       FROM tool_calls
       WHERE session_id = ?
       ORDER BY created_at DESC, id DESC`,
    )
    .all(sessionId) as unknown as {
    id: string;
    run_id: string | null;
    tool_name: string;
    input_json: string | null;
    is_error: number;
    duration_ms: number | null;
    created_at: number;
  }[];

  return rows.map((row) => ({
    id: row.id,
    runId: row.run_id,
    toolName: row.tool_name,
    inputJson: row.input_json,
    isError: row.is_error === 1,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
  }));
}

/**
 * 会话级改动列表，按时间升序，供 ConversationView 投影。
 * 改动的真源是数据库而非 worker 内存，这样 worker 被回收后重启仍能完整重建。
 */
export function listSessionFileChanges(sessionId: string): ViewFileChange[] {
  const rows = getDatabase()
    .prepare(
      `SELECT client_change_id, file_path, change_kind, diff_text, added_lines, removed_lines,
              net_added_lines, net_removed_lines, created_at
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
    net_added_lines: number | null;
    net_removed_lines: number | null;
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
    // NULL 原样带出（= 算不出）。**不要**在这里折成 0：那会把「不知道」说成「没改」。
    netAddedLines: row.net_added_lines,
    netRemovedLines: row.net_removed_lines,
  }));
}

/**
 * 会话级待办清单，按 `ord` 升序（= 模型自己排的顺序）。
 *
 * 与 `file_changes` 同一条路：**真源是库**，worker 被回收重启后仍能完整重建。
 * `blocked_by_json` 解析失败当作空依赖——脏数据不该让整份清单读不出来
 * （它只是约束信息，缺了最坏是少一次校验，而不是界面空白）。
 */
export function listSessionTodos(sessionId: string): ViewTodo[] {
  const rows = getDatabase()
    .prepare(
      `SELECT id, subject, active_form, status, blocked_by_json, updated_at
       FROM todos WHERE session_id = ? ORDER BY ord ASC, id ASC`,
    )
    .all(sessionId) as unknown as {
    id: string;
    subject: string;
    active_form: string;
    status: string;
    blocked_by_json: string;
    updated_at: number;
  }[];

  return rows.map((row) => ({
    id: row.id,
    subject: row.subject,
    activeForm: row.active_form,
    status: row.status === "in_progress" || row.status === "completed" ? row.status : "pending",
    blockedBy: parseBlockedBy(row.blocked_by_json),
    updatedAt: row.updated_at,
  }));
}

function parseBlockedBy(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

/**
 * 整份覆盖某会话的清单（删光再按序写入，**一个事务**）。
 *
 * 为什么是「整份覆盖」而不是逐条 upsert/delete：写入方是 `TodoStore` 的同步状态机，
 * 它的每个动作**都**产出完整快照（见 `DESIGN-todo.md` §5）。整份覆盖把「要么全成、
 * 要么全不动」从句内约定升级成**库层保证**——依赖校验失败时我们一行都还没写，
 * 而写入过程若崩在中途，事务保证不会留下写了一半的清单（那会让之后的校验莫名失败）。
 * 顺序由 `ord` 承担，读回来即模型看到的顺序。
 */
export function replaceSessionTodos(sessionId: string, todos: readonly ViewTodo[]): void {
  const db = getDatabase();
  const remove = db.prepare("DELETE FROM todos WHERE session_id = ?");
  const insert = db.prepare(
    `INSERT INTO todos (session_id, id, ord, subject, active_form, status, blocked_by_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.exec("BEGIN");
  try {
    remove.run(sessionId);
    todos.forEach((todo, index) => {
      insert.run(
        sessionId,
        todo.id,
        index,
        todo.subject,
        todo.activeForm,
        todo.status,
        JSON.stringify(todo.blockedBy),
        todo.updatedAt,
      );
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * 记录一条模型用量（每次内核上报的 usage 行对应一条）。
 * 用量历史只增不改，供审计与统计使用。
 * 以内核的 kernelUsageId 作为幂等键：重放同一行不会重复计数。
 * 注：内核的 usage 事件不携带 runId（仅 lane/row/totals），故该列暂为 NULL。
 */
export function recordUsage(input: {
  sessionId: string;
  kernelUsageId: string;
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  timestamp: number;
}): void {
  getDatabase()
    .prepare(
      `INSERT INTO usage_records
         (session_id, kernel_usage_id, provider, model, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, cost_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(kernel_usage_id) DO NOTHING`,
    )
    .run(
      input.sessionId,
      input.kernelUsageId,
      input.provider,
      input.model,
      input.input,
      input.output,
      input.cacheRead,
      input.cacheWrite,
      input.costUsd,
      input.timestamp,
    );
}

/** 会话用量历史（按时间倒序）与累计汇总 */
export function listSessionUsage(sessionId: string): SessionUsage {
  const rows = getDatabase()
    .prepare(
      `SELECT id, provider, model, input_tokens, output_tokens,
              cache_read_tokens, cache_write_tokens, cost_usd, created_at
       FROM usage_records
       WHERE session_id = ?
       ORDER BY created_at DESC, id DESC`,
    )
    .all(sessionId) as unknown as {
    id: number;
    provider: string | null;
    model: string | null;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    cost_usd: number;
    created_at: number;
  }[];

  const records: UsageRecord[] = rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    costUsd: row.cost_usd,
    createdAt: row.created_at,
  }));

  const totals = records.reduce(
    (acc, item) => ({
      inputTokens: acc.inputTokens + item.inputTokens,
      outputTokens: acc.outputTokens + item.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + item.cacheReadTokens,
      cacheWriteTokens: acc.cacheWriteTokens + item.cacheWriteTokens,
      costUsd: acc.costUsd + item.costUsd,
      calls: acc.calls + 1,
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, calls: 0 },
  );

  return { records, totals };
}

/**
 * 最近一轮主 lane 调用的上下文占用（prompt tokens = input + cacheRead + cacheWrite）。
 * 用于 worker 重启后重建进度条：进度条的分子必须取「最近一轮」而非累计，
 * 累计值随轮次二次增长，不能反映当前对话在窗口里占了多少。
 * 无记录时返回 0。
 */
export function latestContextUsed(sessionId: string): number {
  const row = getDatabase()
    .prepare(
      `SELECT input_tokens, cache_read_tokens, cache_write_tokens
       FROM usage_records
       WHERE session_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    )
    .get(sessionId) as unknown as {
    input_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
  } | undefined;
  if (!row) return 0;
  return row.input_tokens + row.cache_read_tokens + row.cache_write_tokens;
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

/**
 * 永久删除会话及其派生数据。
 * 子表（usage/tool_calls/file_changes）无 FK CASCADE，须与之同事务手动删除；
 * 返回被删会话的快照（含 jsonlPath / kernelSessionId），供调用方清理历史文件。
 */
export function deleteSession(sessionId: string): SessionInfo | undefined {
  const db = getDatabase();
  const existing = getSession(sessionId);
  if (!existing) return undefined;

  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM file_changes WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM file_baselines WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM tool_calls WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM usage_records WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM session_events WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM approval_audit WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return existing;
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

/** 读取通用设置项；不存在时返回 undefined（由调用方决定默认值） */
export function getSetting(key: string): string | undefined {
  const row = getDatabase()
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as unknown as { value: string } | undefined;
  return row?.value;
}

/** 写入通用设置项（存在即覆盖） */
export function setSetting(key: string, value: string): void {
  getDatabase()
    .prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(key, value);
}

/**
 * 记一条安全事件。worker 每次启动都会重报技能装载状态（消息内容相同），
 * 故按「同会话 + 同内容 + 5 分钟内」去重——重启风暴不会堆积重复行，
 * 真在复发的错误（间隔超过窗口）仍逐条留痕。
 */
export function recordSessionEvent(sessionId: string, message: string): void {
  const db = getDatabase();
  const now = Date.now();
  const latest = db
    .prepare(
      "SELECT message, created_at FROM session_events WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
    )
    .get(sessionId) as unknown as { message: string; created_at: number } | undefined;
  if (latest && latest.message === message && now - latest.created_at < 5 * 60 * 1000) return;
  db.prepare("INSERT INTO session_events (session_id, message, created_at) VALUES (?, ?, ?)").run(
    sessionId,
    message,
    now,
  );
}

/** 会话的安全事件流（新的在前），供「事件」页签回查 */
export function listSessionEvents(sessionId: string): SessionEvent[] {
  const rows = getDatabase()
    .prepare(
      "SELECT id, message, created_at FROM session_events WHERE session_id = ? ORDER BY created_at DESC, id DESC",
    )
    .all(sessionId) as unknown as { id: number; message: string; created_at: number }[];
  return rows.map((row) => ({ id: row.id, message: row.message, createdAt: row.created_at }));
}

/**
 * 审批分析审计落盘（F9）：分析器每次结论一条（含被中断/模式变更丢弃的）。
 * 写多读少——事后排查「本不该放行却被放行」才查，故不加查询函数。
 */
export function recordApprovalAudit(input: {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  allow: boolean;
  analyzed: boolean;
  reason: string;
}): void {
  getDatabase()
    .prepare(
      "INSERT INTO approval_audit (session_id, tool_call_id, tool_name, allow, analyzed, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      input.sessionId,
      input.toolCallId,
      input.toolName,
      input.allow ? 1 : 0,
      input.analyzed ? 1 : 0,
      input.reason,
      Date.now(),
    );
}
