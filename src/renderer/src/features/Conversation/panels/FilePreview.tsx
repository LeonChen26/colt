/**
 * 「改动清单」下钻的**内容层**：文件本身（原「文件」视图的预览，A3-2）。
 *
 * 它原先自带一列 200px 的「本次改动」树（A3-4）。⑦-G 落地后那棵树被**清单层**吸收了
 * （清单按目录分组，比树多一个「同一文件改了几次」的维度），故这里只剩预览本身——
 * 容器查询、窄栏让位那套（`.file-view` / `fv-tree`）随之作废。
 *
 * 安全边界**不在这里**：渲染层只传路径，根由主进程按 `sessionId → 项目` 推出
 * （见 `src/main/file-read.ts`）。所以这里对「越界 / 不存在 / 不是文件」只需把主进程
 * 给的原因原样显示，不必自己再判一遍（判了也是两套说法，早晚不一致）。
 *
 * 预览按类型分流，**不做「尽力渲染半截内容」**：文本里 `.md` 走 Markdown，其余按代码等宽；
 * 图片给 dataUrl；二进制 / 过大只给一句说明——半截内容比看不到更容易误导。
 *
 * `reloadToken` 变化即重读（agent 可能刚改过这个文件；同一路径再点一次也要重读）。
 */
import { useEffect, useState } from "react";
import { AlertTriangle, FileWarning, Loader2, RotateCw } from "lucide-react";
import { ICON } from "@/lib/icon";
import { formatBytes } from "@/lib/format";
import type { FileReadResult } from "@shared/protocol";
import { Markdown } from "../../../components/Markdown";

/** 走 Markdown 渲染的扩展名；其余文本一律按代码显示 */
const MARKDOWN_EXT = /\.(md|markdown|mdx)$/i;

/** 空态 / 不可预览 / 过大的统一排版：图标 + 标题 + 说明 */
function Placeholder({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center">
      {icon}
      <p className="mt-2 text-[12.5px] text-text-secondary">{title}</p>
      <p className="max-w-[260px] text-[11.5px] leading-relaxed text-text-muted">{body}</p>
    </div>
  );
}

export function FilePreview({
  sessionId,
  path,
  reloadToken,
  onReload,
}: {
  sessionId: string;
  /** 项目内相对路径 */
  path: string;
  /** 变化即重读（「重新读取」按钮与外部打开请求都用它） */
  reloadToken: number;
  onReload: () => void;
}): React.JSX.Element {
  const [result, setResult] = useState<FileReadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError(null);
    void window.colt
      .invoke("file.read", { sessionId, path })
      .then((next) => {
        if (!disposed) setResult(next);
      })
      .catch((cause: unknown) => {
        if (disposed) return;
        setResult(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [sessionId, path, reloadToken]);

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col" data-file-view={path}>
      {/* 文件头：路径 + 体积 + 重读 */}
      <div className="flex h-[30px] shrink-0 items-center gap-2 border-b border-line px-2.5">
        <span className="truncate font-mono text-[11px] text-text-secondary" title={path}>
          {path}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {result !== null && (
            <span className="text-[10.5px] text-text-muted">{formatBytes(result.size)}</span>
          )}
          <button
            type="button"
            onClick={onReload}
            title="重新读取"
            aria-label="重新读取"
            className="rounded-[4px] p-1 text-text-muted transition hover:bg-surface-overlay hover:text-text-primary"
          >
            <RotateCw {...ICON.xs} />
          </button>
        </span>
      </div>

      {loading ? (
        <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-[12px] text-text-muted">
          <Loader2 {...ICON.sm} className="animate-spin" />
          正在读取…
        </div>
      ) : error !== null ? (
        <Placeholder
          icon={<AlertTriangle className="text-warning" style={{ width: 24, height: 24 }} />}
          title="无法预览该文件"
          body={error}
        />
      ) : result === null ? null : result.kind === "text" ? (
        MARKDOWN_EXT.test(path) ? (
          <div className="min-h-0 flex-1 overflow-auto px-4 py-4" data-file-text>
            <Markdown>{result.text}</Markdown>
          </div>
        ) : (
          <pre
            data-file-text
            className="min-h-0 flex-1 overflow-auto whitespace-pre bg-surface-code px-3 py-3 font-mono text-[11.5px] leading-relaxed text-text-secondary"
          >
            {result.text}
          </pre>
        )
      ) : result.kind === "image" ? (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <img
            src={result.dataUrl}
            alt={path}
            data-file-image
            className="max-w-full rounded-[6px] border border-line"
          />
        </div>
      ) : result.kind === "too-large" ? (
        <Placeholder
          icon={<FileWarning className="text-text-muted" style={{ width: 24, height: 24 }} />}
          title="文件过大，已跳过预览"
          body={`${formatBytes(result.size)} 超出上限 ${formatBytes(result.limit)}。`}
        />
      ) : (
        <Placeholder
          icon={<FileWarning className="text-text-muted" style={{ width: 24, height: 24 }} />}
          title="二进制文件，暂不支持预览"
          body={`${formatBytes(result.size)}。`}
        />
      )}
    </div>
  );
}
