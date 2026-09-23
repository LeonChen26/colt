// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 注入页面的脚本：snapshot 清单、内容宽度测量、点击 / 输入。
 *
 * 从 `browser-host.ts` 搬出来的（那个文件卡在体量闸上，加功能必须同时搬走等量旧代码）。
 * 这几段**自成一体**：纯字符串常量与纯函数，不碰任何宿主状态，搬移前后行为逐字不变。
 * 只有 `browser-host.ts` 用它们（`snapshot` / `#refreshContentFit` / `click` / `type`）。
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
 * 被遮挡（z-index 盖住）不判：每元素一次 hit test 太贵，且 ref 点击本身有「找不到」兜底。
 *
 * 新元素标记：本页（本次导航生命周期内）**首次**进入清单的 ref 前缀 `*[`，其余仍是 `[`。
 * 模型滚动 / 翻页后重新 snapshot，一眼可辨哪些是新出现的（借鉴 browser-use）。
 * 记忆存 window.__coltSeenRefs（Set），随导航重置——新页面首个 snapshot 全部带 `*[` 是预期。
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
  let seq = Number(window.__coltRefSeq || 0);
  let seen = window.__coltSeenRefs;
  if (!(seen instanceof Set)) { seen = new Set(); window.__coltSeenRefs = seen; }
  const lines = visible.map((el) => {
    let ref = el.getAttribute('data-colt-ref');
    if (!ref) { seq += 1; ref = 'e' + seq; el.setAttribute('data-colt-ref', ref); }
    const fresh = !seen.has(ref);
    seen.add(ref);
    const raw = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.innerText || el.value || '';
    const name = String(raw).replace(/\\s+/g, ' ').trim().slice(0, 80);
    const role = el.getAttribute('role') || el.tagName.toLowerCase();
    return (fresh ? '*[' : '[') + ref + '] ' + role + ' "' + name + '"';
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

export function clickScript(ref: string): string {
  const selector = JSON.stringify(`[data-colt-ref="${ref}"]`);
  return `(() => {
    const el = document.querySelector(${selector});
    if (!el) return '未找到元素 ${ref}，请重新执行 snapshot';
    el.scrollIntoView({ block: 'center' });
    if (typeof el.click === 'function') el.click();
    else el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return '已点击 ${ref}';
  })()`;
}

export function typeScript(ref: string, text: string): string {
  const selector = JSON.stringify(`[data-colt-ref="${ref}"]`);
  const value = JSON.stringify(text);
  return `(() => {
    const el = document.querySelector(${selector});
    if (!el) return '未找到元素 ${ref}，请重新执行 snapshot';
    el.focus();
    if ('value' in el) {
      el.value = ${value};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      el.textContent = ${value};
    }
    return '已输入到 ${ref}';
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
