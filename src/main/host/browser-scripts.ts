/**
 * 注入页面的脚本：snapshot 清单、内容宽度测量、点击 / 输入。
 *
 * 从 `browser-host.ts` 搬出来的（那个文件卡在体量闸上，加功能必须同时搬走等量旧代码）。
 * 这几段**自成一体**：纯字符串常量与纯函数，不碰任何宿主状态，搬移前后行为逐字不变。
 * 只有 `browser-host.ts` 用它们（`snapshot` / `#refreshContentFit` / `click` / `type`）。
 */

/** 页面内取可交互元素：给每个元素打稳定 ref，返回一段人类/模型可读的清单 */
export const SNAPSHOT_SCRIPT = `(() => {
  const selector = 'a,button,input,select,textarea,[role="button"],[role="link"],[contenteditable="true"]';
  const nodes = Array.from(document.querySelectorAll(selector)).slice(0, 200);
  let seq = Number(window.__coltRefSeq || 0);
  const lines = nodes.map((el) => {
    let ref = el.getAttribute('data-colt-ref');
    if (!ref) { seq += 1; ref = 'e' + seq; el.setAttribute('data-colt-ref', ref); }
    const raw = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.innerText || el.value || '';
    const name = String(raw).replace(/\\s+/g, ' ').trim().slice(0, 80);
    const role = el.getAttribute('role') || el.tagName.toLowerCase();
    return '[' + ref + '] ' + role + ' "' + name + '"';
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
