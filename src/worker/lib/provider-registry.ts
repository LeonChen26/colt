// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * worker 侧的 provider 目录与**按需注册**（工作包 C）。
 *
 * 现状是 worker 只注册会话自己那一家（`models.setProvider(buildProvider(会话 provider))`），
 * 于是「子代理用另一个模型」这条路根本走不通——切到没注册过的 provider 时内核会以
 * 「provider 未注册」失败。要切过去就得有那家的**配置**（init 里下发，非密钥）
 * 与**密钥**（用到时经 `providerKey` 宿主能力取，仅内存传输）。
 *
 * 三条取舍写在这里，免得被当成实现细节改掉：
 *   ① **按需取密钥，不预注册全部**：init 只带非密钥目录，密钥在真的要切过去时才取一次。
 *      预注册全部 provider 会把「已配置的所有密钥」常驻 worker 内存——暴露面扩大，
 *      而绝大多数会话一次都不会切 provider（`docs/impl-plan-three-gaps-2026-10.md` C.6 的降级方案）。
 *   ② **不缓存 provider 实例**：装配本身只是对象构造，而缓存实例会让「用户中途改了
 *      baseUrl / 模型表」永远不生效（与审批分析器「每次现装现用」同一理由）。
 *      缓存的是**密钥**（那才是要少取一次的东西）。
 *   ③ 失败一律**抛结构化错误**：不能用「回落会话模型」糊过去——那样调用方以为路由生效了，
 *      实际跑的是另一个模型（本仓最贵的一类错误）。
 */
import type { MutableModels } from "@earendil-works/pi-ai";
import { buildProvider, type ProviderDirectoryEntry } from "@shared/provider-factory";
import type { HostCapability, HostResult } from "@shared/worker-protocol";

/** 取密钥的那一跳（`HostBridge` 结构上满足它；测试里可以用假实现） */
export interface ProviderKeySource {
  call(
    capability: HostCapability,
    action: string,
    params: Record<string, unknown>,
  ): Promise<HostResult>;
}

export class ProviderRegistry {
  readonly #models: MutableModels;
  readonly #keys: ProviderKeySource;
  readonly #directory = new Map<string, ProviderDirectoryEntry>();
  /** 已取到的密钥（同一会话内同 provider 只往返一次）；只存在内存里 */
  readonly #secrets = new Map<string, string>();

  constructor(models: MutableModels, keys: ProviderKeySource) {
    this.#models = models;
    this.#keys = keys;
  }

  /** 装载 init 下发的目录（整份覆盖：它描述的是「现在有哪几家」） */
  setDirectory(entries: readonly ProviderDirectoryEntry[]): void {
    this.#directory.clear();
    for (const entry of entries) this.#directory.set(entry.id, entry);
  }

  /** 目录项（非密钥配置）；没有则 undefined */
  entry(providerId: string): ProviderDirectoryEntry | undefined {
    return this.#directory.get(providerId);
  }

  /** 目录里全部 providerId（写错误信息用） */
  ids(): string[] {
    return [...this.#directory.keys()];
  }

  /**
   * 确保目标 provider 已注册进 models；未注册时按需取密钥并现装。
   *
   * 抛错的情形都给**能照着改**的说明：未知 providerId（列出可用的）、
   * 取密钥失败（原样透传主进程那句「尚未配置 X 的 API Key」）。
   */
  async ensure(providerId: string): Promise<ProviderDirectoryEntry> {
    const entry = this.#directory.get(providerId);
    if (entry === undefined) {
      throw new Error(
        `没有名为「${providerId}」的模型服务配置，无法为它切换模型。` +
          `可用的是：${this.ids().join("、") || "（一个都没有）"}。`,
      );
    }
    if (this.#models.getProvider(providerId) !== undefined) return entry;

    let key = this.#secrets.get(providerId);
    if (key === undefined) {
      // 主进程侧失败会以 hostResult.error 回来，这里原样抛出去——它是给调用方（模型）看的一句话
      key = (await this.#keys.call("providerKey", "get", { providerId })).text;
      this.#secrets.set(providerId, key);
    }
    this.#models.setProvider(buildProvider(entry, key));
    return entry;
  }
}
