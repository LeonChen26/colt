// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * durable 崩溃恢复的**进程级**用例（免模型、不出网、不计费）。
 *
 * 与 `durable-harness.test.ts` 的区别：这里不是「同进程重开」，而是真的 `spawn` 一个子进程，
 * 在工具 `execute()` 已开始（intent 已提交）后 `process.exit(17)`，再由父进程打开同一个
 * SQLite 库验证恢复行为。它钉住三件事：
 *
 *  1. 崩溃后重新 `Harness.open` + `resume()` 能接着跑未完成的 submission；
 *  2. `replay: "safe"` 的只读工具会**重跑**，结果回到模型；
 *  3. 非 replay-safe 的工具**不会**重跑，模型收到 `interrupted` 错误结果
 *     （「可能已部分执行」），而不是假装成功或静默丢失。
 *
 * 这正是产品里 `bash` / `write` 与 `read` / `grep` 必须区分开的语义。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import {
  Harness,
  createRegistry,
  defineExtension,
  defineTool,
  type ConversationView,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "durable-crash-child.mjs");

function textOf(message: { content?: unknown } | undefined): string {
  if (message === undefined) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((block): block is { type: "text"; text: string } => {
      return typeof block === "object" && block !== null && (block as { type?: string }).type === "text";
    })
    .map((block) => block.text)
    .join("");
}

/** 带超时的等待；**超时定时器必须清掉**，否则它会拖住测试进程（实测多花 20s）。 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function toolResult(view: ConversationView) {
  const entry = view.entries.find((item) => item.kind === "pi.tool-result");
  return entry?.model?.[0] as { content?: unknown; isError?: boolean } | undefined;
}

function assistantTexts(view: ConversationView): string[] {
  return view.entries
    .filter((entry) => entry.kind === "pi.assistant")
    .map((entry) => textOf(entry.model?.[0] as { content?: unknown } | undefined));
}

/** 启动子进程并在工具开始执行后崩溃；返回 marker 里记录的执行次数。 */
async function crashWhileToolRuns(mode: "safe" | "unsafe"): Promise<{
  db: string;
  marker: string;
  dir: string;
  executionsBeforeCrash: number;
}> {
  const dir = mkdtempSync(join(tmpdir(), `colt-crash-${mode}-`));
  const db = join(dir, "session.db");
  const marker = join(dir, "executed.txt");

  try {
    const child = spawn(process.execPath, [FIXTURE, db, marker, mode], {
      // AGENTS.md §五：spawn 的 stdin 必须 ignore，否则子进程可能等一个永不关闭的管道。
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const code = await withTimeout(
      new Promise<number | null>((resolve, reject) => {
        child.once("exit", resolve);
        child.once("error", reject);
      }),
      20_000,
      "子进程 20s 未退出",
    ).catch((error: Error) => {
      throw new Error(`${error.message}；stderr=${stderr}`);
    });
    assert.equal(code, 17, `子进程没有按崩溃路径退出（code=${String(code)}）；stderr=${stderr}`);
    assert.ok(existsSync(marker), "工具没有开始执行：这条用例的前提不成立");

    return {
      db,
      marker,
      dir,
      executionsBeforeCrash: readFileSync(marker, "utf8").trim().split("\n").length,
    };
  } catch (error) {
    // 前提没建立时也要带走临时目录，别把失败现场的 DB 留在系统临时目录里。
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

async function reopenAndResume(
  db: string,
  marker: string,
  mode: "safe" | "unsafe",
): Promise<{
  view: ConversationView;
  status: string;
  executions: number;
  harness: Harness;
  dispose: () => void;
}> {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);

  let executions = 0;
  const slow = defineTool({
    name: "slow",
    description: "崩溃恢复后由父进程注册的同名工具",
    ...(mode === "safe" ? { replay: "safe" as const } : {}),
    parameters: Type.Object({ tag: Type.String() }),
    execute: async () => {
      executions += 1;
      appendFileSync(marker, "replay\n", "utf8");
      return { output: [{ type: "text" as const, text: "replayed" }] };
    },
  });

  const registry = createRegistry();
  registry.install(defineExtension({ name: "crash-fixture", tools: [slow] }));

  const harness = await Harness.open(
    await openNodeSqliteStorage(db, { busyTimeoutMs: 5_000 }),
    { models, registry },
    BACKGROUND_CONTEXT,
  );
  harness.resume();
  const root = await harness.root(BACKGROUND_CONTEXT, {
    agent: {
      model: { provider: faux.provider.id, modelId: faux.getModel().id },
      cwd: process.cwd(),
    },
  });

  // 新进程里的模型只有「恢复之后」的下一条回答。
  faux.setResponses([fauxAssistantMessage("recovered")]);
  const submission = await root.submit(
    { type: "input", content: "go", requestId: `crash-${mode}` },
    BACKGROUND_CONTEXT,
  );
  const settled = await withTimeout(
    submission.wait(BACKGROUND_CONTEXT),
    10_000,
    "resume 后 10s 内没有跑完",
  );
  assert.equal(settled.status, "done");

  const view = await root.viewState(BACKGROUND_CONTEXT);
  return {
    view: view.value,
    status: settled.status,
    executions,
    harness,
    dispose: () => view.dispose(),
  };
}

describe("durable 崩溃恢复（真子进程崩溃）", () => {
  test("replay: safe 的工具在崩溃后重跑，结果回到模型", async () => {
    const { db, marker, dir, executionsBeforeCrash } = await crashWhileToolRuns("safe");
    assert.equal(executionsBeforeCrash, 1);
    try {
      const { view, executions, harness, dispose } = await reopenAndResume(db, marker, "safe");
      try {
        assert.equal(executions, 1, "safe 工具必须在恢复后重跑一次");
        assert.equal(
          readFileSync(marker, "utf8").trim().split("\n").length,
          2,
          "marker 应同时留下崩溃前与恢复后的执行记录",
        );
        const result = toolResult(view);
        assert.ok(!result?.isError, "重跑成功不应给出错误结果");
        assert.ok(textOf(result).includes("replayed"), `工具结果应为重跑的输出，实得：${textOf(result)}`);
        assert.ok(assistantTexts(view).includes("recovered"), "恢复后模型应继续完成回答");
      } finally {
        dispose();
        await harness.close(BACKGROUND_CONTEXT);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("非 replay-safe 的工具不重跑，模型收到 interrupted", async () => {
    const { db, marker, dir, executionsBeforeCrash } = await crashWhileToolRuns("unsafe");
    assert.equal(executionsBeforeCrash, 1);
    try {
      const { view, executions, harness, dispose } = await reopenAndResume(db, marker, "unsafe");
      try {
        assert.equal(executions, 0, "非 replay-safe 的工具在恢复后不应重跑");
        assert.equal(
          readFileSync(marker, "utf8").trim().split("\n").length,
          1,
          "marker 里只能有崩溃前那一次执行",
        );
        const result = toolResult(view);
        assert.equal(result?.isError, true, "模型必须收到错误结果，而不是静默成功");
        assert.ok(
          textOf(result).toLowerCase().includes("interrupted"),
          `错误结果应明确写 interrupted，实得：${textOf(result)}`,
        );
        assert.ok(assistantTexts(view).includes("recovered"), "模型应带着错误结果继续完成回答");
      } finally {
        dispose();
        await harness.close(BACKGROUND_CONTEXT);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
