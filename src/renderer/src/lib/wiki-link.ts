// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * wiki 页内链接的归一（纯函数，`tests/wiki-link.test.ts` 覆盖）。
 *
 * ## 为什么需要它
 *
 * 产物里的链接是**相对当前页**的，而且文件名常带空格与全角括号，于是 Markdown 里
 * 必须写成 `[文本](<模块（A）/子页.md>)`——尖括号是 Markdown 的转义写法，**解析器已剥掉**，
 * 拿到手的 `href` 是裸路径。渲染层要做的只有两件事：相对路径归一、以及拒绝跳出 wiki。
 *
 * 不做这三件事就会出人命：
 *   - 不剥 `#anchor`：锚点链接会被当成文件路径，跳转必 404；
 *   - 不解 `%xx`：react-markdown 对含空格的目标会给百分号编码，不解码就拼不出真路径；
 *   - 不校验前缀：`../../../etc/passwd.md` 这种会被原样送进 `wiki.page`，
 *     虽然主进程还有一道边界（`isWithinRoot`），但让坏输入走到那一步本身就不该。
 *
 * 归一不出来（外链 / 非 md / 越界）一律返回 `null`，由调用方按外链处理——
 * **不要**在这里猜一个「可能是对的」路径，那会变成点开一页却换到另一页。
 */
import { WIKI_DIR } from "@shared/wiki";

export function resolveWikiLink(fromPath: string, href: string): string | null {
  if (!fromPath.startsWith(`${WIKI_DIR}/`)) return null;
  // 带 scheme（`https:` / `mailto:` / `file:`）的一律当外链。**必须先挡**：
  // 否则 `https://x/a.md` 会被当成相对路径拼成 `docs/wiki/https:/x/a.md`——
  // 看上去通过了前缀校验，实际是一次必然失败的跳转（测试用例逮到过一次）。
  if (/^[a-z][a-z0-9+.-]*:/i.test(href.trim())) return null;
  let target = href.split("#")[0]?.trim() ?? "";
  if (target === "") return null;
  if (/%[0-9a-f]{2}/i.test(target)) {
    try {
      target = decodeURIComponent(target);
    } catch {
      return null;
    }
  }
  if (!target.toLowerCase().endsWith(".md")) return null;

  const base = fromPath.split("/").slice(0, -1);
  const segments = target.startsWith("/") ? target.slice(1).split("/") : [...base, ...target.split("/")];
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      // 已经在 wiki 根上再往上一级 = 越界，直接拒（不留一个「差一点就对」的半成品路径）
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  const path = out.join("/");
  return path.startsWith(`${WIKI_DIR}/`) ? path : null;
}
