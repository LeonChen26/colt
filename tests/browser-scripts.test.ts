/**
 * 命中测试 / 聚焦准备的解析测试。
 *
 * 这两个解析函数决定「点击到底点不点」：判成可点就会真的按下鼠标，判错方向时
 * **代价不对称**——把「被遮挡」误判成可点，会点到遮挡它的元素上（可能是别的按钮，
 * 甚至提交按钮），且模型只会看到「已点击成功」；反过来把可点误判成不可点，只是白跑一步。
 * 所以每条分支都钉住文案要点，尤其是「没有真的点」这条承诺。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  confirmScript,
  focusScript,
  highlightScript,
  hitScript,
  parseConfirmResult,
  parseFocusResult,
  parseHitResult,
} from "../src/main/host/browser-scripts";

const json = (value: unknown): string => JSON.stringify(value);

describe("parseHitResult：能点就给出坐标", () => {
  test("成功：坐标与人读的命中描述一起带回", () => {
    const outcome = parseHitResult(json({ ok: true, x: 120, y: 88, hit: "<button#go> 「提交」" }), "e7");
    assert.deepEqual(outcome, { ok: true, x: 120, y: 88, hit: "<button#go> 「提交」" });
  });

  test("坐标不是数字 → 当作失败（不能拿 NaN 去点）", () => {
    const outcome = parseHitResult(json({ ok: true, x: null, hit: "x" }), "e7");
    assert.equal(outcome.ok, false);
    assert.match(String((outcome as { message: string }).message), /非法坐标/);
  });
});

describe("parseHitResult：点不到要说清原因与下一步", () => {
  const messageOf = (payload: unknown): string => {
    const outcome = parseHitResult(json(payload), "e7");
    assert.equal(outcome.ok, false);
    return (outcome as { message: string }).message;
  };

  test("元素不在了 → 提示重新 snapshot", () => {
    assert.match(messageOf({ ok: false, reason: "not-found" }), /未找到元素 e7.*重新执行 snapshot/s);
  });

  test("被遮挡 → 点名遮挡者，并明说**没有真的点**（最关键的一条承诺）", () => {
    const message = messageOf({
      ok: false,
      reason: "blocked",
      self: "<button#submit>",
      blocker: "<div#cookie.notice> 「接受 Cookie」",
    });
    assert.match(message, /<div#cookie\.notice>/);
    assert.match(message, /已中止/);
    assert.match(message, /请先关掉/);
  });

  test("元素自己不接收指针事件（命中到祖先）与「被别的元素挡住」分开报", () => {
    const message = messageOf({
      ok: false,
      reason: "no-pointer-events",
      self: "<span.icon>",
      blocker: "<div.wrapper>",
    });
    assert.match(message, /不接收指针事件/);
    assert.match(message, /<div\.wrapper>/);
  });

  test("尺寸为 0 / 中心不在可视区 → 各自给出该做什么", () => {
    assert.match(messageOf({ ok: false, reason: "zero-size", self: "<a>" }), /尺寸为 0/);
    const outOfView = messageOf({ ok: false, reason: "out-of-view", self: "<a>", x: 40, y: 9000 });
    assert.match(outOfView, /不在可视区/);
    assert.match(outOfView, /9000/);
  });

  test("未知 reason 与坏 JSON 都不许静默：要带上原文片段", () => {
    assert.match(messageOf({ ok: false, reason: "wat" }), /wat/);
    const broken = parseHitResult("不是 JSON", "e7");
    assert.equal(broken.ok, false);
    assert.match((broken as { message: string }).message, /不是 JSON/);
  });
});

describe("parseFocusResult：没就绪就不能输", () => {
  test("就绪：带回被替换的字符数（回话要用它说明「替换了多少」）", () => {
    const outcome = parseFocusResult(json({ ok: true, previous: 6, self: "<input#email>" }), "e3");
    assert.deepEqual(outcome, { ok: true, previous: 6, self: "<input#email>" });
  });

  test("不是可输入元素 → 指出 type 只支持哪三类", () => {
    const outcome = parseFocusResult(json({ ok: false, reason: "not-editable", self: "<button>" }), "e3");
    assert.equal(outcome.ok, false);
    assert.match((outcome as { message: string }).message, /不是可输入的元素.*input \/ textarea \/ contenteditable/s);
  });

  test("焦点被抢走 → 点名焦点去了哪（那时输入会写错地方）", () => {
    const outcome = parseFocusResult(
      json({ ok: false, reason: "focus-refused", self: "<input#a>", active: "<input#b>" }),
      "e3",
    );
    assert.equal(outcome.ok, false);
    assert.match((outcome as { message: string }).message, /<input#b>/);
  });

  test("元素不在了 / 坏 JSON → 如实报错", () => {
    const gone = parseFocusResult(json({ ok: false, reason: "not-found" }), "e3");
    assert.match((gone as { message: string }).message, /未找到元素 e3/);
    const broken = parseFocusResult("nope", "e3");
    assert.equal(broken.ok, false);
    assert.match((broken as { message: string }).message, /nope/);
  });
});

describe("脚本生成：ref 只能作字面量，不能破出属性", () => {
  // 脚本里的选择器是 **双引号** 字符串字面量（JSON.stringify 的结果），
  // 所以断言里写的是转义形式 `\"`——这正是「ref 被当数据而不是当代码拼进去」的证据。
  test("正常 ref 以字符字面量形式出现在选择器里", () => {
    // 正则里的 `\\"` 匹配「反斜杠 + 引号」，也就是脚本里被转义过的引号
    assert.ok(/\[data-colt-ref=\\"e12\\"\]/.test(hitScript("e12")));
    assert.ok(/\[data-colt-ref=\\"e12\\"\]/.test(focusScript("e12")));
  });

  test("恶意 ref 里的引号被转义：原文不出现，也就闭合不了字符串、带不进新语句", () => {
    const evil = 'e1"] ; window.__pwned = 1; "';
    const script = hitScript(evil);
    assert.ok(script.includes('\\"'), "引号应当以转义形式出现");
    assert.ok(!script.includes(evil), "原始注入串不得原样出现");
  });

  test("滚动用 instant，避免 CSS 平滑滚动把 rect 停在动画中途", () => {
    // 坐标点击才会被这件事绊到（合成事件不取坐标），所以它属于这条链路的固有前提
    assert.ok(hitScript("e1").includes("behavior: 'instant'"));
    assert.ok(focusScript("e1").includes("behavior: 'instant'"));
  });
});

describe("confirmScript / parseConfirmResult：动作前的最后确认", () => {
  test("正常：带回元素中心与焦点归属", () => {
    assert.deepEqual(parseConfirmResult(json({ found: true, x: 120, y: 88, active: true })), {
      found: true,
      x: 120,
      y: 88,
      active: true,
    });
  });

  test("元素不在了 → found:false（调用方据此中止或重算）", () => {
    assert.deepEqual(parseConfirmResult(json({ found: false })), { found: false });
  });

  test("缺坐标 / 坐标不是数字 / 坏 JSON 一律当「不在」——绝不拿默认值继续点", () => {
    assert.deepEqual(parseConfirmResult(json({ found: true, active: true })), { found: false });
    assert.deepEqual(parseConfirmResult(json({ found: true, x: null, y: 5 })), { found: false });
    assert.deepEqual(parseConfirmResult("nope"), { found: false });
  });

  test("active 缺失按 false（焦点没在它身上）", () => {
    const outcome = parseConfirmResult(json({ found: true, x: 1, y: 2 }));
    if (!outcome.found) throw new Error("应当 found:true");
    assert.equal(outcome.active, false);
  });

  test("滚动用 nearest 而不是 center——不抢用户正在看的视野", () => {
    assert.ok(hitScript("e1").includes("block: 'nearest'"));
    assert.ok(!hitScript("e1").includes("block: 'center'"));
    assert.ok(focusScript("e1").includes("block: 'nearest'"));
  });

  test("确认脚本里的 ref 同样被转义（破不出字符串字面量）", () => {
    const evil = 'e1"] ; window.__pwned = 1; "';
    const script = confirmScript(evil);
    assert.ok(script.includes('\\"'), "引号应当以转义形式出现");
    assert.ok(!script.includes(evil), "原始注入串不得原样出现");
  });
});

describe("highlightScript：操作后的归属提示", () => {
  test("带动作标签与不吃指针事件的框（否则会挡住它自己标的元素）", () => {
    const script = highlightScript("e3", "Agent 点击");
    assert.ok(script.includes("Agent 点击"));
    assert.ok(script.includes("pointer-events:none"));
    assert.ok(script.includes("e3"));
  });

  test("没有 ref 时标当前焦点元素（按键动作没有 ref）", () => {
    assert.ok(highlightScript(null, "Agent 按键 Enter").includes("document.activeElement"));
  });

  test("先清上一个、再自己定时移除——连续操作不堆一屏框", () => {
    const script = highlightScript("e1", "Agent 点击");
    assert.ok(script.includes("previous.remove()"));
    assert.ok(script.includes("box.remove()"));
  });

  test("挂在 body 下（这样 browser_read 的 text 读得到它）", () => {
    assert.ok(highlightScript("e1", "Agent 点击").includes("body"));
  });

  test("ref 同样被转义（破不出字符串字面量）", () => {
    const evil = 'e1"] ; window.__pwned = 1; "';
    assert.ok(!highlightScript(evil, "x").includes(evil));
  });
});
