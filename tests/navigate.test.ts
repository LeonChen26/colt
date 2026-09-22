/**
 * `navigate` 命令决策部分的单测（`src/worker/lib/navigate.ts`）。
 *
 * 为什么值得单独钉：这段逻辑原来是 `worker/entry.ts` 里的一小段 `case "navigate"`，
 * 而 worker 入口一 import 就会把进程引导跑起来，所以它此前**没有任何断言**——
 * 分支能力从界面（左栏那棵树）搬进会话区之后，「从这里分叉」成了它唯一的界面调用方，
 * 这里判错的代价更大了：
 * - **放行子 lane 的节点** → 主对话的历史指针被挪到子代理/整理的链上，
 *   而界面上没有任何东西能解释这次跳转（`docs/DESIGN-subagents.md` 决策六 D10）；
 * - **顺序反了**（先重拍快照、后挪指针）→ 推给界面的是跳转**之前**的快照，看着像「点了没反应」；
 * - **失败被吞成成功** → 界面拿到一份假的新状态。
 * 所以既要「拒绝时不碰真实现」，也要「放行时 id 原样、顺序正确、异常照抛」。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { applyNavigate, type NavigateDeps } from "../src/worker/lib/navigate.ts";

/** 假依赖 + 调用流水。`calls` 是完整序列，用来钉顺序，而不只是「调没调过」。 */
function harness(foreign: readonly string[], options: { throwOnNavigate?: boolean } = {}): {
  deps: NavigateDeps<string>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      foreignLaneEntryIds: async () => {
        calls.push("foreignLaneEntryIds");
        return new Set(foreign);
      },
      navigateTree: async (targetId) => {
        calls.push(`navigateTree:${targetId}`);
        if (options.throwOnNavigate === true) throw new Error("内核拒绝了这个节点");
      },
      resnapshot: async () => {
        calls.push("resnapshot");
        return "snapshot-after-navigate";
      },
    },
  };
}

describe("applyNavigate", () => {
  const TARGET = "entry-main-7";

  test("目标属于子 lane：拒绝，且一次都不碰 navigateTree / resnapshot", async () => {
    const { deps, calls } = harness([TARGET]);
    const outcome = await applyNavigate(TARGET, deps);
    assert.equal(outcome.ok, false);
    // 关键不是「返回了 false」，而是**没去改会话**：守卫的全部意义就在这里
    assert.deepEqual(calls, ["foreignLaneEntryIds"]);
  });

  test("对照：同一个 id，只要不在子 lane 集合里就放行——决定结果的是那个集合", async () => {
    const { deps } = harness(["entry-sub-9"]);
    const outcome = await applyNavigate(TARGET, deps);
    assert.equal(outcome.ok, true);
  });

  test("放行时：id 原样交给 navigateTree（不 trim、不截断），并回传新快照", async () => {
    const id = "entry-with spaces-0001";
    const { deps, calls } = harness([]);
    const outcome = await applyNavigate(id, deps);
    assert.deepEqual(calls, ["foreignLaneEntryIds", `navigateTree:${id}`, "resnapshot"]);
    assert.deepEqual(outcome, { ok: true, snapshot: "snapshot-after-navigate" });
  });

  test("顺序：先挪指针、后重拍快照（反了就是拿跳转前的快照当新状态）", async () => {
    const { deps, calls } = harness([]);
    await applyNavigate(TARGET, deps);
    assert.ok(
      calls.indexOf(`navigateTree:${TARGET}`) < calls.indexOf("resnapshot"),
      `快照必须拍在指针挪动之后，实际序列：${calls.join(" → ")}`,
    );
  });

  test("navigateTree 抛错：原样抛出，且不重拍快照（不把旧状态当新状态）", async () => {
    const { deps, calls } = harness([], { throwOnNavigate: true });
    await assert.rejects(() => applyNavigate(TARGET, deps), /内核拒绝了这个节点/);
    assert.equal(calls.includes("resnapshot"), false);
  });

  test("拒绝时给的是**人能读**的提示，不是异常、不是空串", async () => {
    const { deps } = harness([TARGET]);
    const outcome = await applyNavigate(TARGET, deps);
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.ok(outcome.message.length > 0);
    // 用户要能看懂「为什么不能切」，而不是只看到一个代号
    assert.ok(outcome.message.includes("子代理"), outcome.message);
  });
});
