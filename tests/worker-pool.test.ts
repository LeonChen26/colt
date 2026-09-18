/**
 * worker 池两条**纯**决策的单测：空闲回收该收谁（`reapTargets`）、池满淘汰谁（`evictionVictim`）。
 *
 * 为什么要单独测：回收器是「60 秒一跳、超时 30 分钟」，冒烟里根本等不到那个时刻——
 * 「钉住到底拦不拦得住」用冒烟验不了。把规则剥成纯函数后就能在这里钉死。
 *
 * 重点盯的是**钉住**这条：
 *   · 空闲回收**跳过**钉住的（不管它闲置了多久）；
 *   · 池满淘汰时钉住的**最后**才动（不是「绝不」——全钉住还得让出一条，否则新会话开不出来）。
 * 每条都配一个「把 isPinned 换成恒假 / 恒真」的对照，防止断言**空转**：
 * 若某个用例里的钉住判断其实没被读到，换成恒假结果也照样过，那它就什么都没守住。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { evictionVictim, reapTargets, type PoolEntry } from "../src/main/worker-pool.ts";

const MIN = 60 * 1000;
const TIMEOUT = 30 * MIN;

const neverPinned = (): boolean => false;
const alwaysPinned = (): boolean => true;

/** 造一条池内记录：默认「未运行、刚活动过」 */
function entry(sessionId: string, over: Partial<PoolEntry> = {}): PoolEntry {
  return { sessionId, running: false, lastActiveAt: 0, ...over };
}

describe("reapTargets：空闲回收该收谁", () => {
  test("未运行 + 未钉住 + 已超时 → 回收", () => {
    const entries = [entry("a", { lastActiveAt: 0 })];
    assert.deepEqual(reapTargets(entries, TIMEOUT + 1, TIMEOUT, neverPinned), ["a"]);
  });

  test("未运行 + 未钉住 + 尚未超时 → 不回收", () => {
    const entries = [entry("a", { lastActiveAt: 0 })];
    assert.deepEqual(reapTargets(entries, TIMEOUT - 1, TIMEOUT, neverPinned), []);
  });

  test("正好等于超时阈值 → 不回收（判据是「超过」，不是「达到」）", () => {
    const entries = [entry("a", { lastActiveAt: 0 })];
    assert.deepEqual(reapTargets(entries, TIMEOUT, TIMEOUT, neverPinned), []);
  });

  test("运行中 → 不回收（哪怕闲置很久、也没钉住）", () => {
    const entries = [entry("a", { running: true, lastActiveAt: 0 })];
    assert.deepEqual(reapTargets(entries, TIMEOUT * 10, TIMEOUT, neverPinned), []);
  });

  test("钉住 → 不回收（哪怕闲置远超阈值）——这条是本功能的根", () => {
    const entries = [entry("pinned", { lastActiveAt: 0 })];
    assert.deepEqual(reapTargets(entries, TIMEOUT * 100, TIMEOUT, alwaysPinned), []);
  });

  test("混合：只收回未钉住且超时的那些", () => {
    const entries = [
      entry("keep-pinned", { lastActiveAt: 0 }),
      entry("reap-idle", { lastActiveAt: 0 }),
      entry("keep-busy", { running: true, lastActiveAt: 0 }),
      entry("keep-fresh", { lastActiveAt: TIMEOUT + 1 }),
    ];
    const isPinned = (id: string): boolean => id === "keep-pinned";
    assert.deepEqual(reapTargets(entries, TIMEOUT + 2, TIMEOUT, isPinned), ["reap-idle"]);
  });

  test("对照：isPinned 换成恒假，同一份数据就会连钉住的一起收——证明这条判断真的被读到了", () => {
    const entries = [entry("pinned", { lastActiveAt: 0 })];
    assert.deepEqual(reapTargets(entries, TIMEOUT + 1, TIMEOUT, alwaysPinned), []);
    assert.deepEqual(reapTargets(entries, TIMEOUT + 1, TIMEOUT, neverPinned), ["pinned"]);
  });
});

describe("evictionVictim：池满淘汰谁", () => {
  test("只在未运行的里挑，且挑最久未活动的", () => {
    const entries = [
      entry("a", { lastActiveAt: 500 }),
      entry("b", { lastActiveAt: 100 }),
      entry("busy", { running: true, lastActiveAt: 0 }),
    ];
    assert.equal(evictionVictim(entries, neverPinned), "b");
  });

  test("未钉住的优先被动：哪怕钉住的那条更久未活动", () => {
    const entries = [
      entry("pinned-oldest", { lastActiveAt: 0 }),
      entry("free-newer", { lastActiveAt: 900 }),
    ];
    const isPinned = (id: string): boolean => id === "pinned-oldest";
    assert.equal(evictionVictim(entries, isPinned), "free-newer");
  });

  test("只剩钉住的空闲会话时仍要给出一个（否则新会话永远开不出来，成了死锁）", () => {
    const entries = [
      entry("p1", { lastActiveAt: 0 }),
      entry("p2", { lastActiveAt: 700 }),
    ];
    assert.equal(evictionVictim(entries, alwaysPinned), "p1");
  });

  test("一条空闲的都没有（全在跑）→ undefined，由调用方如实报「并发已达上限」", () => {
    const entries = [entry("a", { running: true }), entry("b", { running: true })];
    assert.equal(evictionVictim(entries, neverPinned), undefined);
  });

  test("空池 → undefined", () => {
    assert.equal(evictionVictim([], neverPinned), undefined);
  });

  test("对照：isPinned 换成恒假，最久未活动的那条（包括钉住的）就会被淘汰——证明排序键真的用了钉住", () => {
    const entries = [
      entry("pinned-oldest", { lastActiveAt: 0 }),
      entry("free-newer", { lastActiveAt: 900 }),
    ];
    const isPinned = (id: string): boolean => id === "pinned-oldest";
    assert.equal(evictionVictim(entries, neverPinned), "pinned-oldest");
    assert.equal(evictionVictim(entries, isPinned), "free-newer");
  });
});
