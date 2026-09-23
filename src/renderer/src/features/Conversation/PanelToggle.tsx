// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 会话头（②）上的「打开某个面板」按钮：图标 + 文字 + 选中态。
 *
 * 抽成独立文件有两个理由：② 的入口会随能力增减，集中在组件里改；以及
 * `Conversation/index.tsx` 是**体量棘轮**盯着的文件（`tests/size-guard.test.ts`），
 * 新东西塞进去要**同时搬走等量旧代码**——这里搬出来的是纯展示件，位置变了、行为没变。
 */
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

export function PanelToggle({
  active,
  icon,
  label,
  title,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  title?: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "flex items-center gap-1.5 rounded-sm border px-2 py-1 text-xs transition",
        active
          ? "border-accent bg-accent-soft text-text-primary"
          : "border-line text-text-secondary hover:text-text-primary",
      )}
    >
      {icon}
      {label}
    </button>
  );
}
