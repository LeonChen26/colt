/**
 * 渲染层纯函数测试：ANSI 解析、diff 行分类、参数格式化、⑦-G 的改动清单、⑥ 运行状态判定、
 * ⑦-H 的「统计」聚合、N1 的观测条目详情。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseAnsi } from "../src/renderer/src/lib/ansi.ts";
import { classifyDiffLine } from "../src/renderer/src/lib/diff.ts";
import { formatAgo, formatArgs, runStateOf, samePath } from "../src/renderer/src/lib/format.ts";
import { buildChangeList, isProjectRelative } from "../src/renderer/src/lib/change-list.ts";
import {
  UNKNOWN_MODEL,
  buildSessionStats,
  formatTokenCount,
  formatToolDuration,
  toolCallSummary,
} from "../src/renderer/src/lib/session-stats.ts";
import {
  consoleFields,
  consoleRowKey,
  downloadFields,
  downloadRowKey,
  networkFields,
  networkRowKey,
  observeCopyText,
} from "../src/renderer/src/lib/observe-detail.ts";
import type { ViewFileChange } from "@shared/worker-protocol";
import type {
  ConsoleEntry,
  DownloadEntry,
  NetworkEntry,
  ToolCallRecord,
  UsageRecord,
} from "@shared/protocol";

describe("parseAnsi", () => {
  test("无转义时返回单个原样片段", () => {
    assert.deepEqual(parseAnsi("hello world"), [{ text: "hello world", className: "" }]);
  });

  test("解析基本前景色", () => {
    const spans = parseAnsi("\u001B[31mred\u001B[0m");
    assert.deepEqual(spans, [
      { text: "red", className: "text-red-400" },
    ]);
  });

  test("重置后又回到无色", () => {
    const spans = parseAnsi("\u001B[32mG\u001B[0m plain");
    assert.equal(spans[0]?.className, "text-green-400");
    assert.equal(spans[1]?.className, "");
    assert.equal(spans[1]?.text, " plain");
  });

  test("加粗与颜色叠加", () => {
    const spans = parseAnsi("\u001B[1;33mX\u001B[0m");
    // 按码序处理：先 1（加粗）再 33（颜色），颜色追加在末尾
    assert.equal(spans[0]?.className, "font-bold text-yellow-400");
  });

  test("换色时旧颜色被替换而非累加", () => {
    const spans = parseAnsi("\u001B[31ma\u001B[32mb\u001B[0m");
    assert.equal(spans[0]?.className, "text-red-400");
    // 第二段不应同时含红与绿
    assert.equal(spans[1]?.className, "text-green-400");
  });

  test("空文本返回空数组", () => {
    assert.deepEqual(parseAnsi(""), []);
  });

  test("裸转义无文本产出空内容", () => {
    assert.deepEqual(parseAnsi("\u001B[0m"), []);
  });
});

describe("classifyDiffLine", () => {
  test("块头", () => {
    assert.equal(classifyDiffLine("@@ -1,3 +1,4 @@"), "hunk");
  });

  test("文件头优先于增删判定", () => {
    assert.equal(classifyDiffLine("+++ b/file.ts"), "meta");
    assert.equal(classifyDiffLine("--- a/file.ts"), "meta");
  });

  test("新增与删除", () => {
    assert.equal(classifyDiffLine("+added"), "add");
    assert.equal(classifyDiffLine("-removed"), "remove");
  });

  test("上下文行", () => {
    assert.equal(classifyDiffLine(" unchanged"), "context");
    assert.equal(classifyDiffLine(""), "context");
  });
});

describe("formatArgs", () => {
  test("美化合法 JSON", () => {
    assert.equal(formatArgs('{"a":1}'), '{\n  "a": 1\n}');
  });

  test("非法 JSON 原样返回", () => {
    assert.equal(formatArgs("not json"), "not json");
  });

  test("空串原样返回", () => {
    assert.equal(formatArgs(""), "");
  });
});

describe("runStateOf", () => {
  test("运行中优先于任何终态", () => {
    assert.equal(runStateOf(true, null), "running");
    assert.equal(runStateOf(true, { status: "failed", error: "boom" }), "running");
  });

  test("用户中断 → aborted", () => {
    assert.equal(runStateOf(false, { status: "aborted" }), "aborted");
  });

  test("异常结束 → failed（带着 / 不带 error 都算）", () => {
    assert.equal(runStateOf(false, { status: "failed", error: "请求超时" }), "failed");
    assert.equal(runStateOf(false, { status: "failed" }), "failed");
  });

  test("正常跑完与「还没跑过」一样回到空闲", () => {
    assert.equal(runStateOf(false, { status: "completed" }), "idle");
    assert.equal(runStateOf(false, null), "idle");
  });

  test("declined 不产生专门的终态（run 不会产出它）", () => {
    assert.equal(runStateOf(false, { status: "declined" }), "idle");
  });
});

/** 造一条改动记录。名字统一用小写，避免 localeCompare 在大小写上产生环境差异 */
const change = (
  path: string,
  options: { at?: number; kind?: "write" | "edit"; added?: number; removed?: number } = {},
): ViewFileChange => ({
  id: `${path}@${options.at ?? 0}`,
  path,
  kind: options.kind ?? "edit",
  patch: null,
  addedLines: options.added ?? 1,
  removedLines: options.removed ?? 0,
  timestamp: options.at ?? 0,
});

describe("isProjectRelative", () => {
  test("项目内相对路径可用（含子目录、反斜杠）", () => {
    assert.equal(isProjectRelative("package.json"), true);
    assert.equal(isProjectRelative("src/main/a.ts"), true);
    assert.equal(isProjectRelative("src\\main\\a.ts"), true);
  });

  test("绝对路径不可用（四种写法）", () => {
    assert.equal(isProjectRelative("C:/x/y.txt"), false);
    assert.equal(isProjectRelative("C:\\x\\y.txt"), false);
    assert.equal(isProjectRelative("/tmp/x.txt"), false);
    assert.equal(isProjectRelative("\\\\server\\share\\x.txt"), false);
  });

  test(".. 逃逸不可用", () => {
    assert.equal(isProjectRelative("../x.txt"), false);
    assert.equal(isProjectRelative("a/../../b.txt"), false);
  });

  test("空白不可用", () => {
    assert.equal(isProjectRelative("   "), false);
    assert.equal(isProjectRelative(""), false);
  });
});

describe("buildChangeList", () => {
  test("根下文件归到根目录组（dir 为空串）", () => {
    const list = buildChangeList([change("package.json"), change("readme.md")]);
    assert.equal(list.groups.length, 1);
    assert.equal(list.groups[0]?.dir, "");
    assert.deepEqual(
      list.groups[0]?.files.map((file) => file.name),
      ["package.json", "readme.md"],
    );
  });

  test("同一目录的文件归到一组，组名是整条目录路径（只切一层，不是可折叠树）", () => {
    const list = buildChangeList([change("src/main/a.ts"), change("src/main/b.ts")]);
    assert.equal(list.groups.length, 1);
    assert.equal(list.groups[0]?.dir, "src/main");
    assert.deepEqual(
      list.groups[0]?.files.map((file) => file.name),
      ["a.ts", "b.ts"],
    );
  });

  test("不同目录各成一组，且组按最近改动倒序", () => {
    const list = buildChangeList([
      change("src/a.ts", { at: 5 }),
      change("docs/b.md", { at: 20 }),
    ]);
    assert.deepEqual(
      list.groups.map((group) => group.dir),
      ["docs", "src"],
    );
  });

  test("同一文件多次编辑折成一条，但「处」按改动条数算", () => {
    const list = buildChangeList([change("a.ts", { at: 1 }), change("a.ts", { at: 9 })]);
    assert.equal(list.groups[0]?.files.length, 1);
    assert.equal(list.groups[0]?.files[0]?.history.length, 2);
    assert.equal(list.places, 2);
    assert.equal(list.fileCount, 1);
  });

  test("同文件的多次改动合计 +a −b（概念稿的 ×3 卡片）", () => {
    const list = buildChangeList([
      change("a.ts", { at: 1, added: 3, removed: 2 }),
      change("a.ts", { at: 2, added: 4, removed: 1 }),
    ]);
    const file = list.groups[0]?.files[0];
    assert.equal(file?.addedLines, 7);
    assert.equal(file?.removedLines, 3);
    assert.equal(list.addedLines, 7);
    assert.equal(list.removedLines, 3);
  });

  test("历史按时间倒序（最新在前），kind 取最新一次", () => {
    const list = buildChangeList([
      change("a.ts", { at: 1, kind: "edit" }),
      change("a.ts", { at: 9, kind: "write" }),
    ]);
    const file = list.groups[0]?.files[0];
    assert.deepEqual(
      file?.history.map((item) => item.timestamp),
      [9, 1],
    );
    assert.equal(file?.kind, "write");
    assert.equal(file?.latestAt, 9);
  });

  test("组内文件也按最近改动倒序（同刻再按路径升序）", () => {
    const list = buildChangeList([
      change("src/old.ts", { at: 1 }),
      change("src/new.ts", { at: 9 }),
      change("src/same.ts", { at: 9 }),
    ]);
    assert.deepEqual(
      list.groups[0]?.files.map((file) => file.name),
      ["new.ts", "same.ts", "old.ts"],
    );
  });

  test("项目外路径被挡掉，并按路径去重后计数", () => {
    const list = buildChangeList([
      change("C:\\other\\secret.txt"),
      change("C:\\other\\secret.txt"),
      change("/tmp/x.txt"),
      change("ok.ts"),
    ]);
    assert.equal(list.hidden, 2);
    assert.equal(list.fileCount, 1);
    assert.deepEqual(
      list.groups[0]?.files.map((file) => file.name),
      ["ok.ts"],
    );
  });

  test("反斜杠与 `.` 段归一：同一文件的不同写法只算一条", () => {
    const list = buildChangeList([
      change("src\\main\\a.ts", { at: 1 }),
      change("src/main/a.ts", { at: 2 }),
      change("./a.ts", { at: 3 }),
    ]);
    assert.equal(list.fileCount, 2);
    assert.equal(list.places, 3);
    assert.deepEqual(
      list.groups.map((group) => [group.dir, group.files.length]),
      [
        ["", 1],
        ["src/main", 1],
      ],
    );
  });

  test("空输入得到空清单", () => {
    const list = buildChangeList([]);
    assert.deepEqual(list.groups, []);
    assert.equal(list.places, 0);
    assert.equal(list.fileCount, 0);
    assert.equal(list.hidden, 0);
  });
});

describe("formatAgo", () => {
  test("两秒内算「刚刚」", () => {
    assert.equal(formatAgo(1000, 1000), "刚刚");
    assert.equal(formatAgo(1000, 2500), "刚刚");
  });

  test("未来时间戳不倒着算", () => {
    assert.equal(formatAgo(10_000, 0), "刚刚");
  });

  test("秒 / 分 / 时逐级进位", () => {
    assert.equal(formatAgo(0, 5_000), "5s 前");
    assert.equal(formatAgo(0, 65_000), "1m 前");
    assert.equal(formatAgo(0, 3_601_000), "1h 前");
  });
});

describe("samePath", () => {
  test("没有高亮目标时永远不匹配", () => {
    assert.equal(samePath("src/a.ts", null), false);
    assert.equal(samePath("", "src/a.ts"), false);
  });

  test("完全相同即匹配", () => {
    assert.equal(samePath("src/a.ts", "src/a.ts"), true);
  });

  test("绝对路径按后缀匹配（工具入参常给绝对路径）", () => {
    assert.equal(samePath("src/a.ts", "C:\\proj\\src\\a.ts"), true);
    assert.equal(samePath("a.ts", "src/a.ts"), true);
  });

  test("只是名字后缀相同不算匹配", () => {
    assert.equal(samePath("src/a.ts", "src/b.ts"), false);
  });

  test("裸后缀也算命中——刻意与 matchChangeByPath 用同一套容差", () => {
    // 这条看着像误判，其实是**有意**的：工具入参会给出各种前缀写法，
    // 而 `matchChangeByPath`（工具卡 → 改动记录的配对）用的就是这三条判据。
    // 两处若不一致，同一行 hover 会在「正在处理」与工具卡上高亮不同的文件。
    assert.equal(samePath("rc/a.ts", "src/a.ts"), true);
  });
});

/** 造一条用量记录：只写用例关心的字段，其余给中性默认值 */
const usage = (
  model: string | null,
  costUsd: number,
  tokens: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } = {},
): UsageRecord => ({
  id: 0,
  provider: null,
  model,
  inputTokens: tokens.input ?? 0,
  outputTokens: tokens.output ?? 0,
  cacheReadTokens: tokens.cacheRead ?? 0,
  cacheWriteTokens: tokens.cacheWrite ?? 0,
  costUsd,
  createdAt: 0,
});

/** 造一条工具调用；id 用自增序号（不用随机数——测试要可复现） */
let toolCallSeq = 0;
const toolCall = (
  toolName: string,
  options: { durationMs?: number | null; isError?: boolean; inputJson?: string | null } = {},
): ToolCallRecord => ({
  id: `call-${(toolCallSeq += 1)}`,
  runId: null,
  toolName,
  inputJson: options.inputJson ?? null,
  isError: options.isError ?? false,
  durationMs: options.durationMs ?? null,
  createdAt: 0,
});

describe("buildSessionStats", () => {
  test("总额累加四类 tokens、缓存读写与费用", () => {
    const stats = buildSessionStats(
      [usage("m", 0.5, { input: 100, output: 20, cacheRead: 30, cacheWrite: 5 })],
      [],
    );
    assert.deepEqual(stats.totals, {
      calls: 1,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 5,
      cacheTokens: 35,
      costUsd: 0.5,
    });
    // 「缓存命中」的口径是 **读 / 输入**（对齐概念稿「占输入 49%」）
    assert.equal(stats.cacheHitRatio, 0.3);
  });

  test("KPI 总额等于各模型行之和（自己算而不读 totals 的理由）", () => {
    const stats = buildSessionStats([usage("a", 0.3), usage("b", 0.7)], []);
    const sum = stats.models.reduce((acc, item) => acc + item.costUsd, 0);
    assert.equal(sum, stats.totals.costUsd);
  });

  test("同一模型合并为一行，按费用降序，占比的分母是总费用", () => {
    const stats = buildSessionStats(
      [
        usage("cheap", 1, { input: 10 }),
        usage("pricey", 3, { input: 10 }),
        usage("pricey", 0, { input: 10 }),
      ],
      [],
    );
    assert.deepEqual(
      stats.models.map((item) => [item.model, item.calls, item.costUsd, item.costShare]),
      [
        ["pricey", 2, 3, 0.75],
        ["cheap", 1, 1, 0.25],
      ],
    );
  });

  test("模型名为 null 归到「未知模型」，不与真实模型混在一行", () => {
    const stats = buildSessionStats([usage(null, 1), usage("m", 1)], []);
    assert.deepEqual(
      stats.models.map((item) => item.model),
      [UNKNOWN_MODEL, "m"],
    );
  });

  test("总费用为 0 时占比是 0 而不是 NaN（否则界面会渲染「NaN%」）", () => {
    const stats = buildSessionStats([usage("m", 0), usage("m", 0)], []);
    assert.equal(stats.models[0]?.costShare, 0);
    assert.equal(stats.cacheHitRatio, 0);
    assert.deepEqual(buildSessionStats([], []).models, []);
  });

  test("工具次数排行：降序、带失败数与分母占比", () => {
    const stats = buildSessionStats(
      [],
      [
        toolCall("read"),
        toolCall("bash", { isError: true }),
        toolCall("read"),
        toolCall("read"),
        toolCall("edit"),
      ],
    );
    assert.equal(stats.toolCalls, 5);
    assert.equal(stats.toolFailures, 1);
    assert.deepEqual(
      stats.toolCounts.map((item) => [item.toolName, item.calls, item.failed, item.share]),
      [
        ["read", 3, 0, 0.6],
        ["bash", 1, 1, 0.2],
        ["edit", 1, 0, 0.2],
      ],
    );
  });

  test("耗时排行只收有耗时的调用，空耗时不计入也不拉低分母", () => {
    const stats = buildSessionStats(
      [],
      [
        toolCall("bash", { durationMs: 8000 }),
        toolCall("bash", { durationMs: 4000 }),
        toolCall("edit", { durationMs: 1000 }),
        // 没有耗时的调用：次数排行里算 1 次，耗时排行里不参与
        toolCall("edit", { durationMs: null }),
        toolCall("read", { durationMs: null }),
      ],
    );
    assert.equal(stats.toolTotalMs, 13000);
    assert.deepEqual(
      stats.toolDurations.map((item) => [item.toolName, item.totalMs, item.calls, item.share]),
      [
        ["bash", 12000, 2, 12000 / 13000],
        ["edit", 1000, 1, 1000 / 13000],
      ],
    );
    // 次数排行照旧把 5 次都算上
    assert.equal(stats.toolCounts.find((item) => item.toolName === "read")?.calls, 1);
  });

  test("没有调用时各个占比是 0、耗时为 0（不产生 NaN）", () => {
    const stats = buildSessionStats([], []);
    assert.equal(stats.toolCalls, 0);
    assert.equal(stats.toolFailures, 0);
    assert.equal(stats.toolTotalMs, 0);
    assert.deepEqual(stats.toolCounts, []);
    assert.deepEqual(stats.toolDurations, []);
  });
});

describe("formatTokenCount", () => {
  test("不足千原样输出", () => {
    assert.equal(formatTokenCount(0), "0");
    assert.equal(formatTokenCount(999), "999");
  });

  test("千档保留一位有效小数，尾零去掉", () => {
    assert.equal(formatTokenCount(1000), "1K");
    assert.equal(formatTokenCount(1500), "1.5K");
    assert.equal(formatTokenCount(86400), "86.4K");
    assert.equal(formatTokenCount(612000), "612K");
  });

  test("百万档保留两位", () => {
    assert.equal(formatTokenCount(1240000), "1.24M");
    assert.equal(formatTokenCount(1050000), "1.05M");
    assert.equal(formatTokenCount(2000000), "2M");
  });
});

describe("formatToolDuration", () => {
  test("毫秒 / 秒 / 分秒三档", () => {
    assert.equal(formatToolDuration(0), "0ms");
    assert.equal(formatToolDuration(200), "200ms");
    assert.equal(formatToolDuration(1000), "1.0s");
    assert.equal(formatToolDuration(18400), "18.4s");
    assert.equal(formatToolDuration(60000), "1m00s");
    assert.equal(formatToolDuration(158000), "2m38s");
  });

  test("秒数进位后再拆分（否则会出现 2m60s）", () => {
    assert.equal(formatToolDuration(159999), "2m40s");
  });
});

describe("toolCallSummary", () => {
  test("按优先级取入参：命令 > 路径 > 地址", () => {
    assert.equal(toolCallSummary('{"command":"npm test","path":"x"}'), "npm test");
    assert.equal(toolCallSummary('{"path":"src/a.ts"}'), "src/a.ts");
    assert.equal(toolCallSummary('{"url":"https://example.com"}'), "https://example.com");
    assert.equal(toolCallSummary('{"action":"click","selector":"#go"}'), "#go");
  });

  test("都不认识时退回第一个非空字符串（不特判工具）", () => {
    assert.equal(toolCallSummary('{"old_string":"before","new_string":"after"}'), "before");
  });

  test("非 JSON / 空对象 / 无字符串参数时给空串", () => {
    assert.equal(toolCallSummary("not json"), "");
    assert.equal(toolCallSummary(""), "");
    assert.equal(toolCallSummary(null), "");
    assert.equal(toolCallSummary("{}"), "");
    assert.equal(toolCallSummary('{"n":5,"ok":true}'), "");
  });

  test("空白字符串不算数", () => {
    assert.equal(toolCallSummary('{"command":"   ","path":"a.ts"}'), "a.ts");
  });
});

/** 造一条控制台记录 */
const consoleEntry = (over: Partial<ConsoleEntry> = {}): ConsoleEntry => ({
  level: "error",
  message: "夹具：这是一条脚本报错",
  source: "http://127.0.0.1:8123/",
  line: 71,
  ...over,
});

/** 造一条网络记录 */
const networkEntry = (over: Partial<NetworkEntry> = {}): NetworkEntry => ({
  url: "http://127.0.0.1:8123/api/missing",
  method: "GET",
  resourceType: "fetch",
  statusCode: 404,
  ...over,
});

/** 造一条下载记录 */
const downloadEntry = (over: Partial<DownloadEntry> = {}): DownloadEntry => ({
  filename: "1-colt-payload.txt",
  path: "C:\\Users\\me\\AppData\\browser-downloads\\s1\\1-colt-payload.txt",
  url: "http://127.0.0.1:8123/payload.txt",
  bytes: 2048,
  state: "completed",
  ...over,
});

/** 按标签取值（找不到给 undefined），断言因此不必关心字段顺序 */
const fieldOf = (
  fields: { label: string; value: string }[],
  label: string,
): string | undefined => fields.find((item) => item.label === label)?.value;

describe("观测条目详情（N1）", () => {
  test("控制台：给的是**完整来源**，不再是概览里的文件名", () => {
    const fields = consoleFields(consoleEntry());
    assert.equal(fieldOf(fields, "级别"), "error");
    assert.equal(fieldOf(fields, "消息"), "夹具：这是一条脚本报错");
    assert.equal(fieldOf(fields, "来源"), "http://127.0.0.1:8123/");
    assert.equal(fieldOf(fields, "行"), "71");
  });

  test("控制台：没有来源与行号时不留下空行", () => {
    const fields = consoleFields(consoleEntry({ source: "", line: 0 }));
    assert.deepEqual(
      fields.map((item) => item.label),
      ["级别", "消息"],
    );
  });

  test("网络：拿到响应时给状态码，不给「错误」这一行", () => {
    const fields = networkFields(networkEntry());
    assert.equal(fieldOf(fields, "方法"), "GET");
    assert.equal(fieldOf(fields, "状态码"), "404");
    assert.equal(fieldOf(fields, "类型"), "fetch");
    assert.equal(fieldOf(fields, "URL"), "http://127.0.0.1:8123/api/missing");
    assert.equal(fieldOf(fields, "错误"), undefined);
  });

  test("网络：请求失败时给错误、不留下空的「状态码」", () => {
    const fields = networkFields(
      networkEntry({ statusCode: undefined, error: "net::ERR_CONNECTION_REFUSED" }),
    );
    assert.equal(fieldOf(fields, "错误"), "net::ERR_CONNECTION_REFUSED");
    assert.equal(fieldOf(fields, "状态码"), undefined);
  });

  test("下载：绝对路径 + 体积沿用既有格式化口径", () => {
    const entry = downloadEntry();
    const fields = downloadFields(entry);
    assert.equal(fieldOf(fields, "文件"), "1-colt-payload.txt");
    assert.equal(fieldOf(fields, "路径"), entry.path);
    assert.equal(fieldOf(fields, "大小"), "2.0 KB");
    assert.equal(fieldOf(fields, "状态"), "completed");
    assert.equal(fieldOf(fields, "备注"), undefined);
  });

  test("下载：未完成时备注跟着出现，0 字节也要给一行", () => {
    const fields = downloadFields(downloadEntry({ state: "cancelled", note: "体积超限", bytes: 0 }));
    assert.equal(fieldOf(fields, "状态"), "cancelled");
    assert.equal(fieldOf(fields, "备注"), "体积超限");
    assert.equal(fieldOf(fields, "大小"), "0 B");
  });

  test("文本化就是「标签：值」多行，顺序与字段一致（粘给模型直接用）", () => {
    const fields = networkFields(networkEntry());
    assert.deepEqual(
      observeCopyText(fields).split("\n"),
      fields.map((item) => `${item.label}：${item.value}`),
    );
    assert.match(observeCopyText(fields), /^方法：GET\n/);
  });

  test("行签名跟着内容走、不跟下标走（轮询会追加 / 裁掉条目）", () => {
    assert.equal(consoleRowKey(consoleEntry()), consoleRowKey(consoleEntry()));
    // 同一批下载里同名不同路径的两条必须能分别展开
    assert.notEqual(
      downloadRowKey(downloadEntry()),
      downloadRowKey(downloadEntry({ path: "C:\\other\\1-colt-payload.txt" })),
    );
    assert.notEqual(networkRowKey(networkEntry()), networkRowKey(networkEntry({ statusCode: 500 })));
  });

  test("签名带页签前缀，不同页签的同内容行不会撞键", () => {
    assert.ok(consoleRowKey(consoleEntry()).startsWith("console:"));
    assert.ok(networkRowKey(networkEntry()).startsWith("network:"));
    assert.ok(downloadRowKey(downloadEntry()).startsWith("downloads:"));
  });
});
