// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 轻量下拉选择器：对齐高保真 `.picker` 的视觉与手感。
 *
 * 从 `Conversation/index.tsx` 搬出来的——那个文件是**体量棘轮**盯着的
 * （`tests/size-guard.test.ts`），往里加东西必须同时搬走等量旧代码。
 * 这里搬的是个纯展示件（只有 props 与一点开合状态），位置变了、行为没变。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { ICON } from "../../lib/icon";
import { cn } from "../../lib/utils";

export function Picker({
  title,
  value,
  label,
  options,
  icon,
  plain,
  disabled,
  className,
  onChange,
}: {
  title: string;
  value: string;
  label: string;
  options: { value: string; label: string; hint?: string }[];
  icon?: ReactNode;
  plain?: boolean;
  /** 无选项时置灰：否则点下去没任何反馈，用户会当成“点了没反应” */
  disabled?: boolean;
  className?: string;
  onChange: (value: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        title={title}
        className={cn(
          "cbtn flex h-7 items-center gap-1.5 rounded-sm border px-2 text-xs text-text-secondary transition",
          plain
            ? "border-transparent hover:border-transparent hover:bg-surface-overlay hover:text-text-primary"
            : "border-line hover:border-line-strong hover:text-text-primary",
          disabled && "cursor-not-allowed opacity-50 hover:bg-transparent hover:text-text-secondary",
          className,
        )}
      >
        {icon}
        <span className="lbl max-w-[180px] truncate">{label}</span>
        <ChevronDown {...ICON.xs} className="shrink-0 text-text-muted" />
      </button>
      {open && options.length > 0 && (
        <div className="absolute bottom-full left-0 z-20 mb-1 min-w-[160px] rounded-sm border border-line bg-surface-overlay py-1 shadow-lg">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
              className={cn(
                "block w-full px-2.5 py-1 text-left text-xs transition hover:bg-surface-raised",
                option.value === value ? "text-text-primary" : "text-text-secondary",
              )}
            >
              <span className="block truncate">{option.label}</span>
              {option.hint && (
                <span className="mt-0.5 block truncate text-2xs text-text-muted">
                  {option.hint}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
