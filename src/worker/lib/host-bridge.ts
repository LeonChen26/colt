/**
 * worker 侧的宿主能力客户端。
 *
 * 浏览器/桌面这类能力必须由主进程（Electron GUI）持有——窗口与 OS 权限都在那一侧，
 * worker 只能发命令、等结果。往返形态与审批请求（requestApproval）一致：发请求、
 * 阻塞、由主进程回消息唤醒，避免引入第二套异步范式。
 */
import { randomUUID } from "node:crypto";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { HostCapability, HostResult, WorkerMessage } from "@shared/worker-protocol";

/**
 * 单次宿主调用上限；超时视为失败，避免 lane 永久挂起。
 *
 * 必须大于主进程侧最长的动作时限：`browser/wait` 的页内硬超时上限是 60s
 * （MAX_WAIT_TIMEOUT_MS），主进程外层再留 5s 余量（65s）——RPC 定时器在请求发出
 * 之前就开始计时，若也是 60s，按上限等待时**必然**被 RPC 超时抢先，
 * 把「等待超时」误报成「宿主能力调用超时」，模型会以为宿主坏了而原参重试。
 * 取 90s = wait 上限 60s + 主进程余量 5s + 往返与调度余量。
 */
const HOST_RPC_TIMEOUT_MS = 90_000;

/** 把宿主结果转成内核的工具内容块（文本 + 可选图片），供各能力工具共用 */
export function hostResultToContent(result: HostResult): (TextContent | ImageContent)[] {
  const content: (TextContent | ImageContent)[] = [];
  if (result.text.length > 0) content.push({ type: "text", text: result.text });
  if (result.image) {
    content.push({ type: "image", data: result.image.data, mimeType: result.image.mimeType });
  }
  if (content.length === 0) content.push({ type: "text", text: "（无输出）" });
  return content;
}

/** 仅保留有值的参数，避免把 undefined 传给主进程 */
export function definedParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

interface Pending {
  resolve: (result: HostResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class HostBridge {
  readonly #send: (message: WorkerMessage) => void;
  readonly #pending = new Map<string, Pending>();

  constructor(send: (message: WorkerMessage) => void) {
    this.#send = send;
  }

  call(capability: HostCapability, action: string, params: Record<string, unknown>): Promise<HostResult> {
    const requestId = randomUUID();
    return new Promise<HostResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error(`宿主能力调用超时（${HOST_RPC_TIMEOUT_MS / 1000}s）：${capability}/${action}`));
      }, HOST_RPC_TIMEOUT_MS);
      timer.unref?.();

      this.#pending.set(requestId, { resolve, reject, timer });
      this.#send({ type: "toolRpc", requestId, capability, action, params });
    });
  }

  /** 主进程答复到达，唤醒对应的阻塞 */
  settle(requestId: string, ok: boolean, payload: HostResult | string): void {
    const entry = this.#pending.get(requestId);
    if (entry === undefined) return;
    this.#pending.delete(requestId);
    clearTimeout(entry.timer);
    if (ok) {
      entry.resolve(payload as HostResult);
      return;
    }
    entry.reject(new Error(typeof payload === "string" ? payload : "宿主能力调用失败"));
  }

  /** worker 退出/会话关闭时作废所有待决调用，避免调用方永久等待 */
  dispose(): void {
    for (const entry of this.#pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("会话已关闭，宿主能力调用已取消。"));
    }
    this.#pending.clear();
  }
}
