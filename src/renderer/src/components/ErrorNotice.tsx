// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 统一的失败提示条：一句人话原因 + 建议动作 + 可折叠的原始信息。
 *
 * 直接渲染 `error.message` 会让「数据库尚未初始化，请先调用 openDatabase()」
 * 这种开发者错误上屏（`docs/ERRORS.md` §四：不透传底层原始报错）。
 * 翻译规则在 `lib/error-text.ts`（纯函数，有单测）；这里只负责呈现。
 */
import { AlertTriangle, X } from "lucide-react";
import { ICON } from "../lib/icon";
import { describeError } from "../lib/error-text";
import { cn } from "../lib/utils";

export function ErrorNotice({
  message,
  onDismiss,
  compact = false,
  className,
}: {
  message: string;
  onDismiss?: () => void;
  /** 设置页这类密集界面用小一号字 */
  compact?: boolean;
  className?: string;
}): React.JSX.Element {
  const { summary, hint, raw } = describeError(message);
  return (
    <div
      role="alert"
      className={cn(
        "rounded-md border border-danger/40 bg-danger-soft text-danger-fg",
        compact ? "px-3 py-2 text-xs" : "px-3 py-2 text-sm",
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle {...ICON.sm} className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="break-words">{summary}</p>
          {hint !== undefined && (
            <p className="mt-0.5 text-2xs leading-relaxed opacity-80">{hint}</p>
          )}
          {raw !== summary && (
            <details className="mt-1">
              <summary className="cursor-pointer text-2xs opacity-70">技术细节</summary>
              <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-2xs opacity-90">
                {raw}
              </pre>
            </details>
          )}
        </div>
        {onDismiss !== undefined && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="关闭"
            title="关闭"
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded-xs opacity-70 transition hover:bg-danger/10 hover:opacity-100"
          >
            <X {...ICON.xs} />
          </button>
        )}
      </div>
    </div>
  );
}
