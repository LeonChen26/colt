/**
 * 渲染层纯函数测试：ANSI 解析、diff 行分类、参数格式化、⑦-G 的改动清单、⑥ 运行状态判定、
 * ⑦-H 的「统计」聚合、N1 的观测条目详情。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import hljs from "highlight.js/lib/common";
import { parseAnsi } from "../src/renderer/src/lib/ansi.ts";
import { classifyDiffLine } from "../src/renderer/src/lib/diff.ts";
import {
  formatAgo,
  formatArgs,
  formatSessionStamp,
  matchChangeByPath,
  runStateOf,
  samePath,
} from "../src/renderer/src/lib/format.ts";
import { buildChangeList, isProjectRelative } from "../src/renderer/src/lib/change-list.ts";
import {
  LANG_BY_EXT,
  LANG_BY_NAME,
  detectLanguage,
} from "../src/renderer/src/lib/code-lang.ts";
import {
  UNKNOWN_MODEL,
  buildSessionStats,
  formatTokenCount,
  formatToolDuration,
  toolCallSummary,
} from "../src/renderer/src/lib/session-stats.ts";
import {
  parseSlashCommand,
  resolveSkillCommand,
  slashCandidates,
} from "../src/renderer/src/lib/slash-command.ts";
import {
  consoleFields,
  consoleRowKey,
  downloadFields,
  downloadRowKey,
  networkFields,
  networkRowKey,
  observeCopyText,
} from "../src/renderer/src/lib/observe-detail.ts";
import {
  afterLater,
  belowCount,
  chunkSize,
  earlierStart,
  FOLD_CHUNK,
  FOLLOW_BOTTOM,
  hiddenCount,
  jumpHead,
  laterStart,
  WINDOW_CHUNK,
  windowEnd,
  windowStart,
} from "../src/renderer/src/lib/message-window.ts";
import {
  describeSteps,
  groupTurns,
  summarizeSteps,
  turnOfMessage,
} from "../src/renderer/src/lib/turn-groups.ts";
import {
  LABEL_MAX,
  labelOf,
  outlineOf,
  searchHistory,
  turnAt,
} from "../src/renderer/src/lib/session-outline.ts";
import type { ViewFileChange, ViewMessage } from "@shared/worker-protocol";
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

  test("bold-off(22) 解除加粗，不残留到后续输出", () => {
    // npm 等大量用「1m…22m」包步骤名；不处理 22 会让第一次加粗后的输出全部残留粗体
    const spans = parseAnsi("\u001B[1mbold\u001B[22mplain");
    assert.equal(spans[0]?.className, "font-bold");
    assert.equal(spans[1]?.text, "plain");
    assert.equal(spans[1]?.className, "");
  });

  test("默认前景色(39) 清除颜色", () => {
    const spans = parseAnsi("\u001B[31mred\u001B[39mplain");
    assert.equal(spans[0]?.className, "text-red-400");
    assert.equal(spans[1]?.className, "");
  });

  test("非 SGR 序列（光标控制 / OSC）被剥离，不漏成可见乱码", () => {
    const spans = parseAnsi("\u001B[2K\u001B[1Gloading\u001B]0;title\u0007done");
    assert.deepEqual(spans, [
      { text: "loading", className: "" },
      { text: "done", className: "" },
    ]);
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

  test("hunk 内的 --- / +++ 是被删除/新增的正文行，不是文件头", () => {
    // 删掉 markdown 的 --- 分隔线、SQL 的 -- 注释时，patch 行以 --- 开头；
    // 按 meta 着灰会让用户以为那行没被删
    assert.equal(classifyDiffLine("--- 删掉的分隔线", true), "remove");
    assert.equal(classifyDiffLine("+++ 追加的正文", true), "add");
    assert.equal(classifyDiffLine("--- a/file.ts", false), "meta");
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

/**
 * 造一条改动记录。名字统一用小写，避免 localeCompare 在大小写上产生环境差异。
 *
 * `net` 默认**不给**（null = 没有基线、净值算不出）——手写的记录本来就不知道基线是什么，
 * 要测净值的用例必须显式给出来，免得「默认等于逐次相加」这种想当然混进断言。
 */
const change = (
  path: string,
  options: {
    at?: number;
    kind?: "write" | "edit";
    added?: number;
    removed?: number;
    net?: { added: number; removed: number } | null;
  } = {},
): ViewFileChange => ({
  id: `${path}@${options.at ?? 0}`,
  path,
  kind: options.kind ?? "edit",
  patch: null,
  addedLines: options.added ?? 1,
  removedLines: options.removed ?? 0,
  timestamp: options.at ?? 0,
  netAddedLines: options.net?.added ?? null,
  netRemovedLines: options.net?.removed ?? null,
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

  test("同一文件的数字取**最新那条的净值**，不是历史逐次相加", () => {
    const list = buildChangeList([
      // 先加了 3 删了 2，随后又改了一次：净值只认最后那一行（主进程每次落库都重算）
      change("a.ts", { at: 1, added: 3, removed: 2, net: { added: 3, removed: 2 } }),
      change("a.ts", { at: 2, added: 4, removed: 1, net: { added: 5, removed: 1 } }),
    ]);
    const file = list.groups[0]?.files[0];
    assert.equal(file?.netAddedLines, 5);
    assert.equal(file?.netRemovedLines, 1);
    assert.equal(list.netAddedLines, 5);
    assert.equal(list.netRemovedLines, 1);
    // 逐次的那两对数字仍在历史行里（`×N` 展开后逐条显示）
    assert.deepEqual(
      file?.history.map((rev) => [rev.addedLines, rev.removedLines]),
      [
        [4, 1],
        [3, 2],
      ],
    );
  });

  test("净值 0（改完又退回原样）仍算一条改动，只是不产生行数", () => {
    const list = buildChangeList([
      change("a.ts", { at: 1, added: 10, removed: 0, net: { added: 10, removed: 0 } }),
      change("a.ts", { at: 2, added: 0, removed: 10, net: { added: 0, removed: 0 } }),
    ]);
    assert.equal(list.groups[0]?.files[0]?.netAddedLines, 0);
    assert.equal(list.groups[0]?.files[0]?.netRemovedLines, 0);
    assert.equal(list.places, 2);
    assert.equal(list.fileCount, 1);
    assert.equal(list.netAddedLines, 0);
    assert.equal(list.netRemovedLines, 0);
    assert.equal(list.netUnknown, 0, "净值 0 是**算出来的结论**，不是「算不出」");
  });

  test("净值算不出的文件不计入总额，并如实计数（不能让它们静默消失）", () => {
    const list = buildChangeList([
      change("known.ts", { at: 1, net: { added: 4, removed: 2 } }),
      change("unknown.ts", { at: 2 }),
      change("also-unknown.ts", { at: 3 }),
    ]);
    assert.equal(list.netAddedLines, 4);
    assert.equal(list.netRemovedLines, 2);
    assert.equal(list.netUnknown, 2);
    assert.equal(list.fileCount, 3);
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

describe("formatSessionStamp", () => {
  /** 用本地时间构造，避免用例结果随机器时区变化 */
  const at = (y: number, mo: number, d: number, h = 0, mi = 0): number =>
    new Date(y, mo - 1, d, h, mi).getTime();

  test("同一天 → HH:mm（补零）", () => {
    assert.equal(formatSessionStamp(at(2026, 9, 17, 14, 5), at(2026, 9, 17, 23, 59)), "14:05");
    assert.equal(formatSessionStamp(at(2026, 9, 17, 9, 30), at(2026, 9, 17, 0, 1)), "09:30");
  });

  test("昨天 → 「昨天」", () => {
    assert.equal(formatSessionStamp(at(2026, 9, 16, 8, 0), at(2026, 9, 17, 10, 0)), "昨天");
  });

  test("跨月边界也算「昨天」", () => {
    // 2026 不是闰年，2 月只有 28 天
    assert.equal(formatSessionStamp(at(2026, 2, 28, 23, 0), at(2026, 3, 1, 0, 30)), "昨天");
  });

  test("跨年边界也算「昨天」", () => {
    assert.equal(formatSessionStamp(at(2025, 12, 31, 22, 0), at(2026, 1, 1, 8, 0)), "昨天");
  });

  test("更早 → M月D日", () => {
    assert.equal(formatSessionStamp(at(2026, 9, 15, 8, 0), at(2026, 9, 17, 10, 0)), "9月15日");
    assert.equal(formatSessionStamp(at(2026, 1, 3), at(2026, 9, 17)), "1月3日");
  });

  test("只差一天但已跨日（23:59 → 次日 00:01）不算同一天", () => {
    assert.equal(formatSessionStamp(at(2026, 9, 16, 23, 59), at(2026, 9, 17, 0, 1)), "昨天");
  });

  test("已知取舍：更早的时间戳不带年份（侧栏宽度有限）", () => {
    // 这不是 bug，是有意的取舍——写出来是为了让它成为**约定**而不是「碰巧如此」，
    // 将来真要加年份时，这条用例会红，提醒改动者去核对侧栏是否放得下。
    assert.equal(formatSessionStamp(at(2024, 5, 6), at(2026, 9, 17)), "5月6日");
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

  test("裸后缀不算命中——配对真数据不能靠「前缀截断」的巧合", () => {
    // 判据与 matchChangeByPath 保持一致（同一行 hover 在两处高亮同一个文件）：
    // 命中必须落在 / 边界上，否则 `src/a.ts` 会与 `rc/a.ts` 互相误配。
    assert.equal(samePath("rc/a.ts", "src/a.ts"), false);
  });
});

/** 造一条改动记录：只写用例关心的字段（净值这里用不到，一律「算不出」） */
const changeOf = (path: string, addedLines = 1, removedLines = 0): ViewFileChange => ({
  id: `chg-${path}#${addedLines}/${removedLines}`,
  path,
  kind: "edit",
  patch: null,
  addedLines,
  removedLines,
  timestamp: 0,
  netAddedLines: null,
  netRemovedLines: null,
});

describe("matchChangeByPath", () => {
  test("精确相等优先于后缀：同 basename 不同目录不被误抢", () => {
    const changes = [changeOf("README.md", 5), changeOf("docs/README.md", 9)];
    // 旧实现单趟倒序后缀匹配：工具卡 docs/README.md 会先撞上根目录的 README.md
    //（"docs/README.md".endsWith("/README.md") === true），把别的文件的 diff 配到这张卡上
    assert.equal(matchChangeByPath(changes, "docs/README.md")?.addedLines, 9);
    assert.equal(matchChangeByPath(changes, "README.md")?.addedLines, 5);
  });

  test("绝对路径按 / 边界后缀兜底", () => {
    const changes = [changeOf("src/lib/util.ts", 3, 1)];
    assert.equal(matchChangeByPath(changes, "E:\\proj\\src\\lib\\util.ts")?.path, "src/lib/util.ts");
  });

  test("多个后缀命中取最长（更具体）的那条", () => {
    const changes = [changeOf("README.md", 5), changeOf("docs/README.md", 9)];
    assert.equal(matchChangeByPath(changes, "C:\\repo\\docs\\README.md")?.addedLines, 9);
  });

  test("裸后缀不算命中（前缀截断的巧合不配对）", () => {
    const changes = [changeOf("a.ts", 1)];
    assert.equal(matchChangeByPath(changes, "src/wa.ts"), undefined);
  });

  test("同路径多条记录取最新", () => {
    const changes = [changeOf("src/a.ts", 1), changeOf("src/a.ts", 7)];
    assert.equal(matchChangeByPath(changes, "src/a.ts")?.addedLines, 7);
  });

  test("非字符串入参返回 undefined", () => {
    assert.equal(matchChangeByPath([], undefined), undefined);
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

  test("999.95K 起四舍五入会进位成 1000K：升到 M 档", () => {
    assert.equal(formatTokenCount(999_949), "999.9K");
    assert.equal(formatTokenCount(999_950), "1M");
    assert.equal(formatTokenCount(999_999), "1M");
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

/** 输入框的斜杠命令识别（`/compact` / `/memory-tidy` / `/skill`）。判错方向的代价不对称：漏认只是「原样发出去」。 */
describe("parseSlashCommand", () => {
  test("认下 /compact 及其前后空白与大小写", () => {
    assert.deepEqual(parseSlashCommand("/compact"), { name: "compact" });
    assert.deepEqual(parseSlashCommand("  /compact  "), { name: "compact" });
    assert.deepEqual(parseSlashCommand("/compact\n"), { name: "compact" });
    assert.deepEqual(parseSlashCommand("/COMPACT"), { name: "compact" });
    assert.deepEqual(parseSlashCommand("/Compact"), { name: "compact" });
  });

  test("零参数命令必须独占整条输入：后面带正文不算命令", () => {
    // 否则「用 /compact 手动压缩」这句会被当成命令吞掉，用户根本发不出去
    assert.equal(parseSlashCommand("/compact 一下"), null);
    assert.equal(parseSlashCommand("/compact please"), null);
  });

  test("认下 /memory-tidy（大小写同款），带正文同样不算命令", () => {
    assert.deepEqual(parseSlashCommand("/memory-tidy"), { name: "memory-tidy" });
    assert.deepEqual(parseSlashCommand("  /memory-tidy\n"), { name: "memory-tidy" });
    assert.deepEqual(parseSlashCommand("/Memory-Tidy"), { name: "memory-tidy" });
    // 连字符命令字同样整段相等才算：/memory-tidyfoo 不是命令
    assert.equal(parseSlashCommand("/memory-tidyfoo"), null);
    assert.equal(parseSlashCommand("/memory-tidy 顺便删掉过时的"), null);
  });

  test("/skill 带参数：名字与额外指示分开，内部空白原样保留", () => {
    assert.deepEqual(parseSlashCommand("/skill pdf"), {
      name: "skill",
      skillName: "pdf",
      instructions: undefined,
    });
    assert.deepEqual(parseSlashCommand("/skill pdf 帮我看第 3 页"), {
      name: "skill",
      skillName: "pdf",
      instructions: "帮我看第 3 页",
    });
    assert.deepEqual(parseSlashCommand("  /skill   pdf   多  空格  "), {
      name: "skill",
      skillName: "pdf",
      instructions: "多  空格",
    });
  });

  test("/skill 的两道阀：命令字整段相等 + 必须真有一个名字", () => {
    // 命令字不分大小写；**技能名原样传**——内核按精确名查找，替用户转小写等于偷偷改输入，
    // 而打错大小写时那条报错会直接给出正确写法（自纠比猜意图稳）。
    assert.deepEqual(parseSlashCommand("/SKILL pdf"), {
      name: "skill",
      skillName: "pdf",
      instructions: undefined,
    });
    assert.deepEqual(parseSlashCommand("/skill PDF"), {
      name: "skill",
      skillName: "PDF",
      instructions: undefined,
    });
    // 裸命令没有名字 → 放行（宁可原样发出去，也不猜）
    assert.equal(parseSlashCommand("/skill"), null);
    assert.equal(parseSlashCommand("/skill   "), null);
    // 命令字必须**整段**等于 skill：别把 /skills / /skillfoo 认成命令
    assert.equal(parseSlashCommand("/skills"), null);
    assert.equal(parseSlashCommand("/skillfoo"), null);
    assert.equal(parseSlashCommand("/skill/extra"), null);
  });

  test("未知命令一律回落成普通提问（宁可原样发出，不静默丢失）", () => {
    assert.equal(parseSlashCommand("/help"), null);
    assert.equal(parseSlashCommand("/clear"), null);
    // 以 / 开头的正文也必须放行：贴路径、贴 POSIX 绝对路径都是常见输入
    assert.equal(parseSlashCommand("/usr/local/bin/node"), null);
    assert.equal(parseSlashCommand("/compact/extra"), null);
  });

  test("非命令输入（空串 / 裸斜杠 / 普通文本）返回 null", () => {
    assert.equal(parseSlashCommand(""), null);
    assert.equal(parseSlashCommand("   "), null);
    assert.equal(parseSlashCommand("/"), null);
    assert.equal(parseSlashCommand("compact"), null);
    assert.equal(parseSlashCommand("帮我看看 compact 的实现"), null);
  });
});

describe("resolveSkillCommand（/skill 是发出去还是就地拦下）", () => {
  test("名字在清单里 → 发出去", () => {
    assert.deepEqual(resolveSkillCommand("pdf", ["pdf", "code-review"]), { kind: "invoke" });
  });

  test("名字不在清单里 → 拦下，并把**可用名**报出来（那是用户唯一知道正确写法的地方）", () => {
    const dispatch = resolveSkillCommand("pf", ["pdf", "code-review"]);
    assert.equal(dispatch.kind, "reject");
    assert.ok(dispatch.kind === "reject");
    assert.ok(dispatch.message.includes("技能「pf」不存在"), dispatch.message);
    assert.ok(dispatch.message.includes("pdf、code-review"), dispatch.message);
  });

  test("清单是空数组（**知道**确实一个都没装）→ 拦下，并说清技能该放哪", () => {
    const dispatch = resolveSkillCommand("pdf", []);
    assert.equal(dispatch.kind, "reject");
    assert.ok(dispatch.kind === "reject");
    assert.ok(dispatch.message.includes(".agents/skills"), dispatch.message);
  });

  test("清单**不知道**（拿不到视图）→ 不拦，照常发（凭不知道的清单拒绝 = 把有效调用误判成失败）", () => {
    assert.deepEqual(resolveSkillCommand("pdf", undefined), { kind: "invoke" });
    // 这条是本函数的要害：`undefined`（不知道）与 `[]`（知道且没有）**必须**分开，
    // 否则会话刚打开、worker 还没上报时，一个有效的技能名会被本地拒掉。
    assert.notDeepEqual(resolveSkillCommand("pdf", undefined), resolveSkillCommand("pdf", []));
  });

  test("名字按**精确**匹配（内核就是这么找的），大小写不同算不存在", () => {
    assert.deepEqual(resolveSkillCommand("pdf", ["pdf"]), { kind: "invoke" });
    assert.equal(resolveSkillCommand("PDF", ["pdf"]).kind, "reject");
  });
});

describe("slashCandidates（敲 / 之后浮层列什么）", () => {
  const skills = ["pdf", "code-review"];
  /** 只取命令文本，断言更直观；`list` 省略时用上面的 `skills` */
  const texts = (text: string, list: readonly string[] = skills): string[] =>
    slashCandidates(text, list).map((item) => item.text);
  /**
   * 「清单**不知道**」单独走一个入口：**不能**在这里给形参写默认值再传 `undefined`——
   * 默认参数会把 `undefined` 一并换成 `skills`，那条用例就悄悄变成了在测别的东西。
   */
  const unknownTexts = (text: string): string[] =>
    slashCandidates(text, undefined).map((item) => item.text);

  test("裸 `/` → 内置命令都列（/compact + /memory-tidy + 每个技能一项）", () => {
    assert.deepEqual(texts("/"), [
      "/compact",
      "/memory-tidy",
      "/skill pdf",
      "/skill code-review",
    ]);
  });

  test("按前缀过滤：`/c` 只剩 /compact，`/m` 只剩 /memory-tidy，`/s` 只剩技能", () => {
    assert.deepEqual(texts("/c"), ["/compact"]);
    assert.deepEqual(texts("/m"), ["/memory-tidy"]);
    assert.deepEqual(texts("/s"), ["/skill pdf", "/skill code-review"]);
    // 命令字之后还能继续过滤技能名（用户记得开头几个字母就够了）
    assert.deepEqual(texts("/skill co"), ["/skill code-review"]);
  });

  test("`/skill ` （带空格还没写名字）也列 —— 这时最需要提示", () => {
    assert.deepEqual(texts("/skill "), ["/skill pdf", "/skill code-review"]);
  });

  test("**整条命令已敲全 → 一条都不列**（否则那一下回车会被「选中」吃掉）", () => {
    // 这条是本函数的要害：少了它，用户敲对 `/compact` 之后按回车不会发送，
    // 而是被浮层「选中」重写一遍，得先按 Esc 才发得出去。
    assert.deepEqual(texts("/compact"), []);
    assert.deepEqual(texts("/memory-tidy"), []);
    assert.deepEqual(texts("/skill pdf"), []);
    // 大小写不同也算「敲全了」
    assert.deepEqual(texts("/COMPACT"), []);
  });

  test("以 / 开头的普通文本（路径）一个都匹配不上 → 浮层不出现", () => {
    assert.deepEqual(texts("/usr/local/bin/node"), []);
    assert.deepEqual(texts("/xz"), []);
  });

  test("带正文的 `/compact 一下` 匹配不上（前缀比候选长）→ 照常可发", () => {
    assert.deepEqual(texts("/compact 一下"), []);
  });

  test("不以 / 开头（含空串）→ 空列表", () => {
    assert.deepEqual(texts(""), []);
    assert.deepEqual(texts("帮我看看"), []);
  });

  test("清单**不知道**（undefined）→ 只列内置命令，不猜技能名", () => {
    assert.deepEqual(unknownTexts("/"), ["/compact", "/memory-tidy"]);
    // 「不知道」不等于「没有」：这里只是不列，不是报错，也不是把 /skill 也藏掉
    assert.deepEqual(unknownTexts("/s"), []);
  });

  test("清单为空数组 → 同样只列内置命令（一个技能都没装）", () => {
    assert.deepEqual(texts("/", []), ["/compact", "/memory-tidy"]);
  });

  test("技能候选的 insert 带**尾随空格**（好接着写额外指示），命令字大小写不敏感但名字保留原样", () => {
    const skillItem = slashCandidates("/s", ["PDF"])[0];
    assert.ok(skillItem);
    assert.equal(skillItem.text, "/skill PDF");
    assert.equal(skillItem.insert, "/skill PDF ");
    // 匹配不区分大小写（与 parseSlashCommand 对命令字的态度一致）
    assert.deepEqual(texts("/SKILL"), ["/skill pdf", "/skill code-review"]);
  });
});

describe("detectLanguage（文件预览「按格式渲染」的判据）", () => {
  test("常见扩展名 → highlight.js 语言名", () => {
    assert.equal(detectLanguage("src/main/index.ts"), "typescript");
    assert.equal(detectLanguage("src/renderer/src/App.tsx"), "typescript");
    assert.equal(detectLanguage("scripts/fixture-server.mjs"), "javascript");
    assert.equal(detectLanguage("package.json"), "json");
    assert.equal(detectLanguage("src/renderer/src/styles.css"), "css");
    assert.equal(detectLanguage("src/renderer/index.html"), "xml");
    assert.equal(detectLanguage("docs/x.graphql"), "graphql");
    assert.equal(detectLanguage("scripts/build.sh"), "bash");
    assert.equal(detectLanguage("tools/gen.py"), "python");
    assert.equal(detectLanguage("rust/src/main.rs"), "rust");
  });

  test("大小写、盘符、反斜杠都同解（入参可能是绝对路径）", () => {
    assert.equal(detectLanguage("E:\\code\\colt\\src\\a.TS"), "typescript");
    assert.equal(detectLanguage("E:/code/colt/src/a.ts"), "typescript");
    assert.equal(detectLanguage("src/a.ts"), "typescript");
    assert.equal(detectLanguage("C:\\repo\\Makefile"), "makefile");
  });

  test("无扩展名文件按整个文件名认；其它认不出的返回 null", () => {
    assert.equal(detectLanguage("Makefile"), "makefile");
    assert.equal(detectLanguage("src/GNUmakefile"), "makefile");
    assert.equal(detectLanguage("LICENSE"), null);
    assert.equal(detectLanguage("notes.log"), null);
    assert.equal(detectLanguage("data.csv"), null);
  });

  test("隐藏文件不把整名当扩展名（`.gitignore` 的扩展名是空串）", () => {
    assert.equal(detectLanguage(".gitignore"), null);
    assert.equal(detectLanguage(".editorconfig"), null);
  });

  test("空路径 / 目录形态不炸，也不误判", () => {
    assert.equal(detectLanguage(""), null);
    assert.equal(detectLanguage("src/"), null);
  });

  test("Markdown 不在表里：`.md` 由上游直接交给 Markdown 渲染器", () => {
    // 若这里也给出 markdown，CodeView 会把 .md 当代码着色，与上游分流打架
    assert.equal(detectLanguage("docs/UI-REGIONS.md"), null);
    assert.equal(detectLanguage("README.markdown"), null);
  });

  test("表里的语言名必须都是 common 包注册过的，否则识别等于白识别", () => {
    const names = new Set([...Object.values(LANG_BY_EXT), ...Object.values(LANG_BY_NAME)]);
    for (const name of names) {
      assert.notEqual(hljs.getLanguage(name), undefined, `${name} 不在 highlight.js common 包里`);
    }
  });

  test("CodeView 依赖的 highlight 调用方式成立（返回带 hljs- 类名的 HTML）", () => {
    // 钉住的是「调用方式」而不是某段 HTML：一旦 highlight.js 改了签名（升大版本），
    // CodeView 的 catch 会把失败吞成「这个文件本来就没颜色」，界面上看不出来。
    const { value } = hljs.highlight('{ "name": "colt" }', {
      language: "json",
      ignoreIllegals: true,
    });
    assert.match(value, /class="hljs-/);
  });

  test("着色结果不含未转义的原样标签（内容全部来自文件，必须转义）", () => {
    const { value } = hljs.highlight("<script>alert(1)</script>", {
      language: "xml",
      ignoreIllegals: true,
    });
    assert.equal(value.includes("<script>"), false);
  });
});

describe("messageWindow（长会话只挂最近一段）", () => {
  /** 真实库里最长那个会话的可渲染条数（143 用户 + 2794 助手，见 `modes/perf.ts` 的说明） */
  const LONG = 2937;

  test("空会话与比窗口还短的会话：一条都不藏", () => {
    assert.equal(windowStart(0, FOLLOW_BOTTOM), 0);
    assert.equal(windowStart(31, FOLLOW_BOTTOM), 0);
    assert.equal(windowStart(WINDOW_CHUNK, FOLLOW_BOTTOM), 0);
    assert.equal(hiddenCount(31, FOLLOW_BOTTOM), 0);
  });

  test("长会话「跟随底部」：首屏只挂最新一个窗口", () => {
    assert.equal(windowStart(LONG, FOLLOW_BOTTOM), LONG - WINDOW_CHUNK);
    assert.equal(hiddenCount(LONG, FOLLOW_BOTTOM), LONG - WINDOW_CHUNK);
  });

  test("显式展开后不再跟随：追加新消息只把切片撑长，不把用户正读的那几行挤掉", () => {
    const head = earlierStart(LONG, FOLLOW_BOTTOM);
    assert.equal(windowStart(LONG, head), LONG - 2 * WINDOW_CHUNK);
    // 之后又来了 100 条新消息：起点不动 → 挂出来的内容只增不减
    assert.equal(windowStart(LONG + 100, head), LONG - 2 * WINDOW_CHUNK);
    // 对照：「跟随底部」时窗口会跟着最新消息挪走——这正是用户上翻时要先把窗口钉住的原因
    assert.equal(windowStart(LONG + 100, FOLLOW_BOTTOM), LONG + 100 - WINDOW_CHUNK);
  });

  test("展开到底：起点为 0，再展开也不会变成负数", () => {
    assert.equal(windowStart(LONG, 0), 0);
    assert.equal(earlierStart(LONG, 0), 0);
    assert.equal(earlierStart(20, 5), 0);
    // 比一个窗口还短时没有「更早的」可补：起点被钳到 0，粒度也就是 0
    assert.equal(chunkSize(20, 5), 0);
  });

  test("换会话的中间态：旧会话的起点号在新会话里必须被拉回来（不能 slice 出空列表）", () => {
    // 少了 min(…, total − 窗口) 那道钳制时，这几行的起点都会是 2887，
    // `slice(2887)` 一个条目都不剩——界面上就是一片空白。判据取**看得见的条数**，
    // 因为它才是「有没有东西可看」这件事本身。
    assert.equal(31 - windowStart(31, 2887), 31);
    assert.equal(60 - windowStart(60, 2887), WINDOW_CHUNK);
    assert.equal(LONG - windowStart(LONG, 2887), WINDOW_CHUNK);
  });

  test("不变式：藏起来的条数不为负、不多于「总数 − 窗口」，且留下的够填满一个窗口", () => {
    for (const total of [0, 1, 49, 50, 51, 137, LONG]) {
      for (const head of [FOLLOW_BOTTOM, 0, 1, 49, 50, 137, 2887, 99999]) {
        const start = windowStart(total, head);
        assert.ok(start >= 0, `windowStart(${total}, ${head}) = ${start} 为负`);
        assert.ok(
          start <= Math.max(0, total - WINDOW_CHUNK),
          `windowStart(${total}, ${head}) = ${start} 藏得比允许的还多`,
        );
        assert.ok(
          total - start >= Math.min(WINDOW_CHUNK, total),
          `windowStart(${total}, ${head}) 之后只剩 ${total - start} 条，填不满一个窗口`,
        );
      }
    }
  });

  test("展开粒度与界面上的数字同源（各算一遍必然漂）", () => {
    assert.equal(chunkSize(LONG, FOLLOW_BOTTOM), WINDOW_CHUNK);
    assert.equal(chunkSize(LONG, 100), WINDOW_CHUNK);
    assert.equal(chunkSize(30, FOLLOW_BOTTOM), 0);
  });
});

describe("messageWindow 的单位（折叠时按「轮」计）", () => {
  /** 冒烟夹具的节奏：每 14 条消息一轮。短的这档正好用来看清「50 条」和「50 轮」差多少 */
  const TURNS = 58;
  const LONG_TURNS = 2937;

  test("换单位就是换 chunk：同一套算术，按轮数时一个窗口宽 50 轮而不是 50 条", () => {
    // 按条：长会话首屏 50 条 ≈ 3.5 轮——这正是「折叠后只看到三四轮」的来源
    assert.equal(windowStart(14 * TURNS, FOLLOW_BOTTOM, WINDOW_CHUNK), 14 * TURNS - WINDOW_CHUNK);
    // 按轮：起点落在倒数第 50 轮上，一共挂 50 轮
    assert.equal(windowStart(TURNS, FOLLOW_BOTTOM, FOLD_CHUNK), TURNS - FOLD_CHUNK);
    assert.equal(windowStart(LONG_TURNS, FOLLOW_BOTTOM, FOLD_CHUNK), LONG_TURNS - FOLD_CHUNK);
  });

  test("按轮展开：够一段就补满一段，不够一段就按剩下的补", () => {
    assert.equal(chunkSize(LONG_TURNS, FOLLOW_BOTTOM, FOLD_CHUNK), FOLD_CHUNK);
    // 58 轮的会话只藏了 8 轮：一次就补完，「还有」和粒度都是 8
    assert.equal(chunkSize(TURNS, FOLLOW_BOTTOM, FOLD_CHUNK), TURNS - FOLD_CHUNK);
    assert.equal(earlierStart(TURNS, FOLLOW_BOTTOM, FOLD_CHUNK), 0);
    assert.equal(earlierStart(TURNS, 0, FOLD_CHUNK), 0);
  });

  test("按轮的浮动段：跳到最前一轮只挂 50 轮，下面还剩 8 轮", () => {
    const head = jumpHead(0);
    assert.equal(windowStart(TURNS, head, FOLD_CHUNK), 0);
    assert.equal(windowEnd(TURNS, head, true, FOLD_CHUNK), FOLD_CHUNK);
    assert.equal(belowCount(TURNS, head, true, FOLD_CHUNK), TURNS - FOLD_CHUNK);
  });

  test("按轮翻到底同样交回「跟随底部」（否则新消息会落在窗口外）", () => {
    assert.deepEqual(
      afterLater(LONG_TURNS, windowStart(LONG_TURNS, FOLLOW_BOTTOM, FOLD_CHUNK), FOLD_CHUNK),
      { head: FOLLOW_BOTTOM, floating: false },
    );
    assert.deepEqual(afterLater(LONG_TURNS, 0, FOLD_CHUNK), { head: FOLD_CHUNK, floating: true });
  });

  test("轮数不到一个窗口时一条都不藏（短会话照旧零影响）", () => {
    assert.equal(windowStart(3, FOLLOW_BOTTOM, FOLD_CHUNK), 0);
    assert.equal(hiddenCount(3, FOLLOW_BOTTOM, FOLD_CHUNK), 0);
    assert.equal(windowEnd(3, FOLLOW_BOTTOM, true, FOLD_CHUNK), 3);
  });
});

describe("turnGroups（一轮 = 一条提问 + 它的最终回复）", () => {
  const user = (id: string, text = "问"): ViewMessage => ({
    id,
    role: "user",
    text,
    toolCalls: [],
  });
  const step = (id: string, tools: number, thought = false): ViewMessage => ({
    id,
    role: "assistant",
    text: "",
    thought: thought ? "先看清结构再动手" : undefined,
    toolCalls: Array.from({ length: tools }, (_, index) => ({
      id: `${id}-c${index}`,
      name: "read",
      args: "{}",
    })),
  });
  const reply = (id: string, text = "答"): ViewMessage => ({
    id,
    role: "assistant",
    text,
    toolCalls: [],
  });

  test("一轮里多条助手消息：最后一条是最终回复，其余都是过程", () => {
    const turns = groupTurns([user("u1"), step("a1", 2), step("a2", 1), reply("a3")]);
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.user?.id, "u1");
    assert.deepEqual(
      turns[0]?.steps.map((message) => message.id),
      ["a1", "a2"],
    );
    assert.equal(turns[0]?.final?.id, "a3");
  });

  test("「最后一条」是靠顶替维持的：连来两条助手，前一条会降级为过程", () => {
    // 少了这句顶替，一轮里就会出现两条「最终回复」——收起来时会连正文一起藏掉
    const turns = groupTurns([user("u1"), reply("a1"), reply("a2")]);
    assert.deepEqual(
      turns[0]?.steps.map((message) => message.id),
      ["a1"],
    );
    assert.equal(turns[0]?.final?.id, "a2");
  });

  test("一轮只有一条助手消息：没有过程可收，整轮就是问答", () => {
    const turns = groupTurns([user("u1"), reply("a1")]);
    assert.deepEqual(turns[0]?.steps, []);
    assert.equal(turns[0]?.final?.id, "a1");
  });

  test("连着两条提问：各成一「轮」，第一轮没有助手消息也不吞掉提问", () => {
    const turns = groupTurns([user("u1"), user("u2"), reply("a1")]);
    assert.equal(turns.length, 2);
    assert.equal(turns[0]?.user?.id, "u1");
    assert.equal(turns[0]?.final, null);
    assert.equal(turns[1]?.user?.id, "u2");
    assert.equal(turns[1]?.final?.id, "a1");
  });

  test("会话以助手消息开头（恢复出来的转录）：照样成轮，不整段丢掉", () => {
    const turns = groupTurns([reply("a1"), user("u1"), reply("a2")]);
    assert.equal(turns.length, 2);
    assert.equal(turns[0]?.user, null);
    assert.equal(turns[0]?.final?.id, "a1");
    assert.equal(turns[1]?.user?.id, "u1");
    assert.equal(turns[1]?.final?.id, "a2");
  });

  test("other 不参与成轮（它本来就不成条）", () => {
    const other: ViewMessage = { id: "o1", role: "other", text: "结构节点", toolCalls: [] };
    const turns = groupTurns([user("u1"), other, reply("a1"), other]);
    assert.equal(turns.length, 1);
    assert.deepEqual(turns[0]?.steps, []);
    assert.equal(turns[0]?.final?.id, "a1");
  });

  test("turnOfMessage：与 groupTurns 的轮序逐条对齐（换窗口单位全靠它）", () => {
    const messages = [reply("a0"), user("u1"), step("a1", 1), reply("a2"), user("u2"), reply("a3")];
    // 先把「按 groupTurns 算出来是几轮」定下来，再看换算有没有跟它一致
    assert.equal(groupTurns(messages).length, 3);
    assert.deepEqual(
      messages.map((_, index) => turnOfMessage(messages, index)),
      [0, 1, 1, 1, 2, 2],
    );
  });

  test("turnOfMessage 的边界：`other` 归它所在的那一轮，越界钳到最近的轮", () => {
    const other: ViewMessage = { id: "o1", role: "other", text: "结构节点", toolCalls: [] };
    const messages = [user("u1"), other, reply("a1"), user("u2")];
    // `other` 不成轮，但换算要落在它**所在**的那一轮上——否则切模式时位置会偏一轮
    assert.deepEqual(
      messages.map((_, index) => turnOfMessage(messages, index)),
      [0, 0, 0, 1],
    );
    assert.equal(turnOfMessage(messages, -5), 0);
    assert.equal(turnOfMessage(messages, 99), 1);
    assert.equal(turnOfMessage([], 0), 0);
  });

  test("不变式：每条 user/assistant 都落在某一轮里，且顺序不变", () => {
    const all = [reply("a0"), user("u1"), step("a1", 1), reply("a2"), user("u2"), reply("a3")];
    const flat = groupTurns(all).flatMap((turn) => [
      ...(turn.user ? [turn.user] : []),
      ...turn.steps,
      ...(turn.final ? [turn.final] : []),
    ]);
    assert.deepEqual(
      flat.map((message) => message.id),
      all.map((message) => message.id),
    );
  });

  test("摘要只数**被收起来**的东西：工具按调用数、思考按步骤数", () => {
    // 一轮里一张卡可能带好几个调用，所以数的是 toolCalls 的总数，不是消息数
    assert.deepEqual(summarizeSteps([step("a1", 3, true), step("a2", 2), step("a3", 0, true)]), {
      toolCount: 5,
      thoughtCount: 2,
    });
  });

  test("摘要文案只报确实有的：没有的不提，都没有时说「过程」", () => {
    assert.equal(describeSteps({ toolCount: 0, thoughtCount: 0 }), "过程");
    assert.equal(describeSteps({ toolCount: 0, thoughtCount: 1 }), "已思考");
    assert.equal(describeSteps({ toolCount: 4, thoughtCount: 0 }), "4 个工具调用");
    assert.equal(describeSteps({ toolCount: 4, thoughtCount: 2 }), "已思考 · 4 个工具调用");
  });
});

describe("messageWindow 的浮动段（跳到某一轮去看）", () => {
  const TOTAL = 2937;

  test("不浮动时上沿就是末尾——「一直挂到末尾」正是另外两档的行为", () => {
    assert.equal(windowEnd(TOTAL, FOLLOW_BOTTOM, false), TOTAL);
    assert.equal(windowEnd(TOTAL, 100, false), TOTAL);
    assert.equal(belowCount(TOTAL, 100, false), 0);
  });

  test("浮动时只挂一段：跳到第 500 条不会把 500→末尾两千多条一起挂出来", () => {
    // 这是整个浮动档存在的全部理由——沿用「一直挂到末尾」就等于没做窗口
    const head = jumpHead(500);
    assert.equal(windowStart(TOTAL, head), 500);
    assert.equal(windowEnd(TOTAL, head, true) - windowStart(TOTAL, head), WINDOW_CHUNK);
    assert.equal(belowCount(TOTAL, head, true), TOTAL - 550);
  });

  test("跳到末尾附近：目标仍在窗口内，且不越界", () => {
    const target = TOTAL - 3;
    const head = jumpHead(target);
    const start = windowStart(TOTAL, head);
    const end = windowEnd(TOTAL, head, true);
    assert.ok(start <= target && target < end);
    assert.equal(end, TOTAL);
  });

  test("往前往后各翻一页都是一整段", () => {
    const head = jumpHead(500);
    assert.equal(earlierStart(TOTAL, head), 450);
    assert.equal(laterStart(TOTAL, head), 550);
  });

  test("往下翻到底就交回「跟随底部」：否则新消息会落在窗口外、界面不再更新", () => {
    assert.deepEqual(afterLater(TOTAL, windowStart(TOTAL, FOLLOW_BOTTOM)), {
      head: FOLLOW_BOTTOM,
      floating: false,
    });
    assert.deepEqual(afterLater(TOTAL, 500), { head: 550, floating: true });
  });

  test("jumpHead 钳住负下标：目录不会给负数，但别让越界悄悄传下去", () => {
    assert.equal(jumpHead(-5), 0);
    assert.equal(jumpHead(0), 0);
  });
});

describe("sessionOutline（会话目录与历史搜索）", () => {
  const user = (id: string, text: string): ViewMessage => ({ id, role: "user", text, toolCalls: [] });
  const bot = (id: string, text: string): ViewMessage => ({
    id,
    role: "assistant",
    text,
    toolCalls: [],
  });

  test("labelOf：取第一行非空、压平空白、超长截断到一个整行", () => {
    assert.equal(labelOf("\n\n  第一行\n第二行"), "第一行");
    assert.equal(labelOf("a   b\tc"), "a b c");
    const long = "字".repeat(LABEL_MAX + 40);
    assert.equal(labelOf(long).length, LABEL_MAX);
    assert.ok(labelOf(long).endsWith("…"));
    assert.equal(labelOf("   "), "");
  });

  test("目录只列提问、一条一轮，并记住**下标**（跳转靠它）", () => {
    const items = outlineOf([
      user("u1", "先看 README"),
      bot("a1", "好"),
      user("u2", "再改配置"),
    ]);
    assert.deepEqual(items, [
      { index: 0, id: "u1", label: "先看 README", turn: 1 },
      { index: 2, id: "u2", label: "再改配置", turn: 2 },
    ]);
  });

  test("只有图片、没有文字的提问也要占一行（否则它在目录上「不存在」）", () => {
    const items = outlineOf([user("u1", "")]);
    assert.equal(items.length, 1);
    assert.match(items[0]!.label, /只有图片/);
  });

  test("搜索：提问与回复都搜，返回下标、角色与上下文", () => {
    const hits = searchHistory([user("u1", "问"), bot("a1", "这里有 内存泄漏 的问题")], "内存");
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.index, 1);
    assert.equal(hits[0]!.role, "assistant");
    assert.ok(hits[0]!.snippet.includes("内存泄漏"));
  });

  test("搜索：空查询什么都不返回（而不是返回全部）", () => {
    assert.deepEqual(searchHistory([user("u1", "问")], "   "), []);
  });

  test("搜索：跨换行也能搜到（先压平空白再匹配）", () => {
    assert.equal(searchHistory([bot("a1", "第一段\n第二段结束")], "第一段 第二段").length, 1);
  });

  test("搜索：命中在开头/结尾时不加多余的省略号", () => {
    assert.equal(searchHistory([bot("a1", "开头就在这里")], "开头")[0]!.snippet, "开头就在这里");
  });

  test("搜索：other 不参与（它本来就不成条）", () => {
    const other: ViewMessage = { id: "o1", role: "other", text: "命中", toolCalls: [] };
    assert.deepEqual(searchHistory([other], "命中"), []);
  });
});

describe("turnAt（可见消息属于第几轮——点链的「当前点」靠它）", () => {
  const user = (id: string, text: string): ViewMessage => ({ id, role: "user", text, toolCalls: [] });
  const bot = (id: string, text: string): ViewMessage => ({
    id,
    role: "assistant",
    text,
    toolCalls: [],
  });
  // u1(0) a1(1) a2(2) | u2(3) a3(4) —— 两轮，回复都归各自的提问
  const messages = [user("u1", "一"), bot("a1", "一答"), bot("a2", "二答"), user("u2", "二"), bot("a3", "三答")];
  const items = outlineOf(messages);

  test("回复归它前面最近的那个提问（一轮从提问开始）", () => {
    assert.equal(turnAt(items, 0), 1); // 提问本身
    assert.equal(turnAt(items, 1), 1); // 第 1 轮的回复
    assert.equal(turnAt(items, 2), 1);
    assert.equal(turnAt(items, 3), 2); // 第 2 轮的提问
    assert.equal(turnAt(items, 4), 2);
  });

  test("下标落在第一条提问之前（开头有分支摘要之类）→ 钳到第 1 轮", () => {
    // 开头多一条不成条的消息，把提问整体往后推
    const shifted = [{ id: "s0", role: "other" as const, text: "", toolCalls: [] }, ...messages];
    const items2 = outlineOf(shifted);
    assert.equal(turnAt(items2, 0), 1);
  });

  test("空目录 → 0（调用方把它当「没有当前点」）", () => {
    assert.equal(turnAt([], 5), 0);
  });
});
