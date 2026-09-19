/**
 * 「哪些条目属于子 lane」的纯函数测试（`src/worker/lib/lane-ownership.ts`）。
 *
 * 这层判错的方向是**不对称**的：
 * - 多排除（误伤主对话的条目）→ 左栏分支树凭空少掉几个真实节点，且**没人会立刻发现**；
 * - 少排除（子 lane 的条目留在树里）→ 多出一个可点的根节点，一点就把主 lane 的历史指针
 *   挪到子代理/整理的链上（`docs/DESIGN-subagents.md` 决策六 D10）。
 * 所以既要有「整合条子链被排除」，也要有「主对话条目一条都不误伤」。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  foreignLaneTips,
  ownedEntries,
  visibleEntries,
  type OwnershipEntry,
} from "../src/worker/lib/lane-ownership.ts";

const entry = (id: string, parentId: string | null): OwnershipEntry => ({ id, parentId });

/** 主对话的一条链：m1 → m2 → m3（m1 是根） */
const MAIN_CHAIN: OwnershipEntry[] = [
  entry("m1", null),
  entry("m2", "m1"),
  entry("m3", "m2"),
];

describe("ownedEntries：fresh 子链整条被排除", () => {
  test("从子 lane 的 tip 上溯，整条链都是它的", () => {
    const entries = [...MAIN_CHAIN, entry("s1", null), entry("s2", "s1")];
    const owned = ownedEntries(["s2"], entries);
    assert.deepEqual([...owned].sort(), ["s1", "s2"]);
  });

  test("子链与主链并存时，主对话条目一条都不误伤", () => {
    const entries = [...MAIN_CHAIN, entry("s1", null), entry("s2", "s1")];
    const owned = ownedEntries(["s2"], entries);
    const visible = visibleEntries(entries, owned).map((item) => item.id);
    assert.deepEqual(visible, ["m1", "m2", "m3"]);
  });

  test("多个子代理并存：各自那条链都要收集", () => {
    const entries = [
      ...MAIN_CHAIN,
      entry("a1", null),
      entry("a2", "a1"),
      entry("b1", null),
      entry("b2", "b1"),
    ];
    const owned = ownedEntries(["a2", "b2"], entries);
    assert.deepEqual([...owned].sort(), ["a1", "a2", "b1", "b2"]);
  });

  test("主 lane 的 tip 传成 null（空会话）时不排除任何东西", () => {
    assert.equal(ownedEntries([null, undefined], MAIN_CHAIN).size, 0);
  });

  test("未知 tip 直接跳过（不抛、也不误伤）", () => {
    assert.equal(ownedEntries(["ghost"], MAIN_CHAIN).size, 0);
  });

  test("parentId 成环时能停（不写坏就死循环，界面上表现为左栏一直转圈）", () => {
    // a ← b ← a：上溯必须靠「已收集过就不再走」终止
    const entries = [entry("a", "b"), entry("b", "a")];
    const owned = ownedEntries(["a"], entries);
    assert.deepEqual([...owned].sort(), ["a", "b"]);
  });

  test("tip 为空数组时不做任何事", () => {
    assert.equal(ownedEntries([], MAIN_CHAIN).size, 0);
  });
});

describe("visibleEntries：排除是唯一写法（树与导航守卫共用）", () => {
  test("保持原顺序，只去掉集合里的条目", () => {
    const entries = [...MAIN_CHAIN, entry("s1", null)];
    const visible = visibleEntries(entries, new Set(["m2", "s1"]));
    assert.deepEqual(visible.map((item) => item.id), ["m1", "m3"]);
  });

  test("空集合时原样返回", () => {
    assert.deepEqual(visibleEntries(MAIN_CHAIN, new Set()), MAIN_CHAIN);
  });
});

describe("foreignLaneTips：非主 lane 的 tip", () => {
  test("按 lane 名排除主 lane，其余取 tipId", () => {
    const lanes = [
      { name: "main", tipId: "m3" },
      { name: "memory-tidy", tipId: "t1" },
      { name: "sub:researcher:abcd1234", tipId: null },
    ];
    assert.deepEqual(foreignLaneTips(lanes, "main"), ["t1", null]);
  });

  test("只有主 lane 时返回空数组", () => {
    assert.deepEqual(foreignLaneTips([{ name: "main", tipId: "m1" }], "main"), []);
  });
});
