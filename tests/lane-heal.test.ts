/**
 * 存量 lane 的工具清单愈合（`worker/lib/lane-heal.ts`）。
 *
 * 这一段的价值全在「**多出来的要删掉**」上：内核只在新建 lane 时套用 seed，
 * 存量会话沿用自己持久化的清单；而生成前会算
 * `activeToolNames.filter(n => !toolsByName.has(n))`，非空即以
 * `configured_tools_unavailable` 直接失败。MCP 工具由用户配置驱动、会消失，
 * 所以「清单里有、harness 已没有」不是理论情形——它会让那个会话**每一条消息都失败**。
 *
 * 用假 lane（只实现 get/setActiveTools）而不是真内核：这里验的是**决策**
 * （该不该写、写成什么），不是内核行为。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT, type AgentLane } from "@earendil-works/pi-agent-core";
import { healLaneTools } from "../src/worker/lib/lane-heal.ts";

/** 只实现愈合用到的两个方法；被测函数不碰 lane 的别的能力 */
function fakeLane(initial: string[]): {
  lane: AgentLane;
  writes: string[][];
  active: () => string[];
} {
  let active = [...initial];
  const writes: string[][] = [];
  const lane = {
    getActiveTools: async (): Promise<string[]> => [...active],
    setActiveTools: async (names: string[]): Promise<void> => {
      writes.push([...names]);
      active = [...names];
    },
  } as unknown as AgentLane;
  return { lane, writes, active: () => [...active] };
}

describe("存量 lane 的工具清单愈合", () => {
  test("既补新工具也对齐消失的工具（只补不删 ⇒ 每次生成都 configured_tools_unavailable）", async () => {
    const { lane, writes, active } = fakeLane(["read", "mcp__old__echo"]);
    await healLaneTools(lane, ["read", "write", "mcp__new__echo"], BACKGROUND_CONTEXT);
    assert.deepEqual(active(), ["read", "write", "mcp__new__echo"]);
    assert.equal(writes.length, 1);
  });

  test("集合相等时不写（`setActiveTools` 不等值短路，无条件调用会多出一条配置事件）", async () => {
    const { lane, writes } = fakeLane(["read", "write"]);
    await healLaneTools(lane, ["write", "read"], BACKGROUND_CONTEXT);
    assert.equal(writes.length, 0);
  });

  test("只多不少时也要写——这正是「MCP server 被删掉」那一支", async () => {
    const { lane, writes, active } = fakeLane(["read", "mcp__gone__x"]);
    await healLaneTools(lane, ["read"], BACKGROUND_CONTEXT);
    assert.deepEqual(active(), ["read"]);
    assert.equal(writes.length, 1);
  });
});
