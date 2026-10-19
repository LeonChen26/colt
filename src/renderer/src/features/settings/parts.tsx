// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 设置页的**通用零件**：分区头、设置行、开关、资源卡、提示条、标签胶囊。
 *
 * 为什么要单独一层：`docs/ui-settings-redesign-2026-10.md` 的核心动作是「把设置项从
 * 卡片改成行」——七个分区都会用到同一套行/开关/徽标。如果各分区自己写一遍，
 * 「行间距 9px」「开关 30×17」这些数字会散成七份，下次调一处就要找七个地方。
 *
 * 两条纪律：
 * 1. **只用语义字号档**（text-2xs / xs / sm / base）。设计稿里 12.5px、11.5px 这类
 *    半像素值落不到令牌上，一律就近取档——散写 `text-[12.5px]` 会让「全站字号只有
 *    四个档」这条约定当场失效。
 * 2. **开关必须是 `role="switch"` 的按钮**，不用原生 `<input type="checkbox">`：
 *    原生复选框在暗色下是系统控件，形状与整站的无彩设计语言不一致，且「关」没有独立语义。
 */
import { useRef, useState } from "react";
import { X } from "lucide-react";
import { ICON } from "@/lib/icon";
import { cn } from "@/lib/utils";

/** 作用域：全局 / 本项目 / 用户级。用户级影响面最大，单独给警告色 */
export type ScopeTone = "global" | "project" | "user";

export function ScopeBadge({
  tone,
  children,
}: {
  tone: ScopeTone;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <span
      className={cn(
        "shrink-0 rounded-xs px-1.5 py-0.5 text-2xs",
        tone === "user"
          ? "border border-warning/40 bg-warning-soft text-warning-fg"
          : "border border-line bg-surface-overlay text-text-muted",
      )}
    >
      {children}
    </span>
  );
}

/**
 * 分区头：标题 + 作用域徽标 + 右侧动作 + 一句导语。
 *
 * 导语压到 11px 且限宽 600px：现状每段是一句 40~80 字的长解释常驻在标题下，
 * 七段叠起来占到首屏一半。超过两行的说明应该进 `▸` 或干脆砍掉文案。
 */
export function PanelHead({
  title,
  scope,
  scopeTone = "global",
  action,
  lede,
}: {
  title: string;
  scope?: string;
  scopeTone?: ScopeTone;
  action?: React.ReactNode;
  lede?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-sm font-medium text-text-primary">{title}</h2>
          {scope !== undefined && <ScopeBadge tone={scopeTone}>{scope}</ScopeBadge>}
        </div>
        {action !== undefined && <div className="flex flex-none items-center gap-1.5">{action}</div>}
      </div>
      {lede !== undefined && (
        <p className="mt-1 max-w-[600px] text-2xs leading-relaxed text-text-muted">{lede}</p>
      )}
    </div>
  );
}

/** 段标题，如「已接入 · 3」「可安装 · 1」。字号同分组标签，靠字距拉开层级 */
export function SectionLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={cn("text-2xs tracking-[0.06em] text-text-muted uppercase", className)}>
      {children}
    </div>
  );
}

/**
 * 一行设置的容器。组的上边界由 `RowGroup` 给，行自己只有下边线——
 * 否则每行的第一条都要判「我是不是第一个」，条件会渗进每个调用点。
 */
export function RowGroup({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="border-t border-line-soft">{children}</div>;
}

export function Row({
  label,
  hint,
  children,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex min-h-11 items-start gap-4 border-b border-line-soft py-[9px]">
      <div className="min-w-0 flex-1">
        <div className="text-xs text-text-primary">{label}</div>
        {hint !== undefined && (
          <div className="mt-0.5 max-w-[460px] text-2xs leading-[1.55] text-text-muted">{hint}</div>
        )}
      </div>
      {children !== undefined && (
        <div className="flex flex-none items-center gap-2">{children}</div>
      )}
    </div>
  );
}

/**
 * 开关（30 × 17，圆点 12，行程 13）。
 *
 * 开态轨道用 `--accent-dim` 而不是 `--accent`：后者近白，开着的开关会成为页面上最亮的
 * 东西，而它只是「一行设置当前取值」，不该比正文抢眼。`--accent-dim` 与非文本 UI 的
 * 3:1 门槛比是 4.3:1，够用。
 *
 * `aria-label` **必需**：行标签是 `<div>`，读屏不会把它联到按钮上。
 */
export function Switch({
  checked,
  label,
  disabled = false,
  onToggle,
}: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "relative h-[17px] w-[30px] shrink-0 rounded-full transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-dim",
        "disabled:cursor-not-allowed disabled:opacity-40",
        checked ? "bg-accent-dim" : "bg-line-strong",
      )}
    >
      <span
        className={cn(
          "absolute top-[2.5px] left-[2.5px] h-3 w-3 rounded-full transition-transform",
          checked ? "translate-x-[13px] bg-accent-fg" : "bg-text-muted",
        )}
      />
    </button>
  );
}

/** 只套一层的资源卡：一项资源（provider / MCP server / 技能）有名字、状态、附属信息，压成行会丢信息 */
export function ResourceCard({
  children,
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      {...rest}
      className={cn("rounded-md border border-line bg-surface-raised px-3 py-2.5", className)}
    >
      {children}
    </div>
  );
}

/** 统一提示条。三种语气，颜色只从这里出——不再各分区自己拼 bg-danger-soft */
export function Notice({
  tone = "plain",
  children,
}: {
  tone?: "plain" | "danger" | "warning" | "success";
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2 text-2xs leading-relaxed",
        tone === "danger"
          ? "border-danger/40 bg-danger-soft text-danger-fg"
          : tone === "warning"
            ? "border-warning/40 bg-warning-soft text-warning-fg"
            : tone === "success"
              ? "border-success/40 bg-success-soft text-success-fg"
              : "border-line bg-surface-raised text-text-muted",
      )}
    >
      {children}
    </div>
  );
}

/** 小胶囊：来源标签、模型 id、tool 名 */
export function Chip({
  tone = "plain",
  mono = false,
  title,
  children,
}: {
  tone?: "plain" | "project" | "ok";
  mono?: boolean;
  title?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <span
      title={title}
      className={cn(
        "shrink-0 rounded-xs px-1.5 py-0.5 text-2xs",
        mono && "font-mono",
        tone === "project"
          ? "bg-warning-soft text-warning-fg"
          : tone === "ok"
            ? "border border-success/30 text-success-fg"
            : "bg-surface-overlay text-text-muted",
      )}
    >
      {children}
    </span>
  );
}

/** 行内折叠：出问题才要读的内容（检查明细 / 它会跑什么 / 手动命令） */
export function Details({
  summary,
  children,
  open = false,
  ...rest
}: {
  summary: React.ReactNode;
  children: React.ReactNode;
  open?: boolean;
} & React.HTMLAttributes<HTMLDetailsElement>): React.JSX.Element {
  return (
    <details {...rest} open={open} className={cn("text-2xs text-text-muted", rest.className)}>
      <summary className="w-fit cursor-pointer select-none">{summary}</summary>
      <div className="mt-1.5 rounded-sm border border-line-soft bg-surface-code px-2.5 py-2 leading-[1.65]">
        {children}
      </div>
    </details>
  );
}

/**
 * 集合型输入：一个 token 一个胶囊，回车 / 空格追加，空输入按退格删末尾，`×` 删自己。
 *
 * 现状是 6 行 textarea，提交时 `split("\n").map(trim).filter(len>0)`——用一个"文本"控件
 * 编辑一个"集合"，于是用户会写空行、会留行尾注释、会在中间敲空格。
 * 换成 chips 之后，**「保存」按钮也不必存在**：每次增删就是一个完整动作。
 */
export function TokenInput({
  value,
  placeholder,
  disabled = false,
  ariaLabel,
  onChange,
  onCommit,
}: {
  value: string[];
  placeholder?: string;
  disabled?: boolean;
  ariaLabel: string;
  onChange: (next: string[]) => void;
  /** 增删之后调用：让调用方去落盘（失焦也走这里） */
  onCommit: (next: string[]) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const add = (text: string): void => {
    const token = text.trim();
    if (token === "" || value.includes(token)) {
      setDraft("");
      return;
    }
    const next = [...value, token];
    setDraft("");
    onChange(next);
    onCommit(next);
  };

  const remove = (token: string): void => {
    const next = value.filter((item) => item !== token);
    onChange(next);
    onCommit(next);
  };

  return (
    <div
      className={cn(
        "flex min-h-[34px] w-full flex-wrap items-center gap-1.5 rounded-md border bg-surface-input px-2 py-1.5 transition focus-within:border-accent",
        disabled ? "border-line opacity-50" : "border-line",
      )}
      onClick={() => inputRef.current?.focus()}
    >
      {value.map((token) => (
        <span
          key={token}
          className="flex items-center gap-0.5 rounded-xs bg-surface-overlay py-0.5 pr-0.5 pl-1.5 font-mono text-xs text-text-secondary"
        >
          {token}
          <button
            type="button"
            disabled={disabled}
            onClick={() => remove(token)}
            aria-label={`移除 ${token}`}
            className="rounded-xs p-0.5 text-text-muted transition hover:text-danger disabled:cursor-not-allowed"
          >
            <X {...ICON.xs} />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        value={draft}
        disabled={disabled}
        aria-label={ariaLabel}
        placeholder={value.length === 0 ? placeholder : ""}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          // 中文输入法组字期间的回车/空格是「选字」，不能当成「追加一项」——
          // 否则打「测试」两个字就直接落盘了一个 token
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter" || event.key === "," || event.key === " ") {
            event.preventDefault();
            add(draft);
          } else if (event.key === "Backspace" && draft === "" && value.length > 0) {
            event.preventDefault();
            remove(value[value.length - 1]);
          }
        }}
        onBlur={() => add(draft)}
        className="min-w-[88px] flex-1 bg-transparent font-mono text-xs text-text-primary outline-none placeholder:text-text-muted"
      />
    </div>
  );
}
