// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 自动压缩（compaction）的可配置项——**压缩从「吃内核默认值」变成用户可见可调**的唯一真源。
 *
 * ## 背景
 *
 * 自动压缩一直是**开着**的：`entry.ts` 从没给内核传过 `compaction`，于是内核用它自己的
 * `DEFAULT_COMPACTION_POLICY`（`enabled: true / reserveTokens: 16384 / keepRecentTokens: 20000 /
 * backgroundTokens: 32768`）。应用层对此**零感知**：阈值不可见、不可调，界面只能在压缩触发时靠
 * `runningOperation` 猜（2026-10-11 架构评审 A2）。
 *
 * ## 与内核的关系
 *
 * 内核类型是 `CompactionPolicy = { enabled, reserveTokens, keepRecentTokens, backgroundTokens }`
 * （`pi-durable` 的 `harness/types.d.ts`）。本模块的 `CompactionConfig` **与之逐字段同形**，
 * 这样跨进程传的就是内核能直接吃的形状，不必在 worker 里再映射一层——映射层是最容易
 * 在升级时漂开的地方（多一层就多一处要跟）。
 *
 * `backgroundTokens` 是切到 durable 后新增的能力：离阻塞阈值还差这么多 token 时，
 * 内核**在后台开始摘要**，当前对话继续跑；`0` 表示关闭（只在阻塞阈值处压缩）。
 * 默认值 32768 取自内核 `DEFAULT_COMPACTION_POLICY`——对上下文窗口较小的模型，
 * 阻塞阈值（`contextWindow - reserveTokens`）会更早触发，后台阈值不会抢先，故无需按模型换算。
 *
 * ⚠️ **不要 import 内核的 `DEFAULT_COMPACTION_POLICY`**：本模块被渲染层 import
 * （设置界面要显示默认值），而渲染层不得依赖内核（协议层的既有约定）。默认值在此**显式
 * 复写**并有测试钉住它与内核一致（`tests/compaction-config.test.ts` 会真去读内核常量比对），
 * 于是「两边漂开」这件事有断言兜着，而不是靠约定。
 *
 * ## 归一化为什么要钳制而不是报错
 *
 * 设置值来自设置页的输入框，可能是空串、负数、天文数字。这里**钳到合法区间**并返回可用值，
 * 让调用方总能拿到一个能用的配置——但 `enabled` 这类布尔值不做猜测。非法输入被钳成什么，
 * 测试里逐条钉住，免得「用户填了 -1，结果保留量变成 0，每次压缩都把上下文清空」这种事
 * 悄悄发生。
 */

/** 自动压缩的配置（与内核 `CompactionPolicy` 同形） */
export interface CompactionConfig {
  /** 是否允许**自动**压缩（手动 `/compact` 不受它约束，那是用户显式动作） */
  enabled: boolean;
  /** 留给「摘要请求本身」的 token 预算（提示词 + 输出） */
  reserveTokens: number;
  /** 压缩后**保留**的近期上下文 token 数（越大越不容易丢细节，也越快再次触发） */
  keepRecentTokens: number;
  /**
   * 离阻塞阈值还差这么多 token 时**后台**开始压缩；`0` = 关闭后台压缩。
   * 后台压缩不打断当前对话，只在摘要就绪后于下一轮边界替换历史。
   */
  backgroundTokens: number;
}

/**
 * 内核 `DEFAULT_COMPACTION_SETTINGS` 的复写。
 *
 * 与内核一致的这件事由测试保证（测试直接读内核 dist 的常量比对），所以这里不是「抄一份
 * 容易漂的副本」，而是「一份被断言钉住的副本」。这样渲染层不必 import 内核也能显示默认值。
 *
 * ⚠️ **`Object.freeze` 不是装饰**：`CompactionConfig` 的字段是可变的，而这个常量会被
 * **多个调用方拿到同一个引用**（`main/compaction-config.ts` 的未配置/坏值两条路径都直接
 * `return DEFAULT_COMPACTION_CONFIG`）。少了这一层，任何一处 `config.reserveTokens = 0`
 * 都会**改掉进程级的默认值**——而且是静默的，连「是否等于默认」的判断都会一起被改。
 * 冻结之后同样的写法在 ESM（严格模式）下会直接抛，把静默腐化变成当场报错。
 */
export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = Object.freeze({
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
  backgroundTokens: 32768,
});

/**
 * 两个数值字段的合法区间。
 *
 * 下界取 1024：再小的话「摘要预留」与「保留近文」都失去意义（摘要请求本身就装不下）。
 * 上界取 2_000_000：比任何当前模型的上下文窗口都大一个数量级，填到这么大等于**关掉**
 * 压缩（保留量永远够用），那是用户的自由，但要挡住明显的手滑（多打几个零）。
 */
export const COMPACTION_TOKENS_MIN = 1_024;
export const COMPACTION_TOKENS_MAX = 2_000_000;

/** 把任意输入钳成合法区间内的整数；非数字（含空串 / NaN / Infinity）→ 回落内核默认值 */
function clampTokens(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.trunc(parsed);
  return Math.min(COMPACTION_TOKENS_MAX, Math.max(COMPACTION_TOKENS_MIN, rounded));
}

/**
 * `backgroundTokens` 的钳制：`0` 是**合法值**（关闭后台压缩），不能套用 `clampTokens`
 * 的下界——否则「关闭」会被悄悄改回 1024。负数与非数字一律回落默认值。
 */
function clampBackgroundTokens(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.trunc(parsed);
  if (rounded === 0) return 0;
  if (rounded < 0) return fallback;
  return Math.min(COMPACTION_TOKENS_MAX, Math.max(COMPACTION_TOKENS_MIN, rounded));
}

/**
 * 归一化任意输入为可用配置。
 *
 * `enabled` 只认**布尔真值**（`true`）；其余一律 false——这一项**故意不猜**：
 * 「填了奇怪的值」时把自动压缩打开比关掉危险得多（悄悄多花一次摘要请求 + 丢细节），
 * 而关掉的代价只是用户自己按 `/compact`。
 */
export function normalizeCompactionConfig(input: unknown): CompactionConfig {
  const source = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  return {
    enabled: source.enabled === true,
    reserveTokens: clampTokens(source.reserveTokens, DEFAULT_COMPACTION_CONFIG.reserveTokens),
    keepRecentTokens: clampTokens(
      source.keepRecentTokens,
      DEFAULT_COMPACTION_CONFIG.keepRecentTokens,
    ),
    backgroundTokens: clampBackgroundTokens(
      source.backgroundTokens,
      DEFAULT_COMPACTION_CONFIG.backgroundTokens,
    ),
  };
}

/**
 * 是否与默认值**逐字段相同**（供设置界面显示「跟随默认」而不是复述数字）。
 *
 * 用显式比较而不是 JSON 字符串比较：字段顺序变了就该仍然成立。
 */
export function isDefaultCompactionConfig(config: CompactionConfig): boolean {
  return (
    config.enabled === DEFAULT_COMPACTION_CONFIG.enabled &&
    config.reserveTokens === DEFAULT_COMPACTION_CONFIG.reserveTokens &&
    config.keepRecentTokens === DEFAULT_COMPACTION_CONFIG.keepRecentTokens &&
    config.backgroundTokens === DEFAULT_COMPACTION_CONFIG.backgroundTokens
  );
}

/**
 * 给用户看的一句话摘要（设置界面与日志共用）。
 *
 * 「关」时说清楚**手动 `/compact` 仍然可用**：否则用户会以为压缩整个没了。
 */
export function describeCompaction(config: CompactionConfig): string {
  if (!config.enabled) {
    return "自动压缩已关闭（上下文攒满时不会自动摘要；手动 /compact 仍然可用）";
  }
  return `上下文攒满时自动摘要，保留最近约 ${config.keepRecentTokens} 个 token，为摘要预留 ${config.reserveTokens} 个`;
}
