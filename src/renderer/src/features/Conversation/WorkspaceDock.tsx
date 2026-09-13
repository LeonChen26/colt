/**
 * 右栏工作区容器（规则 ⑦-B）：以**页签**切换视图。
 *
 * 「正在处理」是默认视图（⑦-E，常驻不可关闭）；「浏览器」是 agent 动作对象的投影（⑦-A / ⑦-C）。
 *
 * 浏览器本体的关键约束：它是由主进程持有的 **WebContentsView（原生视图）**，
 * 浮在渲染层之上，渲染层画不了它，也无法用 CSS 裁切。因此这里的职责是：
 *   1. 画一个「页面区域」占位 div，量出它的矩形上报给主进程（`browser.bounds`）；
 *   2. 切到别的页签 / 组件卸载时上报 null，让主进程隐藏原生视图——
 *      否则原生视图会一直浮在界面上，盖住别的页签内容（原生视图不参与 DOM 叠层）。
 */
import { useEffect, useRef } from "react";
import { Activity, Globe } from "lucide-react";
import { ICON } from "@/lib/icon";
import type { BrowserViewState } from "@shared/protocol";
import type { ConversationView } from "@shared/worker-protocol";
import { cn } from "../../lib/utils";
import { FollowPanel } from "./FollowPanel";

export type DockView = "follow" | "browser";

/** 视图切换时的**建议宽度**（规则 ⑦-B：宽度只由用户拖拽决定，这里有拖拽前先用建议值） */
export const DOCK_SUGGEST_WIDTH: Record<DockView, number> = {
  follow: 300,
  browser: 544,
};

/** 页签：激活态用强调色下边框（对齐高保真 .dock-tab） */
function DockTab({
  active,
  icon,
  label,
  live,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  live?: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex h-7 shrink-0 items-center gap-1.5 border-b-2 border-transparent px-2 text-[12px] whitespace-nowrap transition",
        active
          ? "border-accent font-medium text-text-primary"
          : "text-text-muted hover:text-text-secondary",
      )}
    >
      {icon}
      {label}
      {live && <span className="live-dot" />}
    </button>
  );
}

export function WorkspaceDock({
  sessionId,
  view,
  highlightPath,
  onOpenChanges,
  browser,
  tab,
  onTab,
}: {
  sessionId: string;
  view: ConversationView | null;
  highlightPath?: string | null;
  onOpenChanges: () => void;
  browser: BrowserViewState | null;
  tab: DockView;
  onTab: (next: DockView) => void;
}): React.JSX.Element {
  const areaRef = useRef<HTMLDivElement>(null);
  const loaded = browser?.loaded ?? false;
  const showBrowser = tab === "browser";
  const url = browser?.url ?? "";

  // 会话卸载（切会话 / 进设置）时必须把本会话的原生视图收起来，
  // 否则它会继续浮在界面上，盖住新会话的右栏。
  useEffect(() => {
    return () => {
      void window.banyan.invoke("browser.bounds", { sessionId, rect: null }).catch(() => undefined);
    };
  }, [sessionId]);

  // 上报页面区域：只在「浏览器页签 + 视图已加载 + 元素已挂载」时给矩形，其余一律 null
  useEffect(() => {
    const node = areaRef.current;
    if (!showBrowser || !loaded || node === null) {
      void window.banyan.invoke("browser.bounds", { sessionId, rect: null }).catch(() => undefined);
      return;
    }
    const report = (): void => {
      const rect = node.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      void window.banyan
        .invoke("browser.bounds", {
          sessionId,
          rect: {
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        })
        .catch(() => undefined);
    };
    report();
    // ResizeObserver 只管尺寸变化；位置（右栏宽度/窗口移动）变化靠 window resize 兜住，
    // 页签切换本身会重跑本 effect，所以三个来源覆盖了全部布局变化。
    const observer = new ResizeObserver(report);
    observer.observe(node);
    window.addEventListener("resize", report);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", report);
    };
  }, [sessionId, showBrowser, loaded]);

  return (
    <aside className="flex min-h-0 w-full flex-col border-l border-line bg-surface-raised">
      <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line px-1.5 pt-1.5">
        <DockTab
          active={!showBrowser}
          icon={<Activity {...ICON.xs} className="shrink-0" />}
          label="正在处理"
          live={view?.running ?? false}
          onClick={() => onTab("follow")}
        />
        <DockTab
          active={showBrowser}
          icon={<Globe {...ICON.xs} className="shrink-0" />}
          label="浏览器"
          onClick={() => onTab("browser")}
        />
      </div>

      {showBrowser ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* 顶部信息条：原生视图压在下方，「页面区域」之外的东西由渲染层画 */}
          <div className="flex h-[30px] shrink-0 items-center gap-2 border-b border-line px-2.5">
            <Globe {...ICON.xs} className="shrink-0 text-text-muted" />
            <span
              className="truncate font-mono text-[11px] text-text-secondary"
              title={browser?.title || url || undefined}
            >
              {loaded ? url || "about:blank" : "尚未加载"}
            </span>
          </div>
          {loaded ? (
            // 这个 div 就是「页面区域」：主进程把 WebContentsView 精确摆在这个矩形上
            <div ref={areaRef} className="min-h-0 flex-1 bg-white" />
          ) : (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center">
              <Globe className="text-text-muted" style={{ width: 26, height: 26 }} />
              <p className="mt-2 text-[12.5px] text-text-secondary">浏览器尚未加载</p>
              <p className="max-w-[240px] text-[11.5px] leading-relaxed text-text-muted">
                agent 使用浏览器时会自动打开；在此之前不占用资源。
              </p>
            </div>
          )}
        </div>
      ) : (
        <FollowPanel
          view={view}
          highlightPath={highlightPath}
          onOpenChanges={onOpenChanges}
        />
      )}
    </aside>
  );
}
