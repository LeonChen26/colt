/**
 * 图标规范的测试（`src/renderer/src/lib/icon.ts`）。
 *
 * 这个模块本身是一张常量表，所以只说「表里的值等于表里的值」是没有意义的同义反复。
 * 它真正守住的是两件事：
 *
 * 1. **档位表内部自洽**：四档共用同一描边、尺寸严格递增。这几项都是手工逐条写下的，
 *    漏写 `strokeWidth` 会退回 lucide 默认的 2（文件头写明：小尺寸下会显脏），
 *    复制粘贴则会写出两档同尺寸——两种错在界面上都只表现为「有点不齐」，没人会报 bug。
 *
 * 2. **尺寸不许绕过这张表**：文件头的原话是「避免各处散落 size={11/12/13/14/16} 造成视觉不齐」。
 *    也就是说「散落写死尺寸」是这个模块诞生前的**真实前史**，不是假想的风险。
 *    下面第二条 describe 就按契约测试（`contract.test.ts`）的做法**读源码文本**，
 *    断言 lucide 图标一律走 `ICON.*`。当前全仓零违反，故这是一道防回退的守卫，不是修 bug。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { ICON, ICON_STROKE } from "../src/renderer/src/lib/icon.ts";

/** 档位顺序即 `ICON` 的书写顺序；尺寸必须按这个顺序严格递增 */
const TIERS = ["xs", "sm", "md", "lg"] as const;

describe("ICON 档位表", () => {
  test("四档尺寸与设计文档一致（11/13/14/16）", () => {
    // 改这几个数就等于改版式规范，应同时更新 docs/UI-DESIGN-v3.md；
    // 让这里的失败充当那次同步的提醒。
    assert.deepEqual(
      TIERS.map((tier) => ICON[tier].size),
      [11, 13, 14, 16],
    );
  });

  test("尺寸严格递增且互不相同（防止复制粘贴写出两档同尺寸）", () => {
    const sizes = TIERS.map((tier) => ICON[tier].size);
    for (let i = 1; i < sizes.length; i += 1) {
      assert.ok(sizes[i]! > sizes[i - 1]!, `${TIERS[i]} 不比 ${TIERS[i - 1]} 大：${sizes.join("/")}`);
    }
  });

  test("每一档都显式写了描边，且四档一致", () => {
    for (const tier of TIERS) {
      assert.equal(ICON[tier].strokeWidth, ICON_STROKE, `${tier} 档描边与统一值不一致`);
    }
    // 1.75 是设计要求（lucide 默认 2 偏粗）。若有人把它改成 2，等于悄悄放弃这条规则。
    assert.notEqual(ICON_STROKE, 2, "描边被改回了 lucide 默认值");
  });
});

describe("尺寸不许绕过档位表（读源码守卫）", () => {
  const SRC_ROOT = fileURLToPath(new URL("../src/renderer/src/", import.meta.url));

  /** 收集渲染层全部 .ts/.tsx 文件（绝对路径） */
  function rendererFiles(): string[] {
    return readdirSync(SRC_ROOT, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
      .map((entry) => join(entry.parentPath, entry.name));
  }

  /**
   * 该文件里从 lucide-react 引入的组件**本地名**（含 `X as Y` 的别名侧）。
   * 只认 lucide 的组件，是因为「写死尺寸」这条约定只约束图标；
   * 别的组件（如自己写的 Badge）有自己的 size 语义，不该被这条守卫牵连。
   *
   * 捕获组必须是 `[^{}]*`：`[\s\S]*?` 会从文件里**第一条** `import {` 起匹配，
   * 惰性扩展一路吞到 lucide 那条（实测就是这样把 React 的 import 也吞进来，
   * 得到 `useState } from "react";…import { Brain` 这种名字，于是 `<Brain>` 永不匹配，
   * 守卫静默空转）。import 列表里不可能出现花括号，用 `[^{}]*` 才是准确的边界。
   */
  function lucideLocalNames(text: string): string[] {
    const names: string[] = [];
    for (const match of text.matchAll(/import\s*\{([^{}]*)\}\s*from\s*"lucide-react"/g)) {
      for (const item of match[1]!.split(",")) {
        const [imported, local] = item.split(/\s+as\s+/);
        const name = (local ?? imported ?? "").trim();
        if (name.length > 0) names.push(name);
      }
    }
    return names;
  }

  test("导入解析：前一条 import 不会被吞进来（本次实测踩到的空转原因）", () => {
    const snippet = [
      'import { useCallback, useState } from "react";',
      'import { Brain, Image as ImageIcon } from "lucide-react";',
      "",
      "<Brain {...ICON.xs} />",
    ].join("\n");
    assert.deepEqual(lucideLocalNames(snippet), ["Brain", "ImageIcon"]);
  });

  test("导入解析：跨行的 import 列表也要认出来", () => {
    const snippet = 'import {\n  ChevronLeft,\n  FileText,\n} from "lucide-react";';
    assert.deepEqual(lucideLocalNames(snippet), ["ChevronLeft", "FileText"]);
  });

  test("lucide 图标一律用 ICON.*，没有写死的 size / strokeWidth", () => {
    const violations: string[] = [];
    let iconUsages = 0;

    for (const file of rendererFiles()) {
      const text = readFileSync(file, "utf8");
      for (const name of lucideLocalNames(text)) {
        // 属性段限定长度，避免 `=>` 这类含 `>` 的属性把匹配拖进无关代码
        for (const tag of text.matchAll(new RegExp(`<${name}\\b([^>]{0,300})>`, "g"))) {
          iconUsages += 1;
          const attrs = tag[1]!;
          if (/\bsize=\{\s*\d/.test(attrs) || /\bsize="\d/.test(attrs)) {
            violations.push(`${file}: <${name}> 写死了 size：${attrs.trim()}`);
          }
          if (/\bstrokeWidth=/.test(attrs)) {
            violations.push(`${file}: <${name}> 单独指定了 strokeWidth：${attrs.trim()}`);
          }
        }
      }
    }

    assert.deepEqual(violations, [], "图标尺寸应走 ICON.*（见 icon.ts 文件头）");
    // 扫描本身必须真的扫到东西，否则「零违反」只是空转
    assert.ok(iconUsages > 0, "没有扫到任何 lucide 图标用法，守卫已空转");
  });
});
