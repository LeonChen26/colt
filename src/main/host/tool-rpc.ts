/**
 * 宿主能力调用（浏览器 / 桌面）的执行与回发。
 *
 * 从 session-manager 挪出来只为给大户减重（它有体量闸守着）：这是一段**自成一体的
 * 小往返**——进参一条 toolRpc 消息、出参一条回发命令，中间不碰任何会话状态。
 *
 * 期间 worker 可能已被回收/替换，回给已死的进程毫无意义，所以回发前要再确认一次
 * 「这个 entry 还是不是当前的那个」。
 */
import { hostBridge } from ".";
import type { HostResult, WorkerCommand, WorkerMessage } from "@shared/worker-protocol";
import type { WorkerEntry } from "../session-manager";

export async function handleToolRpc(
  entry: WorkerEntry,
  message: Extract<WorkerMessage, { type: "toolRpc" }>,
  isCurrent: (entry: WorkerEntry) => boolean,
): Promise<void> {
  let result: WorkerCommand;
  try {
    const value: HostResult = await hostBridge.handle({
      sessionId: entry.sessionId,
      capability: message.capability,
      action: message.action,
      params: message.params,
    });
    result = { type: "toolRpcResult", requestId: message.requestId, ok: true, result: value };
  } catch (error) {
    result = {
      type: "toolRpcResult",
      requestId: message.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (!isCurrent(entry)) return;
  entry.child.postMessage(result);
}
