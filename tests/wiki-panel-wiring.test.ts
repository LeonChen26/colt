/**
 * Wiki 生成在渲染层的**接线**（源码契约）。
 *
 * 行为已经在 `wiki-runner.test.ts` 里按注入的假进程验过；这里只守「面板真的把三个通道
 * 与进度事件接上了」——这类缺口（协议声明了、主进程也实现了，界面却从不调用）在
 * 类型检查与行为单测里都是绿的，只有真起应用才发现按钮点了没反应。
 *
 * 读源码文本而不是 import：`WikiPanel.tsx` 依赖 `window.colt` 与 React 运行时，
 * 与 `contract.test.ts` / `compaction-wiring.test.ts` 同一套折衷。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PANEL = readFileSync(
  fileURLToPath(
    new URL(
      "../src/renderer/src/features/Conversation/panels/WikiPanel.tsx",
      import.meta.url,
    ),
  ),
  "utf8",
);
const SHELL = readFileSync(
  fileURLToPath(
    new URL(
      "../src/renderer/src/features/Conversation/panels/SidePanelShell.tsx",
      import.meta.url,
    ),
  ),
  "utf8",
);

describe("Wiki 生成接线（源码契约）", () => {
  test("三个通道都被面板调用过（没有声明了却没人用的死通道）", () => {
    for (const channel of [
      "wiki.generate.start",
      "wiki.generate.cancel",
      "wiki.generate.status",
    ]) {
      assert.ok(
        PANEL.includes(`"${channel}"`),
        `WikiPanel 没有调用 ${channel}——协议与主进程实现了也没人用`,
      );
    }
  });

  test("订阅进度事件，并在终态重读产物", () => {
    assert.ok(
      PANEL.includes('colt.on("wiki.generateState"'),
      "没有订阅 wiki.generateState——进度永远停在第一帧",
    );
    // 终态（done / failed / cancelled）后要重新读 wiki.status，摘要条才会更新
    assert.match(
      PANEL,
      /event\.phase !== "running"[\s\S]{0,120}loadStatus\(\)/,
      "终态后没有重读产物：成功不会刷新页数，取消也看不到半成品",
    );
  });

  test("启动前必须经过原生确认框（会花额度、改工作区）", () => {
    const confirmAt = PANEL.indexOf('invoke("dialog.confirm"');
    const startAt = PANEL.indexOf('invoke("wiki.generate.start"');
    assert.notEqual(confirmAt, -1, "没有原生确认框");
    assert.notEqual(startAt, -1, "没有调用 wiki.generate.start");
    assert.ok(confirmAt < startAt, "确认必须排在启动之前——点一下就开跑是错的");
  });

  test("启动失败走外壳的 error 位（空态时 children 不渲染，放里面会看不见）", () => {
    assert.match(
      PANEL,
      /error=\{startError \?\? error\}/,
      "启动失败（缺 Python / 缺 git / spawn 失败）必须经外壳的 error 位显示",
    );
  });

  test("外壳给面板留了动作插槽，且「刷新」仍固定在最右", () => {
    assert.match(SHELL, /actions\?: ReactNode/, "SidePanelShell 没有 actions 插槽");
    assert.match(
      SHELL,
      /\{actions\}[\s\S]{0,300}title="刷新"/,
      "动作应排在刷新左侧，刷新固定在最右",
    );
  });
});
