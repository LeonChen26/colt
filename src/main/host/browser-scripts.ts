// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 注入页面的脚本：snapshot 清单、内容宽度测量、命中测试与聚焦。
 *
 * 从 `browser-host.ts` 搬出来的（那个文件卡在体量闸上，加功能必须同时搬走等量旧代码）。
 * 这几段**自成一体**：纯字符串常量与纯函数，不碰任何宿主状态。
 *
 * 为什么这里只剩「读」与「定位」，没有了点击/输入：那两个动作改走 Chromium 的
 * **真实输入管线**（CDP `Input.*`，见 `browser-input.ts`）——合成 `el.click()` 只派发
 * 一个 `click`，而真实鼠标点击会派发 pointerdown → mousedown → focus → mouseup → click
 * （实测），前者对监听 mousedown/pointerdown 的组件、以及依赖「点击后焦点落到元素上」
 * 的交互是**静默不响应**的。所以：
 *   - 点击前先要一份**可点的坐标 + 命中测试**（`hitScript`）；
 *   - 输入前先把元素**聚焦并全选**（`focusScript`，保住「替换」语义）。
 * 两者都把判断结果以 JSON 字符串交回主进程，由 `browser-host.ts` 决定「能不能动作」。
 */

/**
 * 页面内取**可见**可交互元素：给每个元素打稳定 ref，返回一段人类/模型可读的清单。
 *
 * 可见性过滤（借鉴 browser-use，但保留本项目的持久 ref 机制）：不可见元素进清单只会
 * 误导——模型拿着 ref 去点一个看不见的东西。判据四条：
 *   ① 几何零尺寸（display:none 必然 0×0）；
 *   ② 已滚出视口顶部（rect.bottom <= 0）或远在视口下方阈值之外（top >= 视口高 + 800）；
 *   ③ visibility 隐藏（此时元素仍有尺寸，① 抓不到）；
 *   ④ 透明度归零（同上）。
 * 视口下方 800px 内的**保留**：模型可以先看清单再滚动，滚动后 ref 不变
 * （data-colt-ref 持久编号 + window.__coltRefSeq），这是相对 browser-use 每次重建索引的优势。
 * 过滤发生在 slice(0, 200) 之前——先切 200 再过滤会让一屏隐藏元素吃光配额。
 * 被遮挡（z-index 盖住）**不在这里判**：清单是「页面上有什么」，遮挡是「这一刻点不点得到」，
 * 属于点击时的事——交给 `hitScript` 在那一次点击前判，判出来会如实报错。
 *
 * 新元素标记：本页（本次导航生命周期内）**首次**进入清单的 ref 前缀 `*[`，其余仍是 `[`。
 * 模型滚动 / 翻页后重新 snapshot，一眼可辨哪些是新出现的（借鉴 browser-use）。
 * 记忆存 window.__coltSeenRefs（Set），随导航重置——新页面首个 snapshot 全部带 `*[` 是预期。
 *
 * 行格式：`[e12] role "name" = "value" (states)`，后两段按需出现：
 *   - `= "value"`：**能承载文本**的元素才报——textarea 报内容，select 取**被选中项的文本**
 *     （select 的 value 属性常是空串或索引，对模型没用）；
 *     `input` 里 checkbox / radio / file / submit 之类**不报**：它们的 `value` 是表单提交值
 *     （实测 checkbox 默认就是 `"on"`），既不是状态也不是内容，只会白占上下文——
 *     checkbox 的「勾没勾」由 `(checked)` 表达，两处都写就是同义重复；
 *   - `(states)`：disabled / checked / mixed / required / multiple——勾没勾、灰没灰
 *     必须一眼看得出，否则模型只能靠截图猜（这是相对只有 role+name 的那版的主要补强）。
 * ⚠️ `name` 从此**不再回落到 `el.value`**：「无 placeholder 但有值」的输入框由 `= "value"`
 * 表达，两处都写会让同一个值出现两遍、白占上下文。
 */
export const SNAPSHOT_SCRIPT = `(() => {
  const selector = 'a,button,input,select,textarea,[role="button"],[role="link"],[contenteditable="true"]';
  const vh = window.innerHeight || document.documentElement.clientHeight || 0;
  const limit = vh + 800;
  const visible = Array.from(document.querySelectorAll(selector)).filter((el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (rect.bottom <= 0 || rect.top >= limit) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (Number(style.opacity) <= 0) return false;
    return true;
  }).slice(0, 200);
  const clip = (raw) => String(raw == null ? '' : raw).replace(/\\s+/g, ' ').trim().slice(0, 80);
  // 不报 value 的 input 类型：它们的 value 是「表单提交值」而不是「内容」
  // （checkbox 默认 "on"），报出来既是噪声又会与 (checked) 同义重复
  const NO_VALUE_TYPES = ['checkbox', 'radio', 'file', 'submit', 'reset', 'button', 'image', 'hidden'];
  let seq = Number(window.__coltRefSeq || 0);
  let seen = window.__coltSeenRefs;
  if (!(seen instanceof Set)) { seen = new Set(); window.__coltSeenRefs = seen; }
  const lines = visible.map((el) => {
    let ref = el.getAttribute('data-colt-ref');
    if (!ref) { seq += 1; ref = 'e' + seq; el.setAttribute('data-colt-ref', ref); }
    const fresh = !seen.has(ref);
    seen.add(ref);
    const raw = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.innerText || '';
    const role = el.getAttribute('role') || el.tagName.toLowerCase();
    const states = [];
    if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') states.push('disabled');
    if (el.indeterminate === true) states.push('mixed');
    else if (el.checked === true || el.getAttribute('aria-checked') === 'true') states.push('checked');
    if (el.required === true) states.push('required');
    if (el.multiple === true) states.push('multiple');
    let value = '';
    const type = String(el.getAttribute('type') || 'text').toLowerCase();
    if (el.tagName === 'SELECT') {
      const option = el.selectedOptions && el.selectedOptions[0];
      if (option) value = clip(option.textContent);
    } else if (el.tagName === 'TEXTAREA') {
      value = clip(el.value);
    } else if (el.tagName === 'INPUT' && NO_VALUE_TYPES.indexOf(type) === -1) {
      value = clip(el.value);
    }
    let line = (fresh ? '*[' : '[') + ref + '] ' + role + ' "' + clip(raw) + '"';
    if (value) line += ' = "' + value + '"';
    if (states.length > 0) line += ' (' + states.join(', ') + ')';
    return line;
  });
  window.__coltRefSeq = seq;
  return 'URL: ' + location.href + '\\nTITLE: ' + document.title + '\\n' + lines.join('\\n');
})()`;

/**
 * 量「页面内容实际需要的宽度」。
 *
 * 只关心一种无解的情形：内容比视口宽、而页面又把横向滚动关掉了
 * （`<html>` / `<body>` 上写死 `overflow-x: hidden`）。此时右边被裁掉的部分
 * 既没有滚动条、也没有别的入口，只能由界面告诉用户。
 * 页面自己能横向滚动（用户滚得到）或内容本来就装得下，一律返回 0。
 *
 * 两个易错点（都是实测出来的，不是推的）：
 *   ① 内容宽度**不要**去遍历全元素取右边界最大值：那样会把已经被内层滚动容器裁住的
 *      内容也算进来——宽表格套在 `overflow-x: auto` 的壳里时，它超出的是那个壳而不是视口，
 *      用户滚那个壳就能看到。文档级的 `scrollWidth` 天然不含这种内层裁剪。
 *   ② 用「根 / body 的 `overflow-x` 是不是 hidden」判「用户滚不到」，而**不要**用
 *      `documentElement.scrollWidth > clientWidth` 当「有横向滚动条」的依据：
 *      实测这条不成立——夹具页视口 219、内容 700、`<html>` 写了 `overflow-x: hidden`，
 *      而 `documentElement.scrollWidth` 照样报 700（并没有被钳到 clientWidth）。
 *      照那个判据走会把「真的够不到」误判成「用户自己能滚」，于是永远不提示。
 *      （`overflow: hidden` 只是禁止**用户**滚动，脚本仍能改 scrollLeft，所以也不能拿
 *      「试着滚一下看动不动」当判据。）
 */
export const CONTENT_WIDTH_SCRIPT = `(() => {
  const doc = document.documentElement;
  const viewport = doc.clientWidth || 0;
  if (viewport <= 0) return 0;
  const body = document.body;
  const content = Math.max(doc.scrollWidth, body ? body.scrollWidth : 0);
  if (content <= viewport + 1) return 0;
  const off = (value) => value === 'hidden' || value === 'clip';
  const reachable =
    !off(getComputedStyle(doc).overflowX) && !(body && off(getComputedStyle(body).overflowX));
  return reachable ? 0 : Math.ceil(content);
})()`;

/**
 * 页面内给元素起的可读描述（命中测试与聚焦的报错都用它）。
 *
 * 目的是让模型不看页面也能判断「挡住我的是什么」：`<div#cookie-banner.notice> 「接受 Cookie」`
 * 显然该先关掉，而 `<div.overlay>` 就得换个思路。所以带上 tag / id / 前两个 class / 一小段文本。
 */
const DESCRIBE_FN = `const describe = (node) => {
    if (!node || !node.tagName) return '未知元素';
    const id = node.id ? '#' + node.id : '';
    const cls = String(node.className || '').split(/\\s+/).filter(Boolean).slice(0, 2).map((name) => '.' + name).join('');
    const text = String(node.innerText || node.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 30);
    return '<' + node.tagName.toLowerCase() + id + cls + '>' + (text ? ' 「' + text + '」' : '');
  };`;

/**
 * 点击前的「能不能点」判定：滚动到元素 → 算中心坐标 → 命中测试。
 *
 * 为什么必须做：坐标点击打到的是**那一刻那个点上最上层的元素**，而不是我们想要的那个。
 * 实测（探针）对「被遮罩盖住的按钮」的中心真点一次，pointerdown/mousedown/mouseup/click
 * 四条事件**全部落在遮罩上**，而 `document.elementFromPoint` 对同一点返回的也正是遮罩——
 * 两者一致，所以命中测试是可靠的预判。没有这一步，模型会拿到「已点击 e12」却什么都没发生
 * （比报错更糟：它会以为成功了，然后反复重试或去点别的东西）。
 *
 * 坐标基准：`getBoundingClientRect()` 与 CDP `Input.dispatchMouseEvent` **同为 CSS 像素**
 * （实测：zoom 0.5 时 innerWidth 887→1774、dpr 1.25→0.625，而 rect 不变且按它中心的点击
 * 命中正确），所以不需要乘 dpr、也不需要除 zoom。
 *
 * 滚动用 `behavior: 'instant'`：页面若写了 `scroll-behavior: smooth`，滚动变成动画，
 * 照中途的 rect 去点就会打偏（合成事件不存在这个问题，坐标点击才暴露出来）。
 * 另外再等「连续两帧 rect 不动」兜底（懒加载图片插入之类也会让元素位移）。
 *
 * `block: 'nearest'`（而不是 `'center'`）：居中会把**用户正在看的画面拽走**——这个面板是给人看的，
 * agent 每点一下就抢一次视野是不能接受的。nearest 只在元素本来就不可见时滚最小距离；
 * 代价是元素可能贴住视口边缘，但它的中心仍落在视口内（命中测试的判据就是中心），不影响点击。
 * 另外：元素被 sticky 头挡住时，命中测试会如实报「被遮挡」而不是静默点错。
 *
 * 四种「点不到」分开报，因为处置办法完全不同：
 *   not-found        页面变了 → 重新 snapshot
 *   zero-size / out-of-view  元素本身不可见 → 换个 ref 或先滚动
 *   no-pointer-events  命中到的是自己的**祖先**（元素自己不接收指针事件）
 *   blocked          被别的元素盖住 → 先关掉那个东西
 */
export function hitScript(ref: string): string {
  const selector = JSON.stringify(`[data-colt-ref="${ref}"]`);
  return `(() => {
  const el = document.querySelector(${selector});
  if (!el) return JSON.stringify({ ok: false, reason: 'not-found' });
  ${DESCRIBE_FN}
  const rectOf = (node) => {
    const r = node.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  };
  try { el.scrollIntoView({ block: 'nearest', behavior: 'instant' }); }
  catch (error) { el.scrollIntoView({ block: 'nearest' }); }
  const settle = () => new Promise((resolve) => {
    let previous = rectOf(el);
    let frames = 0;
    const tick = () => {
      const current = rectOf(el);
      const stable = Math.abs(current.x - previous.x) < 0.5 && Math.abs(current.y - previous.y) < 0.5;
      if (stable || frames >= 10) { resolve(current); return; }
      previous = current;
      frames += 1;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  return settle().then((rect) => {
    if (rect.w <= 0 || rect.h <= 0) {
      return JSON.stringify({ ok: false, reason: 'zero-size', self: describe(el) });
    }
    const x = rect.x + rect.w / 2;
    const y = rect.y + rect.h / 2;
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
      return JSON.stringify({ ok: false, reason: 'out-of-view', self: describe(el), x: Math.round(x), y: Math.round(y) });
    }
    const hit = document.elementFromPoint(x, y);
    if (!hit) return JSON.stringify({ ok: false, reason: 'no-hit', self: describe(el) });
    // 命中自己、或自己的后代都算可点（事件会冒泡到 el）。
    // 命中自己的**祖先**说明 el 根本不接收指针事件（elementFromPoint 会跳过 pointer-events:none），
    // 其余情况才是被别的元素盖住——两种都要拒绝，但原因不同。
    if (hit !== el && !el.contains(hit)) {
      return JSON.stringify({
        ok: false,
        reason: hit.contains(el) ? 'no-pointer-events' : 'blocked',
        self: describe(el),
        blocker: describe(hit),
      });
    }
    return JSON.stringify({ ok: true, x: Math.round(x), y: Math.round(y), hit: describe(hit) });
  });
})()`;
}

/** 命中测试的结果：能点（带坐标）与不能点（带人话理由）二选一 */
export type HitOutcome =
  | { ok: true; x: number; y: number; hit: string }
  | { ok: false; message: string };

/**
 * 解析 `hitScript` 的返回值，把 reason 翻成**可据以行动**的人话。
 *
 * 关键在「给出下一步」：not-found 要重新 snapshot、blocked 要先关遮挡、
 * out-of-view 要换个目标——只说「点击失败」等于让模型瞎试。
 */
export function parseHitResult(raw: unknown, ref: string): HitOutcome {
  let parsed: {
    ok?: unknown;
    reason?: unknown;
    self?: unknown;
    blocker?: unknown;
    x?: unknown;
    y?: unknown;
    hit?: unknown;
  };
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return { ok: false, message: `命中测试没有返回可解析的结果（页面可能正在跳转）：${String(raw).slice(0, 120)}` };
  }
  if (parsed.ok === true) {
    // ⚠ 不能用 `Number(parsed.x)` 宽松转换：`Number(null)` 是 0、`Number("")` 也是 0，
    // 缺字段会被当成「合法坐标 0」——那样会点到页面左上角，而模型看到的是「已点击」。
    const x = parsed.x;
    const y = parsed.y;
    if (
      typeof x !== "number" ||
      typeof y !== "number" ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    ) {
      return { ok: false, message: `命中测试返回了非法坐标（${String(parsed.x)}, ${String(parsed.y)}）` };
    }
    return { ok: true, x: x, y: y, hit: String(parsed.hit ?? "未知元素") };
  }
  const self = String(parsed.self ?? `${ref}`);
  switch (parsed.reason) {
    case "not-found":
      return { ok: false, message: `未找到元素 ${ref}：页面可能已跳转或元素被移除，请重新执行 snapshot` };
    case "zero-size":
      return { ok: false, message: `元素 ${ref}（${self}）当前尺寸为 0，点不到——请先滚动或换一个 ref` };
    case "out-of-view":
      return {
        ok: false,
        message: `元素 ${ref}（${self}）的中心 (${String(parsed.x)}, ${String(parsed.y)}) 不在可视区内，点不到——请先滚动页面或换一个 ref`,
      };
    case "no-hit":
      return { ok: false, message: `元素 ${ref}（${self}）的中心点上没有任何元素（可能被裁掉了），点不到` };
    case "no-pointer-events":
      return {
        ok: false,
        message: `元素 ${ref}（${self}）不接收指针事件（该点命中它的是祖先 ${String(parsed.blocker)}），点了也不会触发它——请改点它的可交互子元素或换一个 ref`,
      };
    case "blocked":
      return {
        ok: false,
        message:
          `元素 ${ref}（${self}）被 ${String(parsed.blocker)} 遮挡：在该位置按下会打到遮挡它的元素上，已中止（没有真的点）。` +
          `请先关掉这个遮挡层，或改用其它入口`,
      };
    default:
      return { ok: false, message: `命中测试失败（${String(parsed.reason)}）：${JSON.stringify(parsed).slice(0, 160)}` };
  }
}

/**
 * 输入前的准备：滚动到位、聚焦、**全选**。
 *
 * 为什么要全选：`Input.insertText` 是「在光标处插入」（实测：光标在末尾时 abc → abcXYZ）。
 * 而 `type` 的既有语义是**替换**——保住它必须先把已有内容选成选区，insertText 会替换选区
 * （实测：全选后 `旧值abc` → `替换后`）。
 *
 * 为什么聚焦用 JS 而不是 CDP `DOM.focus({backendNodeId})`：insertText 插到的是**当前焦点**，
 * 而 `el.focus()` 已足够把焦点放对（实测），省掉 `DOM.getDocument` + `DOM.querySelector`
 * 两次往返。代价是 focus 事件不可信（isTrusted:false），对绝大多数组件无影响。
 *
 * ⚠️ 必须回验 `document.activeElement === el`：焦点可能被页面的 autofocus、弹层抢走，
 * 那时 insertText 会把文本**输进别的输入框**——静默写错地方，比报错贵得多。
 */
export function focusScript(ref: string): string {
  const selector = JSON.stringify(`[data-colt-ref="${ref}"]`);
  return `(() => {
  const el = document.querySelector(${selector});
  if (!el) return JSON.stringify({ ok: false, reason: 'not-found' });
  ${DESCRIBE_FN}
  try { el.scrollIntoView({ block: 'nearest', behavior: 'instant' }); }
  catch (error) { el.scrollIntoView({ block: 'nearest' }); }
  const isTextField = (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && typeof el.value === 'string';
  if (!isTextField && el.isContentEditable !== true) {
    return JSON.stringify({ ok: false, reason: 'not-editable', self: describe(el) });
  }
  const previous = isTextField ? el.value.length : String(el.textContent || '').length;
  el.focus();
  if (isTextField && typeof el.setSelectionRange === 'function') {
    el.setSelectionRange(0, el.value.length);
  } else {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    if (selection) { selection.removeAllRanges(); selection.addRange(range); }
  }
  if (document.activeElement !== el) {
    return JSON.stringify({
      ok: false,
      reason: 'focus-refused',
      self: describe(el),
      active: describe(document.activeElement),
    });
  }
  return JSON.stringify({ ok: true, previous: previous, self: describe(el) });
})()`;
}

/** 聚焦准备的结果：就绪（带被替换字符数）与没就绪（带人话理由）二选一 */
export type FocusOutcome =
  | { ok: true; previous: number; self: string }
  | { ok: false; message: string };

/** 解析 `focusScript` 的返回值；语义同 `parseHitResult`：报错必须带下一步 */
export function parseFocusResult(raw: unknown, ref: string): FocusOutcome {
  let parsed: { ok?: unknown; reason?: unknown; self?: unknown; active?: unknown; previous?: unknown };
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return { ok: false, message: `聚焦没有返回可解析的结果（页面可能正在跳转）：${String(raw).slice(0, 120)}` };
  }
  if (parsed.ok === true) {
    return {
      ok: true,
      previous:
        typeof parsed.previous === "number" && Number.isFinite(parsed.previous) ? parsed.previous : 0,
      self: String(parsed.self ?? ref),
    };
  }
  const self = String(parsed.self ?? ref);
  switch (parsed.reason) {
    case "not-found":
      return { ok: false, message: `未找到元素 ${ref}：页面可能已跳转或元素被移除，请重新执行 snapshot` };
    case "not-editable":
      return {
        ok: false,
        message: `${ref}（${self}）不是可输入的元素：type 只支持 input / textarea / contenteditable，请改用 click 或换一个 ref`,
      };
    case "focus-refused":
      return {
        ok: false,
        message: `${ref}（${self}）聚焦失败：焦点落在了 ${String(parsed.active)} 上，此时输入会写进那个元素，已中止`,
      };
    default:
      return { ok: false, message: `聚焦失败（${String(parsed.reason)}）：${JSON.stringify(parsed).slice(0, 160)}` };
  }
}

/**
 * 动作前的**最后一次确认**：元素中心是否仍在那个坐标、焦点是否还在它身上。
 *
 * 为什么这不是洁癖：从「算出坐标」到「真的按下」之间隔着两次 CDP 往返（取 rect 与命中测试在
 * `hitScript` 里、派发在 `clickAt` 里），而页面在这几十毫秒里可能自己变——懒加载图片插入、
 * 广告位展开都会让元素位移；用户在这期间滚动更直接：那个坐标会指向**别的元素**，
 * 我们就会替他点一下完全无关的东西。合成 `el.click()` 不依赖坐标，从来没有这个问题，
 * 换成真实输入之后它就是这条链路自己的常数成本。
 * 同理，聚焦与插入文本之间若焦点被页面脚本或用户抢走，文本会写进别的输入框。
 *
 * 与 `hitScript` 分开（而不是合并成一次）是**故意的**：合并就没法「验一次、发现变了、再重算」，
 * 而重算正是最常见情形的正确处置（用户刚滚过页面，重算一次坐标就对了）。
 */
export function confirmScript(ref: string): string {
  const selector = JSON.stringify(`[data-colt-ref="${ref}"]`);
  return `(() => {
  const el = document.querySelector(${selector});
  if (!el) return JSON.stringify({ found: false });
  const rect = el.getBoundingClientRect();
  return JSON.stringify({
    found: true,
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2),
    active: document.activeElement === el,
  });
})()`;
}

/** 确认结果：元素不在了，与「在，坐标与焦点是这个」两种形态 */
export type ConfirmOutcome =
  | { found: false }
  | { found: true; x: number; y: number; active: boolean };

/**
 * 解析 `confirmScript` 的返回值。
 *
 * 解析不出来一律当 `found: false`——调用方据此中止或重算。宁可白跑一次，
 * 也不能拿一个「看着没问题」的默认坐标继续点（那正是这套确认要防的事）。
 */
export function parseConfirmResult(raw: unknown): ConfirmOutcome {
  let parsed: { found?: unknown; x?: unknown; y?: unknown; active?: unknown };
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return { found: false };
  }
  if (parsed.found !== true || typeof parsed.x !== "number" || typeof parsed.y !== "number") {
    return { found: false };
  }
  return { found: true, x: parsed.x, y: parsed.y, active: parsed.active === true };
}

/**
 * 操作后的**归属提示**：把刚被操作的元素圈一下并标出是哪类动作，自消失。
 *
 * 为什么要有它：真实输入之后，页面会不会「动」取决于页面自己——有的按钮点下去毫无反馈，
 * 用户看到的只是「页面好像闪了一下」，分不清是 agent 干的还是自己误触。
 * 这个框回答的是**归属**问题（不是「有变化」——变化本来就看得见）。
 *
 * 几条必须守住的：
 *   - `pointer-events: none`：否则这个框会挡住它自己标的那个元素，下一次点击的命中测试
 *     会把它当成「遮挡者」——agent 被自己画的框挡住；
 *   - **先清上一个、再自己定时移除**：连续操作不能堆一屏框；
 *   - 不带 `data-colt-ref`、不在 snapshot 的交互元素集里：不污染 agent 自己的观测清单；
 *   - 挂在 `body` 下（而不是 `documentElement`）：`browser_read` 的 text 读的是 body 的
 *     innerText，挂那里才读得到——「刚才那一步是谁干的」对 agent 自己也应当是可见的。
 *
 * `target` 传 `null` 表示标**当前聚焦的元素**（`key` 动作没有 ref，它发给焦点）。
 */
export function highlightScript(target: string | null, label: string, durationMs = 1000): string {
  const lookup =
    target === null
      ? "document.activeElement"
      : `document.querySelector(${JSON.stringify(`[data-colt-ref="${target}"]`)})`;
  const fadeOutAt = Math.max(0, durationMs - 350);
  return `(() => {
  const ID = '__colt_agent_flash';
  const previous = document.getElementById(ID);
  if (previous) previous.remove();
  const el = ${lookup};
  if (!el || typeof el.getBoundingClientRect !== 'function') return false;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const host = document.body || document.documentElement;
  if (!host) return false;
  const box = document.createElement('div');
  box.id = ID;
  box.setAttribute('aria-hidden', 'true');
  box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;box-sizing:border-box;' +
    'border:2px solid #ff6d00;border-radius:3px;transition:opacity .35s ease-out;';
  box.style.left = (rect.left - 2) + 'px';
  box.style.top = (rect.top - 2) + 'px';
  box.style.width = (rect.width + 4) + 'px';
  box.style.height = (rect.height + 4) + 'px';
  const tag = document.createElement('div');
  tag.textContent = ${JSON.stringify(label)};
  tag.style.cssText = 'position:absolute;right:-2px;top:-18px;background:#ff6d00;color:#fff;' +
    'font:11px/16px monospace;padding:0 4px;border-radius:2px;white-space:nowrap;';
  box.appendChild(tag);
  host.appendChild(box);
  setTimeout(() => { box.style.opacity = '0'; }, ${fadeOutAt});
  setTimeout(() => { box.remove(); }, ${durationMs});
  return true;
})()`;
}

/**
 * 截图叠框：给页面上带 ref 的**可见**元素画边框 + ref 角标，画完返回叠了几个。
 * 与 SNAPSHOT_SCRIPT 用同一套可见性判据（框与清单一致，框多了只会误导）。
 * 覆盖层 pointer-events:none 不挡交互、用最大 z-index；元素本身不在交互元素
 * selector 里，不会被下一次 snapshot 收录。注入 → capturePage → 移除，全程不落盘。
 */
export const OVERLAY_SCRIPT = `(() => {
  const old = document.getElementById('__colt_overlay');
  if (old) old.remove();
  const vh = window.innerHeight || document.documentElement.clientHeight || 0;
  const limit = vh + 800;
  const box = document.createElement('div');
  box.id = '__colt_overlay';
  box.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
  for (const el of document.querySelectorAll('[data-colt-ref]')) {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (rect.bottom <= 0 || rect.top >= limit) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.visibility === 'collapse') continue;
    if (Number(style.opacity) <= 0) continue;
    const frame = document.createElement('div');
    frame.style.cssText = 'position:fixed;border:1.5px solid #e91e63;border-radius:3px;box-sizing:border-box;';
    frame.style.left = rect.left + 'px';
    frame.style.top = rect.top + 'px';
    frame.style.width = rect.width + 'px';
    frame.style.height = rect.height + 'px';
    const tag = document.createElement('div');
    tag.textContent = el.getAttribute('data-colt-ref');
    tag.style.cssText = 'position:absolute;left:0;top:-17px;background:#e91e63;color:#fff;font:11px/16px monospace;padding:0 3px;border-radius:2px;white-space:nowrap;';
    frame.appendChild(tag);
    box.appendChild(frame);
  }
  document.documentElement.appendChild(box);
  return box.childElementCount;
})()`;

/** 移除截图叠框（OVERLAY_SCRIPT 的收尾，截图完成后立即执行） */
export const OVERLAY_REMOVE_SCRIPT = `(() => {
  const old = document.getElementById('__colt_overlay');
  if (old) old.remove();
  return true;
})()`;
