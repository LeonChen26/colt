// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 浏览器下载的接管与落盘——从 `browser-host.ts` 整体搬出。
 *
 * 搬移的动机是让宿主类回到「拿请求、派动作」的形状：下载的完整生命周期
 * （seq 计数 → 目录规划 → 落盘 → 体积上限 → 完成回报）自成一体，
 * 与页面视图的摆放/观测互不相干，留在 host 里只是历史原因。
 * 行为逐字保留，宿主留一行委托（见 `BrowserHost.#viewFor` 与 `closeSession`）。
 */
import { app } from "electron";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { WebContents } from "electron";
import {
  exceedsDownloadSize,
  formatDownloadNotice,
  MAX_DOWNLOAD_BYTES,
  planDownload,
  type CaptureBuffer,
  type DownloadEntry,
} from "./browser-observe";

/** 本会话的下载目录：放应用数据目录下，既不污染项目工作区，也不写进用户的「下载」文件夹 */
export function downloadDir(sessionId: string): string {
  return join(app.getPath("userData"), "browser-downloads", sessionId);
}

/** 下载来源页面所属的会话及其捕获缓冲；查不到（页面不受宿主管辖）时为 undefined */
export interface DownloadTarget {
  sessionId: string;
  capture: CaptureBuffer;
}

export class DownloadHook {
  /** 会话 → 已触发的下载数，用于给落盘文件名加序号（否则同名会互相覆盖） */
  readonly #seq = new Map<string, number>();
  #hooked = false;

  constructor(
    /** 下载来源 → 所属会话与捕获缓冲的解析；由宿主注入（两张映射表都在它手里） */
    private readonly resolve: (webContentsId: number) => DownloadTarget | undefined,
  ) {}

  /**
   * 接管下载。
   *
   * will-download 是 session 级；这里挂在浏览器专属 partition 上，
   * 不属于宿主管辖的窗口（例如应用自身）根本不在该 session，天然不干预。
   * 幂等：同一个 session 只挂一次。
   */
  hook(session: Electron.Session): void {
    if (this.#hooked) return;
    this.#hooked = true;

    session.on("will-download", (_event, item, webContents) => {
      // 类型上非空，但并非所有下载来源都会带上它，故按可选处理
      const source = webContents as WebContents | undefined;
      const target = source === undefined ? undefined : this.resolve(source.id);
      if (target === undefined) return;
      const { sessionId, capture } = target;

      const url = item.getURL();
      const seq = (this.#seq.get(sessionId) ?? 0) + 1;
      this.#seq.set(sessionId, seq);

      const dir = downloadDir(sessionId);
      const plan = planDownload(item.getFilename(), seq, dir);
      if (!plan.ok) {
        item.cancel();
        capture.recordConsole({ level: "warning", message: plan.reason, source: url, line: 0 });
        return;
      }

      try {
        mkdirSync(dir, { recursive: true });
        item.setSavePath(plan.path);
      } catch (error) {
        capture.recordConsole({
          level: "error",
          message: `下载无法落盘：${error instanceof Error ? error.message : String(error)}`,
          source: url,
          line: 0,
        });
        return;
      }

      // 页面能反复触发下载，故设体积上限，避免被拖着把磁盘写满
      let overSizeLimit = false;
      item.on("updated", (_updated, state) => {
        if (state === "progressing" && exceedsDownloadSize(item.getReceivedBytes())) {
          overSizeLimit = true;
          item.cancel();
        }
      });

      item.once("done", (_done, state) => {
        const entry: DownloadEntry = {
          filename: plan.filename,
          path: plan.path,
          url,
          bytes: item.getReceivedBytes(),
          state,
          note: overSizeLimit ? `超过体积上限（${MAX_DOWNLOAD_BYTES} 字节），已取消` : undefined,
        };
        capture.recordDownload(entry);
        capture.recordConsole({
          level: state === "completed" ? "info" : "warning",
          message: formatDownloadNotice(entry),
          source: url,
          line: 0,
        });
      });
    });
  }

  /** 会话关闭时清掉它的序号计数（目录里的文件不删，观测记录随会话一起消失） */
  disposeSession(sessionId: string): void {
    this.#seq.delete(sessionId);
  }
}
