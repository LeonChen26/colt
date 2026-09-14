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
 * 四个刻意的选择：
 *   1. **轮询而不是主进程逐条推**：console / network 事件可以非常密集，逐条推就是 IPC 洪泛；
 *      抽屉展示的是「缓冲区此刻的样子」，轮询语义上更贴切。只在「浏览器」页签挂载时轮询。
 *   2. **按时间顺序平铺**，不把问题提到前面：这是观测台（console/network）的通用心智模型；
 *      「有没有问题」由页签上的计数徽标回答，不需要靠重排来暗示。
 *   3. **不做过滤**：给模型的文本为了省上下文会丢掉成功请求，这里全给——用户可能正是想看全量。
 *   4. **行是概览，点开才是全貌（N1）**：一行装不下完整 URL / 绝对路径，原先只能靠原生 tooltip 兜底。
 *      现在点行在下方展开「字段表 + 复制」，同时**撤掉了 URL / 路径上的 tooltip**——
 *      它只是「看不到全貌」的临时拐杖，留着就是同一件事（看全那个地址）两个入口。
 *      ⚠️ 代价是**整行是一个 `<button>`**，于是行上的文本不再能直接框选——
 *      这正是给详情段配复制按钮的理由（要选的内容都能一键拿走）。
 *
 * N1 只做了「把已有的字段看全」。**时间戳 / 耗时 / 请求头不在本半**：那三个字段
 * `ConsoleEntry` / `NetworkEntry` 里压根没有，要扩主进程的 `CaptureBuffer` 与协议类型，
 * 还会牵动 `browser_read` 给模型的文本（`formatConsole` / `formatNetwork`，被压缩过是刻意的）。
 */
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, ChevronUp, Copy, Globe, Package, Terminal } from "lucide-react";
import { ICON } from "@/lib/icon";
import type { BrowserObservation, ConsoleEntry, DownloadEntry, NetworkEntry } from "@shared/protocol";
import { formatBytes } from "../../lib/format";
import {
  consoleFields,
  consoleRowKey,
  downloadFields,
  downloadRowKey,
  networkFields,
  networkRowKey,
  observeCopyText,
  type ObsField,
  type ObsTab,
} from "../../lib/observe-detail";
import { cn } from "../../lib/utils";

/** 轮询间隔：本地 IPC、载荷有上限，1s 足够跟手又不至于变成洪泛 */
const POLL_MS = 1000;

/** 与主进程 `formatConsole` 同一判据，保证徽标数与「agent 会被告知的问题数」一致 */
function isConsoleProblem(entry: ConsoleEntry): boolean {
  return entry.level === "error" || entry.level === "warning";
}

/** 与主进程 `formatNetwork` 同一判据 */
function isNetworkProblem(entry: NetworkEntry): boolean {
  return entry.error !== undefined || (entry.statusCode ?? 0) >= 400;
}

/** 源码地址压成文件名：完整 URL 在这个宽度里只是噪声（要看全就点开这一行） */
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
   * 展开的那一行（**一次只展开一条**）。键是 `lib/observe-detail.ts` 给的行签名，
   * 不是下标——轮询会追加 / 裁掉条目，下标会错位到别的行上。
   * 抽屉正文只有 132px 高，展开多条只会互相挤出去，所以做成单选。
   */
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  /**
   * 上一份快照的签名。缓冲区多半时候是不变的，而轮询每次都会返回新对象——
   * 不比对就会每秒重渲染整棵列表。比对省掉的是「多数轮次都是空转」这件事。
   */
  const lastSignature = useRef("");

  // 只在浏览器页签挂载时轮询：切走页签即卸载，轮询随之停止
  useEffect(() => {
    let disposed = false;
    const tick = (): void => {
      void window.colt
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
  const toggleRow = (key: string): void =>
    setExpandedKey((current) => (current === key ? null : key));

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
                  // 换页签即收起上一个页签里展开的那一条（键本身带页签前缀，这里是让语义显式）
                  setExpandedKey(null);
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
          {tab === "console" && (
            <ConsoleRows entries={consoleEntries} expandedKey={expandedKey} onToggle={toggleRow} />
          )}
          {tab === "network" && (
            <NetworkRows entries={networkEntries} expandedKey={expandedKey} onToggle={toggleRow} />
          )}
          {tab === "downloads" && (
            <DownloadRows entries={downloads} expandedKey={expandedKey} onToggle={toggleRow} />
          )}
        </div>
      )}
    </section>
  );
}

interface RowsProps<T> {
  entries: T[];
  expandedKey: string | null;
  onToggle: (key: string) => void;
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

/**
 * 可展开的一行：整行是一个 `<button>`（键盘可达、有可见 feedback），
 * `data-obs-row` 保留在**概览行本身**上，详情段是它的**兄弟**而非子节点——
 * 于是「读每一行概览文本」的既有断言不会把详情文本一起读进去。
 */
function ObsRow({
  tab,
  rowKey,
  open,
  onToggle,
  children,
}: {
  tab: ObsTab;
  rowKey: string;
  open: boolean;
  onToggle: (key: string) => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-obs-row={tab}
      data-obs-expand=""
      aria-expanded={open}
      title={open ? "收起详情" : "展开详情"}
      onClick={() => onToggle(rowKey)}
      className="-mx-1 flex w-[calc(100%+8px)] items-start gap-2 rounded-[4px] px-1 py-[3px] text-left text-[11px] leading-relaxed transition hover:bg-surface-overlay"
    >
      {children}
      <ChevronRight
        {...ICON.xs}
        className={cn("mt-[3px] shrink-0 text-text-muted transition", open && "rotate-90")}
      />
    </button>
  );
}

/** 字段表 + 复制：三个页签共用（复制沿用 `Markdown.tsx` / `App.tsx` 的既有做法，不需要新 IPC） */
function Detail({ fields }: { fields: ObsField[] }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  /**
   * 展开后把自己滚进可视区。正文只有 132px 高，而详情段有近百像素——
   * 在下面的行上点开时，内容会落在视野之外，用户只会看到箭头转了，
   * 那就是「点了像没反应」（`AGENTS.md` §3.6）。
   * `block: "nearest"` 是最小滚动：已经看得见就一点不动。
   */
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "nearest" });
  }, []);

  const copy = (): void => {
    void navigator.clipboard.writeText(observeCopyText(fields)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div
      ref={ref}
      data-obs-detail=""
      className="mb-1 ml-4 rounded-[5px] border border-line bg-surface-overlay/50 px-2 py-1.5"
    >
      {fields.map((item) => (
        <div key={item.label} className="flex items-start gap-2 text-[11px] leading-relaxed">
          <span className="w-[46px] shrink-0 text-text-muted">{item.label}</span>
          {/* 值一律换行、**不截断**：这就是本功能的全部意义（长 URL / 绝对路径要看得全） */}
          <span
            data-obs-field={item.label}
            className={cn(
              "min-w-0 flex-1 break-all text-text-secondary",
              item.mono && "font-mono text-[10.5px]",
            )}
          >
            {item.value}
          </span>
        </div>
      ))}
      <div className="mt-1 flex justify-end">
        <button
          type="button"
          data-obs-copy=""
          onClick={copy}
          title="复制这条观测的完整字段"
          className="flex h-5 items-center gap-1 rounded-[4px] px-1.5 text-[10.5px] text-text-muted transition hover:bg-surface-overlay hover:text-text-primary"
        >
          {copied ? <Check {...ICON.xs} /> : <Copy {...ICON.xs} />}
          {copied ? "已复制" : "复制"}
        </button>
      </div>
    </div>
  );
}

function ConsoleRows({ entries, expandedKey, onToggle }: RowsProps<ConsoleEntry>): React.JSX.Element {
  if (entries.length === 0) return <Empty text="自上次导航以来没有输出。" />;
  return (
    <>
      {entries.map((entry, index) => {
        const rowKey = consoleRowKey(entry);
        const open = expandedKey === rowKey;
        return (
          <div key={index} data-obs-item="console">
            <ObsRow tab="console" rowKey={rowKey} open={open} onToggle={onToggle}>
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
            </ObsRow>
            {open && <Detail fields={consoleFields(entry)} />}
          </div>
        );
      })}
    </>
  );
}

function NetworkRows({ entries, expandedKey, onToggle }: RowsProps<NetworkEntry>): React.JSX.Element {
  if (entries.length === 0) return <Empty text="自上次导航以来没有捕获到请求。" />;
  return (
    <>
      {entries.map((entry, index) => {
        const problem = isNetworkProblem(entry);
        const tag = entry.error !== undefined ? entry.error : String(entry.statusCode ?? "?");
        const rowKey = networkRowKey(entry);
        const open = expandedKey === rowKey;
        return (
          <div key={index} data-obs-item="network">
            <ObsRow tab="network" rowKey={rowKey} open={open} onToggle={onToggle}>
              <span
                className={cn(
                  "shrink-0 rounded-[3px] px-1 font-mono text-[10px]",
                  problem ? "bg-danger-soft text-danger-fg" : "bg-surface-overlay text-text-muted",
                )}
              >
                {tag}
              </span>
              <span className="min-w-0 flex-1 truncate text-text-secondary">
                <span className="font-mono">{entry.method}</span> {entry.url}
              </span>
              <span className="shrink-0 text-[10.5px] text-text-muted">{entry.resourceType}</span>
            </ObsRow>
            {open && <Detail fields={networkFields(entry)} />}
          </div>
        );
      })}
    </>
  );
}

function DownloadRows({ entries, expandedKey, onToggle }: RowsProps<DownloadEntry>): React.JSX.Element {
  if (entries.length === 0) return <Empty text="本会话尚未触发任何下载。" />;
  return (
    <>
      {entries.map((entry, index) => {
        const rowKey = downloadRowKey(entry);
        const open = expandedKey === rowKey;
        return (
          <div key={index} data-obs-item="downloads">
            <ObsRow tab="downloads" rowKey={rowKey} open={open} onToggle={onToggle}>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
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
                </span>
                <span className="block truncate font-mono text-[10.5px] text-text-muted">
                  {entry.path}
                </span>
              </span>
            </ObsRow>
            {open && <Detail fields={downloadFields(entry)} />}
          </div>
        );
      })}
    </>
  );
}
