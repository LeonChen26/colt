/**
 * 「模型在等人」的桌面通知：审批与提问共用一条通道。
 *
 * 从 session-manager 挪出来只为给大户减重（它有体量闸守着）：这段不碰会话状态，
 * 只做「拼一条通知 + 点击把窗口叫到前台」。
 */
import { Notification, type BrowserWindow } from "electron";
import type { ApprovalRequest } from "@shared/protocol";
import type { AskUserQuestion } from "@shared/worker-protocol";

/** 点击只把窗口叫到前台、不代用户切换会话——那要另开一条「主进程指示渲染层切会话」的通道，
 *  而侧栏此刻已经标出了是哪个会话在等，用户点一下即可。
 *
 * @param getWindow 取当前窗口；窗口还没挂上时为 undefined，此时点击无事可做
 */
function notify(title: string, body: string, getWindow: () => BrowserWindow | undefined): void {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body });
  notification.on("click", () => {
    const window = getWindow();
    if (!window || window.isDestroyed()) return;
    // 最小化时先还原：直接 focus() 只是把焦点给了任务栏上那个仍然最小化的窗口
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  notification.show();
}

export function notifyApproval(
  requests: ApprovalRequest[],
  getWindow: () => BrowserWindow | undefined,
): void {
  const first = requests[0];
  if (!first) return;
  const more = requests.length > 1 ? `（另有 ${requests.length - 1} 条）` : "";
  notify("有操作等待你的授权", `${first.summary}${more}`, getWindow);
}

export function notifyQuestion(
  questions: AskUserQuestion[],
  getWindow: () => BrowserWindow | undefined,
): void {
  const first = questions[0];
  if (!first) return;
  const more = questions.length > 1 ? `（另有 ${questions.length - 1} 个问题）` : "";
  notify("模型在等你回答", `${first.question}${more}`, getWindow);
}
