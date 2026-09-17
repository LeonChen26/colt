/**
 * 记忆检索宿主：把 worker 的 memory_search 调用路由到索引库。
 *
 * 只读、本地、无副作用——不进审批（与 read 工具同级，在 READONLY_TOOLS 名单里）。
 * **项目隔离在本层强制**：cwd 由主进程在起 worker 时登记（不信任 worker 报值），
 * 检索只放行本项目 + 用户级条目，其它项目的历史记忆一律不可见。
 */
import type { HostResult } from "@shared/worker-protocol";
import { normalizeRootKey } from "../db/index";
import { searchMemory, type MemoryHit } from "../db/memory-index";

export function formatMemoryHits(hits: MemoryHit[], query: string): string {
  if (hits.length === 0) return `没有匹配「${query}」的记忆条目。`;
  return hits
    .map((hit, index) => {
      const scope = hit.scope === "user" ? "用户级" : "项目";
      const status = hit.status === "active" ? "现行" : "已归档（已从记忆文件移除）";
      const date = new Date(hit.lastSeenAt).toISOString().slice(0, 10);
      return `${index + 1}. [${scope}·${status}·${date}] ${hit.content}`;
    })
    .join("\n");
}

export class MemoryHost {
  readonly #cwds = new Map<string, string>();

  /** 起会话进程时登记 cwd（检索的项目隔离依据） */
  setContext(sessionId: string, cwd: string): void {
    this.#cwds.set(sessionId, cwd);
  }

  clearSession(sessionId: string): void {
    this.#cwds.delete(sessionId);
  }

  async handle(sessionId: string, action: string, params: Record<string, unknown>): Promise<HostResult> {
    if (action !== "search") throw new Error(`未知的记忆动作：${action}`);
    const cwd = this.#cwds.get(sessionId);
    if (cwd === undefined) throw new Error("记忆检索尚未初始化（会话未登记工作目录）。");
    const query = typeof params.query === "string" ? params.query : "";
    const limit = typeof params.limit === "number" ? params.limit : undefined;
    const hits = searchMemory({ projectKey: normalizeRootKey(cwd), query, limit });
    return { text: formatMemoryHits(hits, query) };
  }
}
