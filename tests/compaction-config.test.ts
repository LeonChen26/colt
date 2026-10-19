/**
 * 压缩配置的钉子。
 *
 * 两件事必须钉住：
 *   ① **默认值必须与内核一致**——本模块刻意复写了内核的 `DEFAULT_COMPACTION_POLICY`
 *      而不是 import 它（渲染层不得依赖内核），所以「两边漂开」这件事必须有断言兜着，
 *      否则内核升级改了默认值、我们还照着老数字显示，用户看到的就是假的「当前生效值」。
 *      下面**真去读内核 dist 的常量**比对，不是再抄一遍数字。
 *   ② **钳制行为逐条钉住**——设置值来自输入框，可能是空串 / 负数 / 天文数字。
 *      「填了 -1，结果保留量变 0，每次压缩都清空上下文」这类事不该悄悄发生。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  COMPACTION_TOKENS_MAX,
  COMPACTION_TOKENS_MIN,
  DEFAULT_COMPACTION_CONFIG,
  describeCompaction,
  isDefaultCompactionConfig,
  normalizeCompactionConfig,
} from "../src/shared/compaction-config.ts";

describe("默认值与内核对齐（不是「抄一份」，是被断言钉住的副本）", () => {
  test("内核 DEFAULT_COMPACTION_POLICY 与本模块默认值逐字段相同", () => {
    // 直接读内核 dist 源码里的常量——内核不导出类型以外的运行时入口给渲染层，
    // 而单测跑在 node 里，读文件是最稳的比对方式（不引入 kernel 到渲染层的依赖）。
    const dist = fileURLToPath(
      new URL(
        "../node_modules/@earendil-works/pi-durable/dist/harness/agent.js",
        import.meta.url,
      ),
    );
    const source = readFileSync(dist, "utf8");
    const block = /DEFAULT_COMPACTION_POLICY\s*=\s*\{([^}]*)\}/.exec(source);
    assert.ok(block, "内核里找不到 DEFAULT_COMPACTION_POLICY，断言需要跟着更新（不是删掉）");
    const body = block[1]!;
    const readNumber = (key: string): number => {
      const m = new RegExp(`${key}\\s*:\\s*([0-9_]+)`).exec(body);
      assert.ok(m, `内核默认值里没有 ${key}`);
      return Number(m[1]!.replaceAll("_", ""));
    };
    assert.match(body, /enabled\s*:\s*true/, "内核默认已开启自动压缩（A2 的前提）");
    assert.equal(DEFAULT_COMPACTION_CONFIG.enabled, true);
    assert.equal(DEFAULT_COMPACTION_CONFIG.reserveTokens, readNumber("reserveTokens"));
    assert.equal(DEFAULT_COMPACTION_CONFIG.keepRecentTokens, readNumber("keepRecentTokens"));
    assert.equal(DEFAULT_COMPACTION_CONFIG.backgroundTokens, readNumber("backgroundTokens"));
  });
});

describe("normalizeCompactionConfig：钳制与回落", () => {
  test("合法输入原样通过", () => {
    assert.deepEqual(
      normalizeCompactionConfig({ enabled: true, reserveTokens: 8000, keepRecentTokens: 30000 }),
      {
        enabled: true,
        reserveTokens: 8000,
        keepRecentTokens: 30000,
        backgroundTokens: DEFAULT_COMPACTION_CONFIG.backgroundTokens,
      },
    );
  });

  test("enabled 只认布尔 true（其余一律 false，这一项故意不猜）", () => {
    for (const value of ["true", 1, "yes", null, undefined, {}]) {
      assert.equal(
        normalizeCompactionConfig({ enabled: value }).enabled,
        false,
        `enabled=${JSON.stringify(value)} 不该被当成开启`,
      );
    }
    assert.equal(normalizeCompactionConfig({ enabled: true }).enabled, true);
  });

  test("越界被钳到区间端点，而不是 0 或原样放过", () => {
    const low = normalizeCompactionConfig({ reserveTokens: -1, keepRecentTokens: 0 });
    assert.equal(low.reserveTokens, COMPACTION_TOKENS_MIN);
    assert.equal(low.keepRecentTokens, COMPACTION_TOKENS_MIN);
    const high = normalizeCompactionConfig({ reserveTokens: 9e15, keepRecentTokens: 5e6 });
    assert.equal(high.reserveTokens, COMPACTION_TOKENS_MAX);
    assert.equal(high.keepRecentTokens, COMPACTION_TOKENS_MAX);
  });

  test("非数字 / 空串 / NaN / 小数 → 回落默认值或取整，绝不产生 NaN", () => {
    assert.equal(normalizeCompactionConfig({ reserveTokens: "" }).reserveTokens, DEFAULT_COMPACTION_CONFIG.reserveTokens);
    assert.equal(normalizeCompactionConfig({ reserveTokens: "abc" }).reserveTokens, DEFAULT_COMPACTION_CONFIG.reserveTokens);
    assert.equal(normalizeCompactionConfig({ reserveTokens: Number.NaN }).reserveTokens, DEFAULT_COMPACTION_CONFIG.reserveTokens);
    assert.equal(normalizeCompactionConfig({ reserveTokens: Number.POSITIVE_INFINITY }).reserveTokens, DEFAULT_COMPACTION_CONFIG.reserveTokens);
    // 小数取整（向下）——不是四舍五入，避免「看起来调小了实际变大」
    assert.equal(normalizeCompactionConfig({ reserveTokens: 5000.9 }).reserveTokens, 5000);
  });

  test("字段缺失各自独立回落（缺一个不影响另一个）", () => {
    const onlyEnabled = normalizeCompactionConfig({ enabled: true });
    assert.equal(onlyEnabled.reserveTokens, DEFAULT_COMPACTION_CONFIG.reserveTokens);
    assert.equal(onlyEnabled.keepRecentTokens, DEFAULT_COMPACTION_CONFIG.keepRecentTokens);
  });

  test("backgroundTokens：0 是合法的「关闭」值，负值回落默认", () => {
    assert.equal(normalizeCompactionConfig({ backgroundTokens: 0 }).backgroundTokens, 0);
    assert.equal(
      normalizeCompactionConfig({ backgroundTokens: -1 }).backgroundTokens,
      DEFAULT_COMPACTION_CONFIG.backgroundTokens,
    );
    assert.equal(
      normalizeCompactionConfig({ backgroundTokens: "abc" }).backgroundTokens,
      DEFAULT_COMPACTION_CONFIG.backgroundTokens,
    );
  });

  test("非对象输入不抛错，得到默认配置", () => {
    for (const value of [null, undefined, 42, "x", []]) {
      const config = normalizeCompactionConfig(value);
      assert.equal(config.reserveTokens, DEFAULT_COMPACTION_CONFIG.reserveTokens);
      assert.equal(config.keepRecentTokens, DEFAULT_COMPACTION_CONFIG.keepRecentTokens);
    }
  });

  test("归一化是幂等的（第二次输入第一次的输出不变）", () => {
    const once = normalizeCompactionConfig({ enabled: true, reserveTokens: -5 });
    assert.deepEqual(normalizeCompactionConfig(once), once);
  });
});

describe("默认配置必须**不可变**（它会被多方共享同一引用）", () => {
  test("改它会当场抛错，而不是静默改掉进程级默认值", () => {
    // `CompactionConfig` 的字段是可变的，而这个常量被 `main/compaction-config.ts` 的
    // 未配置 / 坏值两条路径**直接返回**（同一个引用给到不同调用方）。不冻结的话，
    // 任何一处 `config.reserveTokens = 0` 都会改掉全局默认——连 `isDefaultCompactionConfig`
    // 的判断都会跟着一起变，静默且难查。冻结把这类写法变成立刻报错。
    assert.ok(Object.isFrozen(DEFAULT_COMPACTION_CONFIG));
    assert.throws(() => {
      (DEFAULT_COMPACTION_CONFIG as { reserveTokens: number }).reserveTokens = 0;
    }, "写入冻结对象应当抛错（ESM 严格模式）");
    // 抛过之后默认值仍然是对的
    assert.equal(DEFAULT_COMPACTION_CONFIG.reserveTokens, 16384);
  });

  test("归一化不会就地改默认值（它建的永远是新对象）", () => {
    const before = { ...DEFAULT_COMPACTION_CONFIG };
    normalizeCompactionConfig({ enabled: false, reserveTokens: -1 });
    assert.deepEqual({ ...DEFAULT_COMPACTION_CONFIG }, before);
  });
});

describe("isDefaultCompactionConfig / describeCompaction", () => {
  test("默认配置被认出是默认", () => {
    assert.equal(isDefaultCompactionConfig(DEFAULT_COMPACTION_CONFIG), true);
    assert.equal(isDefaultCompactionConfig({ ...DEFAULT_COMPACTION_CONFIG, enabled: false }), false);
    assert.equal(isDefaultCompactionConfig({ ...DEFAULT_COMPACTION_CONFIG, keepRecentTokens: 1 }), false);
  });

  test("关闭时的说明要提「手动 /compact 仍可用」", () => {
    const text = describeCompaction({ ...DEFAULT_COMPACTION_CONFIG, enabled: false });
    assert.match(text, /已关闭/);
    assert.match(text, /\/compact/, "不写这一句，用户会以为压缩整个没了");
  });

  test("开启时把两个阈值都说出来（可见性正是 A2 要的）", () => {
    const text = describeCompaction({
      enabled: true,
      reserveTokens: 4096,
      keepRecentTokens: 9000,
      backgroundTokens: 0,
    });
    assert.match(text, /9000/);
    assert.match(text, /4096/);
  });
});
