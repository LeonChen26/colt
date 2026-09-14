/**
 * 浏览器观测纯逻辑的测试。
 *
 * 这层决定模型看到什么：把 error 淹在 info 里、或把成功请求当成问题，
 * agent 就会基于错误信息继续往下做，所以格式化规则值得逐条钉住。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  CAPTURE_LIMIT,
  CaptureBuffer,
  clampWaitTimeout,
  DEFAULT_VIEWPORT,
  DEFAULT_WAIT_TIMEOUT_MS,
  exceedsDownloadSize,
  formatBytes,
  formatConsole,
  formatDownloadNotice,
  formatDownloads,
  formatNavigationNotice,
  formatNetwork,
  formatWaitResult,
  isFileInput,
  isWaitMode,
  MAX_DOWNLOAD_BYTES,
  MAX_DOWNLOADS_PER_SESSION,
  MAX_VIEWPORT_WIDTH,
  MAX_WAIT_TIMEOUT_MS,
  MIN_VIEWPORT_WIDTH,
  parseWaitOutcome,
  planDownload,
  readNodeAttribute,
  readPaths,
  readRef,
  resolveViewport,
  safeDownloadFilename,
  shouldAdoptPopup,
  waitScript,
  type ConsoleEntry,
  type DownloadEntry,
  type NetworkEntry,
} from "../src/main/host/browser-observe.ts";

function log(level: string, message: string, source = "", line = 0): ConsoleEntry {
  return { level, message, source, line };
}

function req(partial: Partial<NetworkEntry> & { url: string }): NetworkEntry {
  return { method: "GET", resourceType: "xhr", ...partial };
}

describe("formatConsole", () => {
  test("无消息时给出明确空态", () => {
    assert.equal(formatConsole([]), "控制台：自上次导航以来没有输出。");
  });

  test("error/warning 优先，不被大量 info 挤掉", () => {
    const entries = [
      ...Array.from({ length: 30 }, (_v, i) => log("info", `普通 ${i}`)),
      log("error", "脚本崩了", "https://a.com/assets/app.js?v=1", 42),
      log("warning", "废弃 API"),
    ];
    const text = formatConsole(entries, 5);
    assert.match(text, /共 32 条（error 1 \/ warning 1 \/ 其它 30）/);
    assert.match(text, /问题消息（2 条）：/);
    assert.match(text, /\[error\] 脚本崩了 \(app\.js:42\)/);
    assert.match(text, /\[warning\] 废弃 API/);
    // 普通消息只取最近 5 条
    assert.match(text, /其它最近 5 条：/);
    assert.match(text, /普通 29/);
    assert.doesNotMatch(text, /普通 24/);
  });

  test("问题消息超过上限时截断并说明", () => {
    const entries = Array.from({ length: 8 }, (_v, i) => log("error", `错误 ${i}`));
    const text = formatConsole(entries, 3);
    assert.match(text, /问题消息（8 条，仅列前 3）：/);
    assert.match(text, /错误 2/);
    assert.doesNotMatch(text, /错误 3/);
  });

  test("多行消息压成一行，避免一条日志吃掉上下文", () => {
    const text = formatConsole([log("error", "第一行\n第二行   第三行")]);
    assert.match(text, /\[error\] 第一行 第二行 第三行/);
  });
});

describe("formatNetwork", () => {
  test("无请求时给出明确空态", () => {
    assert.equal(formatNetwork([]), "网络：自上次导航以来没有捕获到请求。");
  });

  test("全是成功请求时不编造问题", () => {
    const text = formatNetwork([req({ url: "https://a.com/ok", statusCode: 200 })]);
    assert.match(text, /共 1 个请求，未发现失败/);
    assert.doesNotMatch(text, /问题请求/);
  });

  test("只列失败请求，并按 4xx/5xx/网络错误分类计数", () => {
    const text = formatNetwork([
      req({ url: "https://a.com/ok", statusCode: 200 }),
      req({ url: "https://a.com/missing", statusCode: 404 }),
      req({ url: "https://a.com/boom", statusCode: 500 }),
      req({ url: "http://localhost:3000/api", error: "net::ERR_CONNECTION_REFUSED" }),
    ]);
    assert.match(text, /共 4 个请求，问题 3 个（4xx 1 \/ 5xx 1 \/ 网络错误 1）/);
    assert.match(text, /\[404\] GET https:\/\/a\.com\/missing \(xhr\)/);
    assert.match(text, /\[500\] GET https:\/\/a\.com\/boom \(xhr\)/);
    assert.match(text, /\[错误 net::ERR_CONNECTION_REFUSED\] GET http:\/\/localhost:3000\/api \(xhr\)/);
    // 成功请求不应出现在问题列表里
    assert.doesNotMatch(text, /a\.com\/ok/);
  });

  test("相同 URL 合并计数，避免重试刷屏", () => {
    const text = formatNetwork([
      req({ url: "https://a.com/flaky", statusCode: 503 }),
      req({ url: "https://a.com/flaky", statusCode: 503 }),
      req({ url: "https://a.com/flaky", statusCode: 503 }),
    ]);
    assert.match(text, /问题请求（去重后 1 个）：/);
    assert.match(text, /\[503\] GET https:\/\/a\.com\/flaky \(xhr\) ×3/);
  });
});

describe("CaptureBuffer", () => {
  test("超出上限时丢弃最旧的", () => {
    const buffer = new CaptureBuffer();
    for (let i = 0; i <= CAPTURE_LIMIT; i += 1) {
      buffer.recordConsole(log("info", `msg-${String(i).padStart(4, "0")}`));
    }
    const text = buffer.consoleText(1000);
    assert.match(text, new RegExp(`共 ${CAPTURE_LIMIT} 条`));
    assert.doesNotMatch(text, /msg-0000/);
    assert.match(text, new RegExp(`msg-${String(CAPTURE_LIMIT).padStart(4, "0")}`));
  });

  test("reset 清空两类观测（导航后不应残留上一页的问题）", () => {
    const buffer = new CaptureBuffer();
    buffer.recordConsole(log("error", "上个页面的错"));
    buffer.recordNetwork(req({ url: "https://a.com/x", statusCode: 500 }));
    buffer.reset();
    assert.equal(buffer.consoleText(), "控制台：自上次导航以来没有输出。");
    assert.equal(buffer.networkText(), "网络：自上次导航以来没有捕获到请求。");
  });
});

describe("等待参数", () => {
  test("isWaitMode 只认三种模式", () => {
    assert.equal(isWaitMode("load"), true);
    assert.equal(isWaitMode("text"), true);
    assert.equal(isWaitMode("idle"), true);
    assert.equal(isWaitMode("click"), false);
    assert.equal(isWaitMode(undefined), false);
  });

  test("clampWaitTimeout 收敛非法与极端输入", () => {
    assert.equal(clampWaitTimeout(3000), 3000);
    assert.equal(clampWaitTimeout(1), 500);
    assert.equal(clampWaitTimeout(10_000_000), MAX_WAIT_TIMEOUT_MS);
    assert.equal(clampWaitTimeout(Number.NaN), DEFAULT_WAIT_TIMEOUT_MS);
    assert.equal(clampWaitTimeout("5000"), DEFAULT_WAIT_TIMEOUT_MS);
    assert.equal(clampWaitTimeout(undefined), DEFAULT_WAIT_TIMEOUT_MS);
  });
});

describe("waitScript", () => {
  test("三种模式各自带上判定条件与硬超时", () => {
    const textMode = waitScript("text", "登录成功", 8000, 500);
    assert.match(textMode, /登录成功/);
    assert.match(textMode, /innerText/);
    assert.match(textMode, /setTimeout\(\(\) => done\(false, '等待超时'\), 8000\)/);

    const loadMode = waitScript("load", "", 5000, 500);
    assert.match(loadMode, /readyState === 'complete'/);

    const idleMode = waitScript("idle", "", 5000, 400);
    assert.match(idleMode, /MutationObserver/);
    assert.match(idleMode, /400/);
  });

  test("文本被当作字面量嵌入，不会破坏脚本结构", () => {
    const script = waitScript("text", 'a"b\\c`d', 1000, 500);
    assert.match(script, /JSON/);
    assert.ok(script.includes(JSON.stringify('a"b\\c`d')));
  });
});

describe("parseWaitOutcome", () => {
  test("解析页面返回的 JSON", () => {
    assert.deepEqual(parseWaitOutcome('{"ok":true,"elapsedMs":1200,"detail":"已找到文本"}'), {
      ok: true,
      elapsedMs: 1200,
      detail: "已找到文本",
    });
  });

  test("ok 非 true 时一律视为未成功", () => {
    assert.equal(parseWaitOutcome('{"ok":"yes","elapsedMs":1}').ok, false);
  });

  test("非法输入降级而非抛错（页面可能已销毁）", () => {
    assert.equal(parseWaitOutcome("not json").ok, false);
    assert.equal(parseWaitOutcome(undefined).ok, false);
    assert.equal(parseWaitOutcome({ ok: true }).ok, false);
  });
});

describe("formatWaitResult", () => {
  test("成功时给出等待目标与耗时", () => {
    assert.equal(
      formatWaitResult("text", "登录成功", true, 1234),
      "等待完成：正文出现「登录成功」（耗时 1.2s）",
    );
    assert.equal(formatWaitResult("idle", "", true, 600), "等待完成：DOM 停止变化（耗时 0.6s）");
  });

  test("超时时指向下一步排查动作", () => {
    const text = formatWaitResult("load", "", false, 10_000);
    assert.match(text, /等待超时：10\.0s 内未等到「页面加载完成」/);
    assert.match(text, /console \/ network/);
  });
});

describe("resolveViewport", () => {
  test("都不给则恢复默认视口", () => {
    assert.deepEqual(resolveViewport(undefined, undefined), {
      ok: true,
      size: { ...DEFAULT_VIEWPORT },
      restored: true,
    });
  });

  test("都给则按原值生效", () => {
    assert.deepEqual(resolveViewport(375, 700), {
      ok: true,
      size: { width: 375, height: 700 },
      restored: false,
    });
  });

  test("超界值被夹取而非报错", () => {
    const tiny = resolveViewport(10, 10);
    assert.equal(tiny.ok && tiny.size.width, MIN_VIEWPORT_WIDTH);
    const huge = resolveViewport(99_999, 99_999);
    assert.equal(huge.ok && huge.size.width, MAX_VIEWPORT_WIDTH);
  });

  test("只给一个维度明确报错，不静默补默认值", () => {
    const result = resolveViewport(375, undefined);
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error : "", /同时给出/);
  });

  test("给的不是数字也报错", () => {
    const result = resolveViewport("375", "700");
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error : "", /必须是数字/);
  });
});

describe("shouldAdoptPopup", () => {
  test("接管 http/https 的新窗口请求", () => {
    assert.equal(shouldAdoptPopup("https://example.com/a"), true);
    assert.equal(shouldAdoptPopup("http://localhost:3000/"), true);
  });

  test("拒绝其它协议与非 URL，避免绕过 http/https 边界", () => {
    assert.equal(shouldAdoptPopup("file:///C:/Windows/System32/calc.exe"), false);
    assert.equal(shouldAdoptPopup("javascript:alert(1)"), false);
    assert.equal(shouldAdoptPopup("about:blank"), false);
    assert.equal(shouldAdoptPopup(""), false);
    assert.equal(shouldAdoptPopup("not a url"), false);
  });
});

describe("safeDownloadFilename", () => {
  test("普通文件名原样保留", () => {
    assert.equal(safeDownloadFilename("report.csv"), "report.csv");
    assert.equal(safeDownloadFilename("导出 2024.xlsx"), "导出 2024.xlsx");
  });

  test("剥掉路径，避免写到下载目录之外", () => {
    assert.equal(safeDownloadFilename("../../etc/passwd"), "passwd");
    assert.equal(safeDownloadFilename("C:\\Windows\\System32\\drivers\\etc\\hosts"), "hosts");
    assert.equal(safeDownloadFilename("/tmp/x/y/z.txt"), "z.txt");
  });

  test("纯点名一律回退，避免生成 . 或 ..", () => {
    assert.equal(safeDownloadFilename(".."), "download");
    assert.equal(safeDownloadFilename("."), "download");
    assert.equal(safeDownloadFilename(""), "download");
    assert.equal(safeDownloadFilename("a/.."), "download");
  });

  test("替换 Windows 禁用字符与结尾的点/空格", () => {
    assert.equal(safeDownloadFilename('a<b>c:d"e|f?g*h.txt'), "a_b_c_d_e_f_g_h.txt");
    assert.equal(safeDownloadFilename("trailing. "), "trailing");
    assert.equal(safeDownloadFilename("tab\tname.txt"), "tab_name.txt");
  });

  test("过长文件名被截断", () => {
    assert.equal(safeDownloadFilename(`${"x".repeat(300)}.txt`).length, 120);
  });
});

describe("formatBytes", () => {
  test("按量级给出可读单位", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(2048), "2.0 KB");
    assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MB");
  });
});

function download(partial: Partial<DownloadEntry> & { filename: string }): DownloadEntry {
  return { path: `/dl/${partial.filename}`, url: "https://a.com/x", bytes: 1024, state: "completed", ...partial };
}

describe("formatNavigationNotice（用户手动导航后告知 agent）", () => {
  test("三种动作各自点名，并带上目的页地址与标题", () => {
    const back = formatNavigationNotice("back", "https://a.com/prev", "上一页");
    assert.match(back, /后退/);
    assert.match(back, /https:\/\/a\.com\/prev/);
    assert.match(back, /上一页/);
    assert.match(formatNavigationNotice("forward", "https://a.com/next", ""), /前进/);
    assert.match(formatNavigationNotice("reload", "https://a.com/x", ""), /刷新/);
  });

  test("要它「重新确认页面」而不是「回应本条」", () => {
    const text = formatNavigationNotice("back", "https://a.com/prev", "上一页");
    // 标成系统提示：它会被塞进模型请求，但不该被理解成用户说的话
    assert.match(text, /系统提示/);
    // 必须给到下一步动作，否则模型仍会拿着旧 ref 继续操作
    assert.match(text, /snapshot/);
  });

  test("缺地址 / 标题时不留空壳括注", () => {
    const text = formatNavigationNotice("reload", "", "");
    assert.match(text, /about:blank/);
    assert.doesNotMatch(text, /（）/);
  });
});

describe("formatDownloadNotice", () => {
  test("完成时给出文件名、体积与落盘路径", () => {
    assert.equal(
      formatDownloadNotice(download({ filename: "1-report.csv", bytes: 2048 })),
      "已下载文件：1-report.csv（2.0 KB）→ /dl/1-report.csv",
    );
  });

  test("未完成时说明状态与原因", () => {
    const text = formatDownloadNotice(
      download({ filename: "2-big.bin", state: "cancelled", note: "超过体积上限（100 字节），已取消" }),
    );
    assert.match(text, /下载未完成（cancelled）：2-big\.bin，超过体积上限/);
  });
});

describe("formatDownloads", () => {
  test("无下载时给出明确空态", () => {
    assert.equal(formatDownloads([]), "下载：本会话尚未触发任何下载。");
  });

  test("列出文件、状态、路径与来源，并提示可用 shell 查看", () => {
    const text = formatDownloads([download({ filename: "1-a.csv", bytes: 2048 })]);
    assert.match(text, /下载：共 1 个（列出最近 1 个）/);
    assert.match(text, /1-a\.csv \[2\.0 KB\] → \/dl\/1-a\.csv/);
    assert.match(text, /来自 https:\/\/a\.com\/x/);
    assert.match(text, /shell \/ 读文件工具/);
  });
});

describe("readNodeAttribute / isFileInput", () => {
  test("从扁平的属性数组里取值", () => {
    const attributes = ["type", "file", "name", "avatar"];
    assert.equal(readNodeAttribute(attributes, "type"), "file");
    assert.equal(readNodeAttribute(attributes, "name"), "avatar");
    assert.equal(readNodeAttribute(attributes, "id"), undefined);
    assert.equal(readNodeAttribute(undefined, "type"), undefined);
  });

  test("只认 INPUT 且 type=file", () => {
    assert.equal(isFileInput("INPUT", ["type", "file"]), true);
    assert.equal(isFileInput("input", ["type", "file"]), true);
    assert.equal(isFileInput("INPUT", ["type", "text"]), false);
    assert.equal(isFileInput("INPUT", []), false);
    assert.equal(isFileInput("A", ["type", "file"]), false);
  });
});

describe("CaptureBuffer 的下载缓冲", () => {
  test("导航不清空下载（文件已落盘，与页面生命周期无关）", () => {
    const buffer = new CaptureBuffer();
    buffer.recordDownload(download({ filename: "1-a.csv" }));
    buffer.reset();
    assert.match(buffer.downloadsText(), /1-a\.csv/);
  });

  test("超过条数上限时丢弃最旧的", () => {
    const buffer = new CaptureBuffer();
    for (let i = 1; i <= MAX_DOWNLOADS_PER_SESSION + 2; i += 1) {
      buffer.recordDownload(download({ filename: `${i}-f${i}.csv` }));
    }
    const text = buffer.downloadsText(100);
    assert.doesNotMatch(text, /1-f1\.csv/);
    assert.match(text, new RegExp(`${MAX_DOWNLOADS_PER_SESSION + 2}-f${MAX_DOWNLOADS_PER_SESSION + 2}\\.csv`));
  });
});

describe("readPaths（upload 的本地路径入参）", () => {
  test("非数组一律视为空，交给上层明确报错", () => {
    assert.deepEqual(readPaths(undefined), []);
    assert.deepEqual(readPaths(null), []);
    assert.deepEqual(readPaths("a.txt"), []);
    assert.deepEqual(readPaths({ 0: "a.txt" }), []);
  });

  test("剔除非字符串项，只留可用的路径", () => {
    assert.deepEqual(readPaths(["a.txt", 42, null, { p: 1 }, true, "b.txt"]), ["a.txt", "b.txt"]);
  });

  test("去掉首尾空白，丢掉空串与纯空白", () => {
    assert.deepEqual(readPaths(["  C:/x/a.txt  ", "", "   ", "\tb.txt\n"]), ["C:/x/a.txt", "b.txt"]);
  });

  test("保持原有顺序，便于把提示对应回用户给的数组", () => {
    assert.deepEqual(readPaths(["2.txt", "1.txt"]), ["2.txt", "1.txt"]);
  });
});

describe("readRef（upload 的目标元素）", () => {
  test("接受 snapshot 派发的编号，并去掉首尾空白", () => {
    assert.equal(readRef("e1"), "e1");
    assert.equal(readRef("e12"), "e12");
    assert.equal(readRef("e0"), "e0");
    assert.equal(readRef("  e3  "), "e3");
  });

  test("拒绝任意选择器，守住「DOM 只走 ref」的边界", () => {
    for (const bad of ["#login", "div", "input[type=file]", ".btn", "body > a"]) {
      assert.throws(() => readRef(bad), /需要有效的 ref/);
    }
  });

  test("拒绝形状接近但不是编号的输入", () => {
    for (const bad of ["e", "e1x", "E1", "e-1", "e1.5", " e ", "ref1", ""]) {
      assert.throws(() => readRef(bad), /需要有效的 ref/);
    }
  });

  test("非字符串输入同样拒绝", () => {
    assert.throws(() => readRef(undefined), /需要有效的 ref/);
    assert.throws(() => readRef(null), /需要有效的 ref/);
    assert.throws(() => readRef(1), /需要有效的 ref/);
    assert.throws(() => readRef({ ref: "e1" }), /需要有效的 ref/);
  });
});

describe("planDownload（下载落盘规划）", () => {
  const dir = join("/", "downloads", "s1");

  test("加序号前缀，避免页面反复用同一个名字互相覆盖", () => {
    const plan = planDownload("export.csv", 3, dir);
    assert.equal(plan.ok, true);
    assert.equal(plan.ok && plan.seq, 3);
    assert.equal(plan.ok && plan.filename, "3-export.csv");
    assert.equal(plan.ok && plan.path, join(dir, "3-export.csv"));
  });

  test("文件名先清洗再拼路径，页面给的名字不能写到目录之外", () => {
    const plan = planDownload("../../etc/passwd", 1, dir);
    assert.equal(plan.ok && plan.filename, "1-passwd");
    assert.equal(plan.ok && plan.path, join(dir, "1-passwd"));
  });

  test("全点名兜底为 download，不会生成 . 或 ..", () => {
    const plan = planDownload("..", 2, dir);
    assert.equal(plan.ok && plan.filename, "2-download");
  });

  test("恰好达到条数上限仍放行", () => {
    assert.equal(planDownload("a.csv", MAX_DOWNLOADS_PER_SESSION, dir).ok, true);
  });

  test("超过条数上限则拒绝，并说明原因与上限值", () => {
    const plan = planDownload("a.csv", MAX_DOWNLOADS_PER_SESSION + 1, dir);
    assert.equal(plan.ok, false);
    assert.match(plan.ok === false ? plan.reason : "", /已取消下载/);
    assert.match(
      plan.ok === false ? plan.reason : "",
      new RegExp(`超过上限 ${MAX_DOWNLOADS_PER_SESSION}`),
    );
  });

  test("上限可覆盖，便于按场景收紧", () => {
    assert.equal(planDownload("a.csv", 3, dir, 3).ok, true);
    assert.equal(planDownload("a.csv", 4, dir, 3).ok, false);
  });
});

describe("exceedsDownloadSize（体积上限边界）", () => {
  test("未达上限不算超限", () => {
    assert.equal(exceedsDownloadSize(0), false);
    assert.equal(exceedsDownloadSize(MAX_DOWNLOAD_BYTES - 1), false);
  });

  test("恰好等于上限仍放行（边界用 > 而非 >=）", () => {
    assert.equal(exceedsDownloadSize(MAX_DOWNLOAD_BYTES), false);
  });

  test("超过上限即判定超限", () => {
    assert.equal(exceedsDownloadSize(MAX_DOWNLOAD_BYTES + 1), true);
  });

  test("上限可覆盖", () => {
    assert.equal(exceedsDownloadSize(100, 100), false);
    assert.equal(exceedsDownloadSize(101, 100), true);
  });
});
