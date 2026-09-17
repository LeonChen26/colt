/**
 * 双级记忆（项目级 + 用户级）装载与注入测试。
 *
 * 依据 lib/skills.ts 的教训写六类断言：
 * ① 路径约定：项目级 `.colt/memory.md`、用户级 `~/.colt/memory.md`；
 * ② **最终组装产物里真的有记忆块**——内核不替应用拼，漏了这步装载/通知全正常，
 *    只有模型不知道，是彻头彻尾的静默失败；
 * ③ 注入有界——记忆会无界增长，截断必须真的发生、且指回文件；
 * ④ 读取失败不许静默：失败与「文件不存在」是两回事，口径必须分得开；
 * ⑤ 注入器（L2）：每请求重读的新鲜度、失败回落上次成功内容、失败期只报一次错；
 * ⑥ 两级作用域的口径分开：项目级记项目事实、用户级记跨项目偏好，
 *    注入块标签、导语、沉淀规则、报错路径都要能区分。
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDirAsync, removeTempDirAsync } from "./helpers/temp";
import type { Skill } from "@earendil-works/pi-agent-core";
import {
  appendMemoryBlock,
  compactMemoryReminder,
  createMemoryInjector,
  describeMemory,
  formatMemoryBlock,
  loadProjectMemory,
  MAX_MEMORY_CHARS,
  MEMORY_RELATIVE_PATH,
  memoryFilePath,
  readMemoryFile,
  USER_MEMORY_RELATIVE_PATH,
  userMemoryFilePath,
} from "../src/worker/lib/memory.ts";
import { composeSystemPrompt } from "../src/worker/lib/skills.ts";

const skill = (name: string): Skill => ({
  name,
  description: `${name} 的说明`,
  content: "正文",
  filePath: `${name}/SKILL.md`,
});

describe("记忆路径约定", () => {
  test("项目级取项目内固定位置 .colt/memory.md", () => {
    assert.equal(memoryFilePath("/proj"), join("/proj", ".colt", "memory.md"));
  });

  test("用户级取家目录下 ~/.colt/memory.md", () => {
    assert.equal(userMemoryFilePath("/home/u"), join("/home/u", ".colt", "memory.md"));
  });
});

describe("loadProjectMemory（真文件系统）", () => {
  let dir = "";

  before(async () => {
    dir = await makeTempDirAsync("colt-memory-");
  });

  after(async () => {
    await removeTempDirAsync(dir);
  });

  test("文件不存在：不算失败，静默当空起点", async () => {
    const memory = await loadProjectMemory(dir);
    assert.deepEqual(memory, { exists: false, content: null });
  });

  test("文件存在：内容原样读出（保留手写格式）", async () => {
    const dir2 = await makeTempDirAsync("colt-memory-");
    try {
      const file = memoryFilePath(dir2);
      await mkdir(join(dir2, ".colt"), { recursive: true });
      await writeFile(file, "# 约定\n\n- 用 pnpm\n", "utf8");
      const memory = await loadProjectMemory(dir2);
      assert.deepEqual(memory, { exists: true, content: "# 约定\n\n- 用 pnpm\n" });
    } finally {
      await removeTempDirAsync(dir2);
    }
  });

  test("全空白的文件：存在但不注入（没内容不值得占上下文）", async () => {
    const dir3 = await makeTempDirAsync("colt-memory-");
    try {
      await mkdir(join(dir3, ".colt"), { recursive: true });
      await writeFile(memoryFilePath(dir3), "  \n\t\n", "utf8");
      const memory = await loadProjectMemory(dir3);
      assert.deepEqual(memory, { exists: true, content: null });
    } finally {
      await removeTempDirAsync(dir3);
    }
  });

  test("读取失败（memory.md 是个目录）：留在 error 里，不当成「没有记忆」", async () => {
    const dir4 = await makeTempDirAsync("colt-memory-");
    try {
      await mkdir(join(dir4, ".colt", "memory.md"), { recursive: true });
      const memory = await loadProjectMemory(dir4);
      assert.equal(memory.exists, false);
      assert.equal(memory.content, null);
      assert.match(memory.error ?? "", /EISDIR/);
    } finally {
      await removeTempDirAsync(dir4);
    }
  });

  test("readMemoryFile 按显式路径读：用户级记忆走 ~/.colt/memory.md 也能读到", async () => {
    const home = await makeTempDirAsync("colt-home-");
    try {
      await mkdir(join(home, ".colt"), { recursive: true });
      await writeFile(userMemoryFilePath(home), "跨项目偏好：中文交流\n", "utf8");
      const memory = await readMemoryFile(userMemoryFilePath(home));
      assert.deepEqual(memory, { exists: true, content: "跨项目偏好：中文交流\n" });
    } finally {
      await removeTempDirAsync(home);
    }
  });
});

describe("formatMemoryBlock", () => {
  test("项目级有内容时：正文、绝对路径与维护规则俱全", () => {
    const block = formatMemoryBlock("用户偏好 pnpm", memoryFilePath("/proj"), "project");
    for (const fragment of [
      "<project_memory>",
      "用户偏好 pnpm",
      memoryFilePath("/proj"),
      "维护规则",
      "AGENTS.md",
      "</project_memory>",
    ]) {
      assert.ok(block.includes(fragment), `缺 ${fragment}：${block}`);
    }
  });

  test("用户级：独立标签 + 「跨项目」口径 + 指向 ~/.colt/memory.md", () => {
    const block = formatMemoryBlock("偏好中文交流", "/home/u/.colt/memory.md", "user");
    for (const fragment of ["<user_memory>", "跨项目", "偏好中文交流", "</user_memory>"]) {
      assert.ok(block.includes(fragment), `缺 ${fragment}：${block}`);
    }
    assert.ok(block.includes("/home/u/.colt/memory.md"), block);
    assert.ok(!block.includes("<project_memory>"), "两个作用域不该共用标签");
  });

  test("为空时也注入：文件在哪、什么值得记——这是记忆循环的起点", () => {
    const block = formatMemoryBlock(null, memoryFilePath("/proj"), "project");
    assert.ok(block.includes("当前为空"), block);
    assert.ok(block.includes(memoryFilePath("/proj")), block);
  });

  test("超过上限即截断：尾部内容不进块，并指回文件", () => {
    const head = "HEAD".repeat(MAX_MEMORY_CHARS / 4);
    const block = formatMemoryBlock(`${head}TAIL_MARKER_BEYOND`, memoryFilePath("/proj"), "project");
    assert.ok(block.includes("HEAD"), block);
    assert.ok(!block.includes("TAIL_MARKER_BEYOND"), "超出上限的内容不该出现在注入块里");
    assert.ok(block.includes("已截断"), "截断要明说，不能让模型以为看到了全文");
  });

  test("未超上限时一个字都不动", () => {
    const content = "短内容";
    const block = formatMemoryBlock(content, memoryFilePath("/proj"), "project");
    assert.ok(block.includes(content));
    assert.ok(!block.includes("已截断"));
  });
});

describe("createMemoryInjector（L2：每请求重读）", () => {
  let dir = "";
  const fileOf = () => memoryFilePath(dir);
  const makeInjector = (onError?: (message: string) => void) =>
    createMemoryInjector({ filePath: fileOf(), scope: "project", onError });

  before(async () => {
    dir = await makeTempDirAsync("colt-injector-");
  });

  after(async () => {
    await removeTempDirAsync(dir);
  });

  test("第一次请求：base 原样在前，记忆块在后", async () => {
    await mkdir(join(dir, ".colt"), { recursive: true });
    await writeFile(fileOf(), "记忆 v1", "utf8");
    const injector = makeInjector();
    const prompt = await injector.systemPromptFor("BASE");
    assert.ok(prompt.startsWith("BASE\n\n"), prompt);
    assert.ok(prompt.includes("记忆 v1"), prompt);
  });

  test("会话中途写入立即生效：文件变了，下一次请求就是新内容", async () => {
    const injector = makeInjector();
    await writeFile(fileOf(), "记忆 v2", "utf8");
    assert.ok((await injector.systemPromptFor("BASE")).includes("记忆 v2"));
    await writeFile(fileOf(), "记忆 v3", "utf8");
    assert.ok((await injector.systemPromptFor("BASE")).includes("记忆 v3"));
    assert.ok(!(await injector.systemPromptFor("BASE")).includes("记忆 v2"), "旧内容不该再出现");
  });

  test("文件变成读不到（真失败）：回落上次成功内容，失败只报一次", async () => {
    const errors: string[] = [];
    const injector = makeInjector((message) => errors.push(message));
    // 先成功读一次（此刻文件是「记忆 v3」，lastGood 才有得回落），再把它换成目录制造真读取失败
    assert.ok((await injector.systemPromptFor("BASE")).includes("记忆 v3"));
    await rm(fileOf());
    await mkdir(fileOf(), { recursive: true });
    const stale = await injector.systemPromptFor("BASE");
    assert.ok(stale.includes("记忆 v3"), "真失败要沿用上次成功内容，不能退成空");
    assert.equal(errors.length, 1, `失败期只报一次：${JSON.stringify(errors)}`);
    assert.ok(errors[0]?.includes(MEMORY_RELATIVE_PATH), errors[0] ?? "");
    assert.ok(errors[0]?.includes("沿用上次"), errors[0] ?? "");
    await injector.systemPromptFor("BASE");
    await injector.systemPromptFor("BASE");
    assert.equal(errors.length, 1, "同一段失败期的后续请求不该再报");
  });

  test("恢复后再次失败：算新的失败期，再报一次", async () => {
    const errors: string[] = [];
    const injector = makeInjector((message) => errors.push(message));
    await rm(fileOf(), { recursive: true });
    await writeFile(fileOf(), "记忆 v4", "utf8");
    assert.ok((await injector.systemPromptFor("BASE")).includes("记忆 v4"), "恢复后取到新内容");
    assert.equal(errors.length, 0, "恢复本身不该报错");
    await rm(fileOf());
    await mkdir(fileOf(), { recursive: true });
    await injector.systemPromptFor("BASE");
    assert.equal(errors.length, 1, "恢复后再失败是新的失败期，要再报一次");
  });

  test("文件删除（不是失败）按「现在是空」处理：用户删文件是合法操作", async () => {
    const errors: string[] = [];
    const injector = makeInjector((message) => errors.push(message));
    await rm(fileOf(), { recursive: true });
    const prompt = await injector.systemPromptFor("BASE");
    assert.ok(prompt.includes("当前为空"), prompt);
    assert.equal(errors.length, 0, "缺失不是失败，不该报错");
  });

  test("从头就没文件：注入空起点块，也不报错", async () => {
    const fresh = await makeTempDirAsync("colt-injector-");
    try {
      const errors: string[] = [];
      const injector = createMemoryInjector({
        filePath: memoryFilePath(fresh),
        scope: "project",
        onError: (message) => errors.push(message),
      });
      const prompt = await injector.systemPromptFor("BASE");
      assert.ok(prompt.includes("当前为空"), prompt);
      assert.ok(prompt.includes(memoryFilePath(fresh)), prompt);
      assert.equal(errors.length, 0);
    } finally {
      await removeTempDirAsync(fresh);
    }
  });

  test("截断传感器：首次超限报一次、不刷屏，退回限内再超限再报（L3 的触发信号）", async () => {
    const home = await makeTempDirAsync("colt-home-");
    try {
      const notices: string[] = [];
      const injector = createMemoryInjector({
        filePath: userMemoryFilePath(home),
        scope: "user",
        onError: (message) => notices.push(message),
      });
      const big = "X".repeat(MAX_MEMORY_CHARS + 1);
      await mkdir(join(home, ".colt"), { recursive: true });
      await writeFile(userMemoryFilePath(home), big, "utf8");
      const first = await injector.systemPromptFor("BASE");
      assert.ok(first.includes("已截断"), "注入块本身要截断");
      assert.equal(
        notices.filter((m) => m.includes("超过") && m.includes("截断")).length,
        1,
        `超限只报一次：${JSON.stringify(notices)}`,
      );
      await injector.systemPromptFor("BASE");
      assert.equal(notices.filter((m) => m.includes("超过")).length, 1, "持续超限不重复报");
      await writeFile(userMemoryFilePath(home), "瘦回来了", "utf8");
      await injector.systemPromptFor("BASE");
      assert.equal(notices.filter((m) => m.includes("超过")).length, 1, "退回限内不报");
      await writeFile(userMemoryFilePath(home), big, "utf8");
      await injector.systemPromptFor("BASE");
      assert.equal(notices.filter((m) => m.includes("超过")).length, 2, "再次超限是新的报警周期");
    } finally {
      await removeTempDirAsync(home);
    }
  });

  test("用户级注入器的报错用 ~ 展示路径（与项目级分得开）", async () => {
    const home = await makeTempDirAsync("colt-home-");
    try {
      const errors: string[] = [];
      const injector = createMemoryInjector({
        filePath: userMemoryFilePath(home),
        scope: "user",
        onError: (message) => errors.push(message),
      });
      await mkdir(userMemoryFilePath(home), { recursive: true });
      await injector.systemPromptFor("BASE");
      assert.equal(errors.length, 1);
      assert.ok(errors[0]?.includes(USER_MEMORY_RELATIVE_PATH), errors[0] ?? "");
      assert.ok(errors[0]?.includes("用户级记忆"), errors[0] ?? "");
    } finally {
      await removeTempDirAsync(home);
    }
  });
});

describe("onLoaded 回调（检索索引的同步点）", () => {
  test("成功读取（含缺失=null）时回调，读取失败不回调——失败不能被误当成删除", async () => {
    const project = await makeTempDirAsync("colt-proj-");
    try {
      const memPath = memoryFilePath(project);
      const seen: (string | null)[] = [];
      const injector = createMemoryInjector({
        filePath: memPath,
        scope: "project",
        onLoaded: (content) => seen.push(content),
      });
      await injector.systemPromptFor("BASE");
      assert.deepEqual(seen, [null], "文件缺失按 null 上报");
      const content = "- 用 pnpm 跑单测";
      await mkdir(join(project, ".colt"), { recursive: true });
      await writeFile(memPath, content, "utf8");
      await injector.systemPromptFor("BASE");
      assert.equal(seen[1], content, "内容变化后回调新内容");
      await rm(memPath);
      await mkdir(memPath, { recursive: true });
      await injector.systemPromptFor("BASE");
      await injector.systemPromptFor("BASE");
      assert.equal(seen.length, 2, "读取失败不回调（索引维持原状）");
    } finally {
      await removeTempDirAsync(project);
    }
  });
});

describe("compactMemoryReminder", () => {
  test("带绝对路径、两种去处都指到、「无可沉淀就忽略」——不逼助手编造记忆", () => {
    const reminder = compactMemoryReminder("/proj");
    assert.ok(reminder.includes(memoryFilePath("/proj")), reminder);
    assert.ok(reminder.includes("AGENTS.md"), reminder);
    assert.ok(reminder.includes("忽略"), reminder);
    assert.ok(reminder.includes("write"), reminder);
  });
});

describe("最终组装产物（entry.ts 的接法：基础 → 技能 → AGENTS.md → 用户级 → 项目级）", () => {
  const base = "你是 Colt 桌面工作台中的编码助手。";

  test("记忆块真的进了系统提示词，且基础提示词原样在前", () => {
    const prompt = appendMemoryBlock(base, "项目记忆的内容", memoryFilePath("/proj"), "project");
    assert.ok(prompt.startsWith(base), "基础提示词必须原样在前面");
    assert.ok(prompt.includes("项目记忆的内容"), prompt);
  });

  test("与技能块共存：两块都在最终产物里（只验入参接收验不出静默失败）", () => {
    const prompt = appendMemoryBlock(
      composeSystemPrompt(base, [skill("pdf")]),
      "记忆正文",
      memoryFilePath("/proj"),
      "project",
    );
    assert.ok(prompt.includes("<available_skills>"), prompt);
    assert.ok(prompt.includes("<project_memory>"), prompt);
  });

  test("双级并存：用户级在前、项目级在后（一般 → 具体，越具体的越靠近内容）", () => {
    const prompt = appendMemoryBlock(
      appendMemoryBlock(base, "跨项目偏好", "/home/u/.colt/memory.md", "user"),
      "项目事实",
      memoryFilePath("/proj"),
      "project",
    );
    const userAt = prompt.indexOf("<user_memory>");
    const projectAt = prompt.indexOf("<project_memory>");
    assert.ok(userAt >= 0 && projectAt > userAt, `次序不对：user@${userAt} project@${projectAt}`);
    assert.ok(prompt.includes("跨项目偏好") && prompt.includes("项目事实"), prompt);
  });
});

describe("describeMemory", () => {
  test("项目级装载到了内容才报：带相对路径与字数（隐式信任通道要可见）", () => {
    const notice = describeMemory({ exists: true, content: "12345" }, "project");
    assert.ok(notice?.includes(MEMORY_RELATIVE_PATH), notice ?? "");
    assert.ok(notice?.includes("5 字"), notice ?? "");
  });

  test("用户级报用户级的路径", () => {
    const notice = describeMemory({ exists: true, content: "abc" }, "user");
    assert.ok(notice?.includes(USER_MEMORY_RELATIVE_PATH), notice ?? "");
    assert.ok(notice?.includes("用户级记忆"), notice ?? "");
  });

  test("缺失/为空返回 null（正常起点，不制造噪音）", () => {
    assert.equal(describeMemory({ exists: false, content: null }, "project"), null);
    assert.equal(describeMemory({ exists: true, content: null }, "user"), null);
  });

  test("读取失败要报出来，且与「没有记忆」口径不同", () => {
    const notice = describeMemory({ exists: false, content: null, error: "EISDIR" }, "project");
    assert.ok(notice?.includes("读取失败"), notice ?? "");
    assert.ok(notice?.includes("EISDIR"), notice ?? "");
    assert.ok(notice?.includes("未注入"), notice ?? "");
  });
});
