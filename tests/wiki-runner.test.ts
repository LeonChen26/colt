/**
 * CodeWiki 生成执行层（`main/wiki/runner.ts`）。
 *
 * 这一层刻意不 import electron，进程也是注入的——所以用例不需要本机装 CodeWiki，
 * 也不会真的花模型额度。钉住的都是「失败时会不会撒谎」的判据：
 *   - 同一项目单飞（不并发写同一个 `docs/wiki/`）；
 *   - 退出码 0 但产物没更新 = 失败，不能说「成功」；
 *   - 取消后是 `cancelled`，不是 `failed`，且保留已写出的日志；
 *   - 日志环形上限、环境白名单（密钥一律不带）。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir, removeTempDir } from "./helpers/temp";
import type { WikiGenerateEvent } from "../src/shared/protocol.ts";
import {
  appendLogLines,
  buildWikiEnv,
  cancelWikiGeneration,
  formatWikiProbeFailure,
  MAX_LOG_LINES,
  readWikiGeneration,
  startWikiGeneration,
  wikiArtifactUpdated,
  wikiGenerateArgs,
  WikiLineBuffer,
  type StartWikiGenerationDeps,
  type WikiChildProcess,
} from "../src/main/wiki/runner.ts";

/** 可控的假进程：`data` / `finish` 由用例显式触发，不依赖真实 IO 的时序 */
class FakeChild {
  readonly #events = new EventEmitter();
  readonly #stdout = new EventEmitter();
  readonly #stderr = new EventEmitter();

  pid = 4242;
  readonly stdout = this.#stdout as unknown as NodeJS.ReadableStream;
  readonly stderr = this.#stderr as unknown as NodeJS.ReadableStream;
  kills = 0;

  on(event: string, listener: (...args: never[]) => void): this {
    this.#events.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  kill(): boolean {
    this.kills += 1;
    return true;
  }

  data(text: string): void {
    this.#stdout.emit("data", Buffer.from(text, "utf8"));
  }

  fail(text: string): void {
    this.#stderr.emit("data", Buffer.from(text, "utf8"));
  }

  finish(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.#events.emit("close", code, signal);
  }
}

interface HarnessOptions {
  readyError?: string | null;
  artifact?: boolean;
  mode?: "full" | "update";
}

function harness(root: string, options: HarnessOptions = {}) {
  const events: WikiGenerateEvent[] = [];
  const spawns: {
    command: string;
    args: string[];
    cwd: string;
    shell: boolean;
    env: NodeJS.ProcessEnv;
  }[] = [];
  const killed: FakeChild[] = [];
  let child: FakeChild | null = null;

  const deps: StartWikiGenerationDeps = {
    sessionId: "s1",
    root,
    mode: options.mode ?? "full",
    command: "/venv/codewiki",
    checkReady: async () => options.readyError ?? null,
    onEvent: (event) => events.push(event),
    spawnImpl: (command, args, spawnOptions) => {
      const fake = new FakeChild();
      child = fake;
      spawns.push({
        command,
        args,
        cwd: spawnOptions.cwd,
        shell: spawnOptions.shell,
        env: spawnOptions.env,
      });
      return fake as unknown as WikiChildProcess;
    },
    killTree: (target) => {
      const fake = target as unknown as FakeChild;
      killed.push(fake);
      fake.kill();
    },
    artifactUpdated: () => options.artifact ?? true,
  };

  return { deps, events, spawns, killed, child: () => child };
}

describe("wikiGenerateArgs：写入路径钉死在代码里", () => {
  test("全量与更新都只输出到 docs/wiki", () => {
    assert.deepEqual(wikiGenerateArgs("full"), ["generate", "--output", "docs/wiki"]);
    assert.deepEqual(wikiGenerateArgs("update"), [
      "generate",
      "--update",
      "--output",
      "docs/wiki",
    ]);
  });
});

describe("buildWikiEnv：白名单投影", () => {
  test("只透传宿主条件与用户自己的 CODEWIKI_*，密钥一律不带", () => {
    const env = buildWikiEnv({
      PATH: "C:\\Windows",
      SystemRoot: "C:\\Windows",
      DEEPSEEK_API_KEY: "sk-deepseek",
      OPENAI_API_KEY: "sk-openai",
      ANTHROPIC_API_KEY: "sk-anthropic",
      NODE_OPTIONS: "--require hook",
      ELECTRON_RUN_AS_NODE: "1",
      CODEWIKI_PROVIDER: "openai",
      CODEWIKI_API_KEY: "cw-key",
      CODEWIKI_EMPTY: "",
    });
    assert.equal(env.PATH, "C:\\Windows");
    assert.equal(env.SystemRoot, "C:\\Windows");
    assert.equal(env.CODEWIKI_PROVIDER, "openai");
    assert.equal(env.CODEWIKI_API_KEY, "cw-key");
    for (const leaked of [
      "DEEPSEEK_API_KEY",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "NODE_OPTIONS",
      "ELECTRON_RUN_AS_NODE",
      "CODEWIKI_EMPTY",
    ]) {
      assert.equal(env[leaked], undefined, `${leaked} 不该出现在生成环境里`);
    }
    // 少了这三个，Python 的输出会被缓冲，面板会长时间停在「生成中…」
    assert.equal(env.PYTHONUNBUFFERED, "1");
    assert.equal(env.PYTHONIOENCODING, "utf-8");
    assert.equal(env.PYTHONUTF8, "1");
  });
});

describe("WikiLineBuffer：按行切、chunk 边界不劈行", () => {
  test("跨 chunk 的半行会接起来，\\r 也当分隔符", () => {
    const buffer = new WikiLineBuffer();
    assert.deepEqual(buffer.push("a"), []);
    assert.deepEqual(buffer.push("b\nc\r\nd"), ["ab", "c"]);
    assert.deepEqual(buffer.flush(), ["d"]);
    assert.deepEqual(buffer.flush(), []);
  });

  test("去掉 ANSI 颜色（rich 的进度条带色）", () => {
    const buffer = new WikiLineBuffer();
    assert.deepEqual(buffer.push("\x1b[31mred\x1b[0m\n"), ["red"]);
  });
});

describe("appendLogLines：环形上限", () => {
  test("只保留最近 max 行", () => {
    const ring: string[] = [];
    appendLogLines(ring, ["1", "2", "3"], 2);
    assert.deepEqual(ring, ["2", "3"]);
    appendLogLines(ring, ["4"], 2);
    assert.deepEqual(ring, ["3", "4"]);
  });
});

describe("wikiArtifactUpdated：产物时间戳判据", () => {
  test("metadata.json 在本次任务期间被写过才算更新", () => {
    const root = makeTempDir("colt-wiki-artifact-");
    try {
      const wiki = join(root, "docs", "wiki");
      mkdirSync(wiki, { recursive: true });
      const meta = join(wiki, "metadata.json");
      writeFileSync(meta, "{}", "utf8");
      assert.equal(wikiArtifactUpdated(root, Date.now()), true);

      // 旧产物：mtime 远早于任务启动（超过宽限）→ 不能算这次写成功
      utimesSync(meta, new Date(1_000), new Date(1_000));
      assert.equal(wikiArtifactUpdated(root, Date.now()), false);
    } finally {
      removeTempDir(root);
    }
  });

  test("没有 metadata.json 就是 false（不是猜测）", () => {
    const root = makeTempDir("colt-wiki-artifact-empty-");
    try {
      assert.equal(wikiArtifactUpdated(root, Date.now()), false);
    } finally {
      removeTempDir(root);
    }
  });
});

describe("formatWikiProbeFailure：缺什么 + 怎么装", () => {
  test("逐项摆出 label / detail / hint", () => {
    const text = formatWikiProbeFailure([
      { label: "Python", detail: "没找到可用的解释器", hint: "装 Python 3.12+" },
      { label: "git", detail: "git 不可用", hint: null },
    ]);
    assert.match(text, /Python：没找到可用的解释器/);
    assert.match(text, /装 Python 3\.12\+/);
    assert.match(text, /git：git 不可用/);
    assert.equal(formatWikiProbeFailure([]), "");
  });
});

describe("startWikiGeneration", () => {
  test("退出码 0 + 产物已更新 → done，日志随终态一起推", async () => {
    const root = makeTempDir("colt-wiki-runner-ok-");
    try {
      const h = harness(root, { artifact: true });
      assert.deepEqual(await startWikiGeneration(h.deps), {
        started: true,
        alreadyRunning: false,
      });
      assert.equal(h.spawns.length, 1);
      assert.equal(h.spawns[0]?.command, "/venv/codewiki");
      assert.equal(h.spawns[0]?.cwd, root);
      assert.equal(h.spawns[0]?.shell, false);
      assert.deepEqual(h.spawns[0]?.args, ["generate", "--output", "docs/wiki"]);

      h.child()?.data("line 1\nline 2\n");
      h.child()?.finish(0);

      const last = h.events.at(-1);
      assert.equal(last?.phase, "done");
      assert.equal(last?.error, null);
      assert.deepEqual(last?.lines, ["line 1", "line 2"]);
      assert.equal(readWikiGeneration(root)?.phase, "done");
      assert.deepEqual(readWikiGeneration(root)?.lines, ["line 1", "line 2"]);
    } finally {
      removeTempDir(root);
    }
  });

  test("同一项目单飞：第二次直接 alreadyRunning，不再起进程", async () => {
    const root = makeTempDir("colt-wiki-runner-single-");
    try {
      const h = harness(root);
      assert.equal((await startWikiGeneration(h.deps)).started, true);
      assert.deepEqual(await startWikiGeneration({ ...h.deps, sessionId: "s2" }), {
        started: false,
        alreadyRunning: true,
      });
      assert.equal(h.spawns.length, 1);
      h.child()?.finish(0);
    } finally {
      removeTempDir(root);
    }
  });

  test("退出码非 0 → failed，错误里带退出码", async () => {
    const root = makeTempDir("colt-wiki-runner-exit-");
    try {
      const h = harness(root);
      await startWikiGeneration(h.deps);
      h.child()?.fail("boom\n");
      h.child()?.finish(3);

      const last = h.events.at(-1);
      assert.equal(last?.phase, "failed");
      assert.match(last?.error ?? "", /退出码 3/);
      assert.deepEqual(last?.lines, ["boom"]);
      assert.equal(readWikiGeneration(root)?.phase, "failed");
    } finally {
      removeTempDir(root);
    }
  });

  test("退出码 0 但产物没更新 → failed（不能说成功）", async () => {
    const root = makeTempDir("colt-wiki-runner-noartifact-");
    try {
      const h = harness(root, { artifact: false });
      await startWikiGeneration(h.deps);
      h.child()?.finish(0);

      const last = h.events.at(-1);
      assert.equal(last?.phase, "failed");
      assert.match(last?.error ?? "", /metadata\.json/);
    } finally {
      removeTempDir(root);
    }
  });

  test("取消：杀进程树，终态是 cancelled 且保留已写出的日志", async () => {
    const root = makeTempDir("colt-wiki-runner-cancel-");
    try {
      const h = harness(root);
      await startWikiGeneration(h.deps);
      assert.equal(cancelWikiGeneration("s1"), true);
      assert.equal(h.killed.length, 1);

      h.child()?.data("写了半页\n");
      h.child()?.finish(null);

      const last = h.events.at(-1);
      assert.equal(last?.phase, "cancelled");
      assert.equal(last?.error, null);
      assert.deepEqual(last?.lines, ["写了半页"]);
      assert.equal(readWikiGeneration(root)?.phase, "cancelled");
      assert.equal(cancelWikiGeneration("s1"), false);
    } finally {
      removeTempDir(root);
    }
  });

  test("前置检查不过：抛错且不启动进程", async () => {
    const root = makeTempDir("colt-wiki-runner-probe-");
    try {
      const h = harness(root, { readyError: "CodeWiki 生成前置检查未通过：缺 Python" });
      await assert.rejects(startWikiGeneration(h.deps), /缺 Python/);
      assert.equal(h.spawns.length, 0);
      assert.equal(readWikiGeneration(root), null);
    } finally {
      removeTempDir(root);
    }
  });

  test("日志环形上限：快照与终态事件都只留最近 400 行", async () => {
    const root = makeTempDir("colt-wiki-runner-log-");
    try {
      const h = harness(root);
      await startWikiGeneration(h.deps);
      const lines = Array.from({ length: MAX_LOG_LINES + 5 }, (_, index) => `L${index + 1}`);
      h.child()?.data(`${lines.join("\n")}\n`);
      h.child()?.finish(0);

      const snapshot = readWikiGeneration(root);
      assert.equal(snapshot?.lines.length, MAX_LOG_LINES);
      assert.equal(snapshot?.lines[0], "L6");
      assert.equal(snapshot?.lines.at(-1), `L${MAX_LOG_LINES + 5}`);

      const last = h.events.at(-1);
      assert.ok((last?.lines.length ?? 0) <= MAX_LOG_LINES);
      assert.equal(last?.lines.at(-1), `L${MAX_LOG_LINES + 5}`);
    } finally {
      removeTempDir(root);
    }
  });
});
