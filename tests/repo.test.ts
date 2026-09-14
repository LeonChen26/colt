/**
 * 数据访问层测试：项目/会话的增删查改，以及用量、工具调用、文件改动的写入语义。
 * 每个用例用独立的临时库；repo 依赖 openDatabase 的单例，故用例前重置。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, closeDatabase } from "../src/main/db/index.ts";
import {
  createSession,
  deleteSession,
  getSession,
  getSetting,
  listProjectChanges,
  listProjects,
  listSessionFileChanges,
  listSessionToolCalls,
  listSessionUsage,
  listSessions,
  recordFileChange,
  recordToolCall,
  recordUsage,
  setKernelSessionId,
  setSessionModel,
  setSetting,
  touchSession,
  upsertProject,
} from "../src/main/db/repo.ts";

let root: string;

beforeEach(() => {
  closeDatabase();
  root = mkdtempSync(join(tmpdir(), "colt-repo-"));
  openDatabase(root);
});

afterEach(() => {
  closeDatabase();
  rmSync(root, { recursive: true, force: true });
});

describe("projects", () => {
  test("登记新项目并列出", () => {
    const project = upsertProject("E:/demo");
    assert.equal(project.name, "demo");
    assert.equal(project.rootPath, "E:/demo");
    assert.equal(listProjects().length, 1);
  });

  test("同一路径重复登记不新增，只刷新打开时间", () => {
    const first = upsertProject("E:/demo");
    const second = upsertProject("E:/demo");
    assert.equal(first.id, second.id);
    assert.equal(listProjects().length, 1);
  });

  test("同一目录的不同路径写法视为同一项目", () => {
    const first = upsertProject("E:/code/demo");
    // 盘符大小写、分隔符差异都应命中同一条
    const second = upsertProject("e:\\code\\demo");
    const third = upsertProject("E:\\code\\demo\\");
    assert.equal(first.id, second.id);
    assert.equal(first.id, third.id);
    assert.equal(listProjects().length, 1);
  });
});

describe("sessions", () => {
  test("创建会话，初始字段符合预期", () => {
    const project = upsertProject("E:/demo");
    const session = createSession(project.id, "E:/demo/jsonl");
    assert.equal(session.title, "新会话");
    assert.equal(session.messageCount, 0);
    assert.equal(session.kernelSessionId, null);
    assert.equal(session.modelRef, null);
    assert.equal(session.status, "active");
  });

  test("按项目过滤会话", () => {
    const a = upsertProject("E:/a");
    const b = upsertProject("E:/b");
    createSession(a.id, "E:/a/jsonl");
    createSession(b.id, "E:/b/jsonl");
    assert.equal(listSessions(a.id).length, 1);
    assert.equal(listSessions().length, 2);
  });

  /**
   * 草稿会话落库时必须**沿用**调用方已分配的 id：id 在 session.create 时就交给了界面，
   * 若落库时另生成一个，界面手里那个 id 指向的就是一条不存在的会话。
   */
  test("可复用调用方给定的会话 id（草稿落库）", () => {
    const project = upsertProject("E:/demo");
    const draftId = "draft-1";
    const session = createSession(project.id, "E:/demo/jsonl", undefined, draftId);
    assert.equal(session.id, draftId);
    assert.equal(getSession(draftId)?.id, draftId);
    assert.equal(listSessions(project.id).length, 1);
  });

  test("持久化内核会话 ID 与选定模型", () => {
    const project = upsertProject("E:/demo");
    const session = createSession(project.id, "E:/demo/jsonl");
    setKernelSessionId(session.id, "kernel-1");
    setSessionModel(session.id, "deepseek/deepseek-v4-pro");
    const reloaded = getSession(session.id);
    assert.equal(reloaded?.kernelSessionId, "kernel-1");
    assert.equal(reloaded?.modelRef, "deepseek/deepseek-v4-pro");
  });

  test("touchSession 更新标题与消息数", () => {
    const project = upsertProject("E:/demo");
    const session = createSession(project.id, "E:/demo/jsonl");
    touchSession(session.id, 7, "新标题");
    const reloaded = getSession(session.id);
    assert.equal(reloaded?.messageCount, 7);
    assert.equal(reloaded?.title, "新标题");
  });

  test("touchSession 省略标题时不覆盖原标题", () => {
    const project = upsertProject("E:/demo");
    const session = createSession(project.id, "E:/demo/jsonl");
    touchSession(session.id, 3, "命名");
    touchSession(session.id, 5);
    const reloaded = getSession(session.id);
    assert.equal(reloaded?.title, "命名");
    assert.equal(reloaded?.messageCount, 5);
  });
});

describe("deleteSession", () => {
  test("删除会话及其派生数据（用量/工具/改动）", () => {
    const project = upsertProject("E:/demo");
    const session = createSession(project.id, "E:/demo/jsonl");
    recordUsage({ sessionId: session.id, kernelUsageId: "u1", provider: "p", model: "m", input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0, timestamp: 1 });
    recordToolCall({ toolCallId: "c1", sessionId: session.id, toolName: "bash", inputJson: null, isError: false, durationMs: 1, timestamp: 1 });
    recordFileChange(session.id, { id: "ch1", path: "a.ts", kind: "edit", patch: null, addedLines: 1, removedLines: 0, timestamp: 1 });

    const removed = deleteSession(session.id);
    assert.equal(removed?.id, session.id, "应返回被删会话快照");
    assert.equal(removed?.kernelSessionId, null);
    assert.equal(getSession(session.id), undefined);
    assert.equal(listSessionUsage(session.id).records.length, 0);
    assert.equal(listSessionToolCalls(session.id).length, 0);
    assert.equal(listSessionFileChanges(session.id).length, 0);
    // 项目与其他会话不受影响
    assert.equal(listSessions(project.id).length, 0);
    assert.equal(listProjects().length, 1);
  });

  test("删除不存在的会话返回 undefined", () => {
    assert.equal(deleteSession("nope"), undefined);
  });
});

describe("recordUsage", () => {
  test("写入并汇总", () => {
    const project = upsertProject("E:/demo");
    const session = createSession(project.id, "E:/demo/jsonl");
    recordUsage({ sessionId: session.id, kernelUsageId: "u1", provider: "deepseek", model: "m", input: 10, output: 5, cacheRead: 2, cacheWrite: 1, costUsd: 0.001, timestamp: 1 });
    recordUsage({ sessionId: session.id, kernelUsageId: "u2", provider: "deepseek", model: "m", input: 20, output: 8, cacheRead: 0, cacheWrite: 0, costUsd: 0.002, timestamp: 2 });
    const usage = listSessionUsage(session.id);
    assert.equal(usage.records.length, 2);
    assert.equal(usage.totals.calls, 2);
    assert.equal(usage.totals.inputTokens, 30);
    assert.equal(usage.totals.outputTokens, 13);
    assert.equal(usage.totals.cacheReadTokens, 2);
  });

  test("同一 kernelUsageId 重复写入被忽略（幂等）", () => {
    const project = upsertProject("E:/demo");
    const session = createSession(project.id, "E:/demo/jsonl");
    const base = { sessionId: session.id, kernelUsageId: "dup", provider: "p", model: "m", input: 10, output: 5, cacheRead: 0, cacheWrite: 0, costUsd: 0.001, timestamp: 1 };
    recordUsage(base);
    recordUsage({ ...base, input: 999 });
    const usage = listSessionUsage(session.id);
    assert.equal(usage.records.length, 1);
    assert.equal(usage.totals.inputTokens, 10);
  });

  test("记录按时间倒序", () => {
    const project = upsertProject("E:/demo");
    const session = createSession(project.id, "E:/demo/jsonl");
    recordUsage({ sessionId: session.id, kernelUsageId: "old", provider: "p", model: "first", input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0, timestamp: 1000 });
    recordUsage({ sessionId: session.id, kernelUsageId: "new", provider: "p", model: "second", input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0, timestamp: 2000 });
    assert.equal(listSessionUsage(session.id).records[0]?.model, "second");
  });
});

describe("recordToolCall", () => {
  test("写入并读取", () => {
    const project = upsertProject("E:/demo");
    const session = createSession(project.id, "E:/demo/jsonl");
    recordToolCall({ toolCallId: "c1", sessionId: session.id, runId: "r1", toolName: "bash", inputJson: '{"command":"ls"}', isError: false, durationMs: 42, timestamp: 1 });
    const calls = listSessionToolCalls(session.id);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.toolName, "bash");
    assert.equal(calls[0]?.runId, "r1");
    assert.equal(calls[0]?.inputJson, '{"command":"ls"}');
    assert.equal(calls[0]?.durationMs, 42);
    assert.equal(calls[0]?.isError, false);
    assert.equal(calls[0]?.createdAt, 1);
  });

  test("未传 runId 时落库为 null", () => {
    const project = upsertProject("E:/demo");
    const session = createSession(project.id, "E:/demo/jsonl");
    recordToolCall({ toolCallId: "c1", sessionId: session.id, toolName: "read", inputJson: null, isError: false, durationMs: 1, timestamp: 1 });
    assert.equal(listSessionToolCalls(session.id)[0]?.runId, null);
  });

  test("覆盖重放时保留原 runId", () => {
    const project = upsertProject("E:/demo");
    const session = createSession(project.id, "E:/demo/jsonl");
    recordToolCall({ toolCallId: "c1", sessionId: session.id, runId: "r1", toolName: "bash", inputJson: null, isError: true, durationMs: 10, timestamp: 1 });
    recordToolCall({ toolCallId: "c1", sessionId: session.id, runId: "r1", toolName: "bash", inputJson: null, isError: false, durationMs: 20, timestamp: 1 });
    const calls = listSessionToolCalls(session.id);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.runId, "r1");
  });

  test("同一 toolCallId 覆盖而非重复（恢复重放场景）", () => {
    const project = upsertProject("E:/demo");
    const session = createSession(project.id, "E:/demo/jsonl");
    recordToolCall({ toolCallId: "c1", sessionId: session.id, toolName: "edit", inputJson: null, isError: true, durationMs: 30, timestamp: 1 });
    recordToolCall({ toolCallId: "c1", sessionId: session.id, toolName: "edit", inputJson: null, isError: false, durationMs: 45, timestamp: 1 });
    const calls = listSessionToolCalls(session.id);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.isError, false);
    assert.equal(calls[0]?.durationMs, 45);
  });
});

describe("file changes", () => {
  test("会话级改动按时间升序，ID 用 clientChangeId 保持稳定", () => {
    const project = upsertProject("E:/demo");
    const session = createSession(project.id, "E:/demo/jsonl");
    recordFileChange(session.id, { id: "change-a", path: "src/a.ts", kind: "edit", patch: "@@", addedLines: 1, removedLines: 1, timestamp: 100 });
    recordFileChange(session.id, { id: "change-b", path: "src/b.ts", kind: "write", patch: null, addedLines: 5, removedLines: 0, timestamp: 200 });
    const changes = listSessionFileChanges(session.id);
    assert.deepEqual(changes.map((c) => c.id), ["change-a", "change-b"]);
    assert.equal(changes[0]?.path, "src/a.ts");
  });

  test("项目级改动汇总带会话标题", () => {
    const project = upsertProject("E:/demo");
    const session = createSession(project.id, "E:/demo/jsonl");
    touchSession(session.id, 1, "我的会话");
    recordFileChange(session.id, { id: "x", path: "f.ts", kind: "edit", patch: null, addedLines: 1, removedLines: 0, timestamp: 1 });
    const list = listProjectChanges(project.id);
    assert.equal(list.length, 1);
    assert.equal(list[0]?.sessionTitle, "我的会话");
  });
});

describe("settings", () => {
  test("未设置时返回 undefined", () => {
    assert.equal(getSetting("approval.analyzeCommandAllowlist"), undefined);
  });

  test("写入后可读回，且可覆盖", () => {
    setSetting("approval.analyzeCommandAllowlist", JSON.stringify(["npm"]));
    assert.equal(getSetting("approval.analyzeCommandAllowlist"), JSON.stringify(["npm"]));

    setSetting("approval.analyzeCommandAllowlist", JSON.stringify([]));
    assert.equal(getSetting("approval.analyzeCommandAllowlist"), JSON.stringify([]));
  });
});
