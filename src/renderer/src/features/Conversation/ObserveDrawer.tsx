/**
 * 浏览器观测抽屉（B2）：控制台 / 网络 / 下载。
 *
 * 为什么要有它：⑦-A 说右栏是「现场」，④ 是「叙述」——agent 在页面里的操作，
 * 页面本身是现场，**页面报了什么错、有哪些请求失败、文件下到哪**同样属于现场。
 * 此前这些数据只躺在主进程的 `CaptureBuffer` 里，只有 agent 调 `browser_read` 才看得到，
 * 用户想知道「刚才那个报错是什么」只能问模型。本抽屉补上这一半。
 *
 * 数据来源是 `browser.observe`（只读），读的与 `browser_read` 是**同一份缓冲**，
 * 不存在「UI 说的和模型看到的不一样」。
 *
 * 三个刻意的选择：
 *   1. **轮询而不是主进程逐条推**：console / network 事件可以非常密集，逐条推就是 IPC 洪泛；
 *      抽屉展示的是「缓冲区此刻的样子」，轮询语义上更贴切。只在「浏览器」页签挂载时轮询。
 *   2. **按时间顺序平铺**，不把问题提到前面：这是观测台（console/network）的通用心智模型；
 *      「有没有问题」由页签上的计数徽标回答，不需要靠重排来暗示。
 *   3. **不做过滤**：给模型的文本为了省上下文会丢掉成功请求，这里全给——用户可能正是想看全量。
 */
import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Globe, Package, Terminal } from "lucide-react";
import { ICON } from "@/lib/icon";
import type { BrowserObservation, ConsoleEntry, DownloadEntry, NetworkEntry } from "@shared/protocol";
import { formatBytes } from "../../lib/format";
import { cn } from "../../lib/utils";

/** 轮询间隔：本地 IPC、载荷有上限，1s 足够跟手又不至于变成洪泛 */
const POLL_MS = 1000;

type ObsTab = "console" | "network" | "downloads";

/** 与主进程 `formatConsole` 同一判据，保证徽标数与「agent 会被告知的问题数」一致 */
function isConsoleProblem(entry: ConsoleEntry): boolean {
  return entry.level === "error" || entry.level === "warning";
}

/** 与主进程 `formatNetwork` 同一判据 */
function isNetworkProblem(entry: NetworkEntry): boolean {
  return entry.error !== undefined || (entry.statusCode ?? 0) >= 400;
}

/** 源码地址压成文件名：完整 URL 在这个宽度里只是噪声 */
function shortSource(source: string): string {
  if (source.length === 0) return "";
  const withoutQuery = source.split(/[?#]/)[0] ?? "";
  const parts = withoutQuery.split("/");
  return parts[parts.length - 1] || withoutQuery;
}

const TABS: { id: ObsTab; label: string; Icon: typeof Terminal }[] = [
  { id: "console", label: "控制台", Icon: Terminal },
  { id: "network", label: "网络", Icon: Globe },
  { id: "downloads", label: "下载", Icon: Package },
];

export function ObserveDrawer({ sessionId }: { sessionId: string }): React.JSX.Element {
  const [tab, setTab] = useState<ObsTab>("console");
  const [collapsed, setCollapsed] = useState(false);
  const [data, setData] = useState<BrowserObservation | null>(null);
  /**
   * 上一份快照的签名。缓冲区多半时候是不变的，而轮询每次都会返回新对象——
   * 不比对就会每秒重渲染整棵列表。比对省掉的是「多数轮次都是空转」这件事。
   */
  const lastSignature = useRef("");

  // 只在浏览器页签挂载时轮询：切走页签即卸载，轮询随之停止
  useEffect(() => {
    let disposed = false;
    const tick = (): void => {
      void window.banyan
        .invoke("browser.observe", { sessionId })
        .then((next) => {
          if (disposed) return;
          const signature = JSON.stringify(next);
          if (signature === lastSignature.current) return;
          lastSignature.current = signature;
          setData(next);
        })
        .catch(() => undefined);
    };
    lastSignature.current = "";
    tick();
    const timer = setInterval(tick, POLL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [sessionId]);

  const consoleEntries = data?.console ?? [];
  const networkEntries = data?.network ?? [];
  const downloads = data?.downloads ?? [];
  const problemCounts: Record<ObsTab, number> = {
    console: consoleEntries.filter(isConsoleProblem).length,
    network: networkEntries.filter(isNetworkProblem).length,
    downloads: downloads.length,
  };

  return (
    <section
      data-observe=""
      className="flex shrink-0 flex-col border-t border-line bg-surface-raised"
    >
      <div className="flex h-[30px] shrink-0 items-center gap-0.5 px-1.5">
        {TABS.map(({ id, label, Icon }) => {
          const active = tab === id;
          const count = problemCounts[id];
          return (
            <button
              key={id}
              type="button"
              data-obs-tab={id}
              data-obs-count={count}
              aria-pressed={active}
              // 点已激活的页签 = 收起/展开：抽屉最常用的动作不必再找一个单独的按钮
              onClick={() => {
                if (active) setCollapsed((value) => !value);
                else {
                  setTab(id);
                  setCollapsed(false);
                }
              }}
              className={cn(
                "flex h-6 shrink-0 items-center gap-1.5 rounded-[5px] px-2 text-[11.5px] transition",
                active
                  ? "bg-surface-overlay text-text-primary"
                  : "text-text-muted hover:bg-surface-overlay hover:text-text-secondary",
              )}
            >
              <Icon {...ICON.xs} className="shrink-0" />
              {label}
              {count > 0 && (
                <span
                  className={cn(
                    "rounded-[3px] px-1 text-[10px]",
                    id === "downloads"
                      ? "bg-surface-raised text-text-secondary"
                      : "bg-danger-soft text-danger-fg",
                  )}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          title={collapsed ? "展开观测" : "收起观测"}
          aria-label={collapsed ? "展开观测" : "收起观测"}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] text-text-muted transition hover:bg-surface-overlay hover:text-text-primary"
        >
          {collapsed ? <ChevronUp {...ICON.sm} /> : <ChevronDown {...ICON.sm} />}
        </button>
      </div>

      {!collapsed && (
        <div data-obs-body="" className="max-h-[132px] min-h-0 overflow-y-auto px-2.5 pb-2">
          {tab === "console" && <ConsoleRows entries={consoleEntries} />}
          {tab === "network" && <NetworkRows entries={networkEntries} />}
          {tab === "downloads" && <DownloadRows entries={downloads} />}
        </div>
      )}
    </section>
  );
}

function Empty({ text }: { text: string }): React.JSX.Element {
  return <p className="px-1 py-3 text-[11px] text-text-muted">{text}</p>;
}

/** 级别 → 圆点颜色；未知级别按普通处理 */
function levelDot(level: string): string {
  if (level === "error") return "bg-danger";
  if (level === "warning") return "bg-warning";
  return "bg-line-strong";
}

function ConsoleRows({ entries }: { entries: ConsoleEntry[] }): React.JSX.Element {
  if (entries.length === 0) return <Empty text="自上次导航以来没有输出。" />;
  return (
    <>
      {entries.map((entry, index) => (
        <div
          key={index}
          data-obs-row="console"
          className="flex items-start gap-2 py-[3px] text-[11px] leading-relaxed"
        >
          <span
            className={cn("mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full", levelDot(entry.level))}
          />
          <span
            className={cn(
              "min-w-0 flex-1 break-words",
              isConsoleProblem(entry) ? "text-text-primary" : "text-text-secondary",
            )}
          >
            {entry.message}
          </span>
          {entry.source.length > 0 && (
            <span className="shrink-0 font-mono text-[10.5px] text-text-muted">
              {shortSource(entry.source)}
              {entry.line > 0 ? `:${entry.line}` : ""}
            </span>
          )}
        </div>
      ))}
    </>
  );
}

function NetworkRows({ entries }: { entries: NetworkEntry[] }): React.JSX.Element {
  if (entries.length === 0) return <Empty text="自上次导航以来没有捕获到请求。" />;
  return (
    <>
      {entries.map((entry, index) => {
        const problem = isNetworkProblem(entry);
        const tag = entry.error !== undefined ? entry.error : String(entry.statusCode ?? "?");
        return (
          <div
            key={index}
            data-obs-row="network"
            className="flex items-start gap-2 py-[3px] text-[11px] leading-relaxed"
          >
            <span
              className={cn(
                "shrink-0 rounded-[3px] px-1 font-mono text-[10px]",
                problem ? "bg-danger-soft text-danger-fg" : "bg-surface-overlay text-text-muted",
              )}
            >
              {tag}
            </span>
            <span className="min-w-0 flex-1 truncate text-text-secondary" title={entry.url}>
              <span className="font-mono">{entry.method}</span> {entry.url}
            </span>
            <span className="shrink-0 text-[10.5px] text-text-muted">{entry.resourceType}</span>
          </div>
        );
      })}
    </>
  );
}

function DownloadRows({ entries }: { entries: DownloadEntry[] }): React.JSX.Element {
  if (entries.length === 0) return <Empty text="本会话尚未触发任何下载。" />;
  return (
    <>
      {entries.map((entry, index) => (
        <div key={index} data-obs-row="downloads" className="py-[3px] text-[11px] leading-relaxed">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-text-secondary">
              {entry.filename}
            </span>
            <span
              className={cn(
                "shrink-0 text-[10.5px]",
                entry.state === "completed" ? "text-success-fg" : "text-warning",
              )}
            >
              {entry.state === "completed"
                ? formatBytes(entry.bytes)
                : `${entry.state}${entry.note !== undefined ? `：${entry.note}` : ""}`}
            </span>
          </div>
          <div className="truncate font-mono text-[10.5px] text-text-muted" title={entry.path}>
            {entry.path}
          </div>
        </div>
      ))}
    </>
  );
}
