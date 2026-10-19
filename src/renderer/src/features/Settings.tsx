// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 设置页外壳：**左侧分组导航 + 右侧一屏内容**。
 *
 * 改造前是「一条竖直流水线」：7 个分区首尾相接，每段都是「`<h3>` + 一段解释 + 一张卡片」。
 * 于是「审批」排第 2，但要滚过全部 provider 卡片才能到；三种作用域（全局 / 项目级 / 用户级）
 * 在视觉上零区别；同一页有五种生效方式（即时 / 失焦 / 卡片内保存 / textarea + 保存按钮 /
 * 乐观更新），用户无法建立预期。
 *
 * 这层只做三件事：**分组导航**、**当前一屏的条件渲染**、**跨屏的提示条**。
 * 各屏自己的数据与动作留在各屏里——外壳不该知道「模型服务有几张卡」。
 *
 * 设计依据：`docs/ui-settings-redesign-2026-10.md`。
 */
import { useCallback, useRef, useState } from "react";
import {
  Activity,
  Boxes,
  Brain,
  Check,
  Layers,
  Monitor,
  ShieldCheck,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { ICON } from "@/lib/icon";
import type { Project } from "@shared/protocol";
import { cn } from "@/lib/utils";
import { ApprovalPanel, CompactionPanel, ComputerPanel, DiagnosePanel } from "./settings/Behavior";
import { McpPanel, useMcpInstallBusy } from "./settings/Mcp";
import { ProvidersPanel } from "./settings/ProvidersSection";
import { SkillsPanel } from "./settings/Skills";

/** 七个屏。id 同时是 `data-settings-nav` 的值（冒烟先点导航再断言，见 `dev/smoke/modes/mcp-catalog.ts`） */
type PanelId = "providers" | "approval" | "diagnose" | "computer" | "compaction" | "mcp" | "skills";

/**
 * 分组不按作用域分（全局 / 项目级 / 用户级），按**用户想改什么**分：
 * 用户的心智是「我要改模型」，不是「我要改全局设置」。按作用域分组会把「模型服务」和
 * 「MCP」这两个都在顶部附近的东西拆到两端。作用域用徽标表达，不用结构表达。
 */
const GROUPS: { label: string; items: { id: PanelId; label: string; icon: LucideIcon }[] }[] = [
  { label: "模型", items: [{ id: "providers", label: "模型服务", icon: Brain }] },
  {
    label: "行为",
    items: [
      { id: "approval", label: "审批", icon: ShieldCheck },
      { id: "diagnose", label: "写后诊断", icon: Activity },
      { id: "computer", label: "电脑控制", icon: Monitor },
      { id: "compaction", label: "上下文压缩", icon: Layers },
    ],
  },
  {
    label: "扩展",
    items: [
      { id: "mcp", label: "MCP", icon: Boxes },
      { id: "skills", label: "技能", icon: Sparkles },
    ],
  },
];

export function Settings({ project }: { project: Project | null }): React.JSX.Element {
  const [active, setActive] = useState<PanelId>("providers");
  /**
   * 后台有没有安装 / 卸载在跑。
   *
   * 安装是分钟级的，用户点完很可能就去别的屏干活了。这个状态从 MCP 屏的模块级 store 读，
   * 所以**切走也还在**——导航项右端那个点就是给这种时候用的：证明「它还在跑」，
   * 而不是让人过一会儿回来发现按钮没变化、怀疑自己没点上。
   */
  const mcpInstalling = useMcpInstallBusy();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 提示条定时器要持句柄、新提示先清旧的：否则 2.5s 内连续两次成功操作时，
  // 第一条的定时器会把第二条提示提前清掉（看起来「闪一下就没了」）
  const notifyTimerRef = useRef<number | null>(null);
  const notify = useCallback((text: string) => {
    setMessage(text);
    setError(null);
    if (notifyTimerRef.current !== null) clearTimeout(notifyTimerRef.current);
    notifyTimerRef.current = window.setTimeout(() => setMessage(null), 2500);
  }, []);

  const fail = useCallback((e: unknown) => {
    setError(e instanceof Error ? e.message : String(e));
  }, []);

  return (
    <div className="flex h-full">
      <nav
        aria-label="设置分区"
        className="w-[216px] shrink-0 overflow-y-auto border-r border-line px-2.5 py-3.5"
      >
        <div className="px-2 pb-1 text-2xs tracking-[0.06em] text-text-muted uppercase">设置</div>
        {GROUPS.map((group) => (
          <div key={group.label}>
            <div className="px-2 pt-4 pb-1 text-2xs tracking-[0.06em] text-text-muted uppercase">
              {group.label}
            </div>
            {group.items.map((item) => {
              const Icon = item.icon;
              const selected = active === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  data-settings-nav={item.id}
                  aria-current={selected ? "page" : undefined}
                  onClick={() => setActive(item.id)}
                  className={cn(
                    "mb-0.5 flex h-8 w-full items-center gap-2 rounded-md px-2 text-xs transition",
                    selected
                      ? "bg-surface-overlay text-text-primary"
                      : "text-text-secondary hover:bg-surface-overlay/60 hover:text-text-primary",
                  )}
                >
                  <Icon {...ICON.xs} className="shrink-0" />
                  <span className="truncate">{item.label}</span>
                  {item.id === "mcp" && mcpInstalling && (
                    <span
                      title="正在安装 / 卸载"
                      className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-accent-dim"
                    />
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-6 py-5">
          {message !== null && (
            <div className="mb-3 flex items-center gap-2 rounded-md border border-success/40 bg-success-soft px-3 py-2 text-xs text-success-fg">
              <Check {...ICON.sm} />
              {message}
            </div>
          )}
          {error !== null && (
            <div className="mb-3 rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger-fg">
              {error}
            </div>
          )}

          {/*
            条件渲染而不是 `hidden`：只挂当前那一屏。否则打开设置页会同时发出六组 IPC
            （现状就是这样，一次全拉），其中 `mcp.catalog` 还要 spawn 五条命令。
          */}
          {active === "providers" && <ProvidersPanel onSaved={notify} onError={fail} />}
          {active === "approval" && <ApprovalPanel onSaved={notify} onError={fail} />}
          {active === "diagnose" && <DiagnosePanel onSaved={notify} onError={fail} />}
          {active === "computer" && <ComputerPanel onSaved={notify} onError={fail} />}
          {active === "compaction" && <CompactionPanel onSaved={notify} onError={fail} />}
          {active === "mcp" && <McpPanel project={project} />}
          {active === "skills" && <SkillsPanel project={project} />}
        </div>
      </div>
    </div>
  );
}
