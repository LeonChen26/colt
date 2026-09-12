/**
 * 分支树：自绘 SVG，展示会话的全部分支与当前活跃路径
 * 点击任一节点可 navigateTree 跳回该处，之后的对话会形成新分支
 * 作者：陕耀云栈WorkMate
 */
import { useEffect, useMemo, useState } from "react";
import { GitBranch, RefreshCw } from "lucide-react";
import type { BranchNode } from "@shared/protocol";
import { cn } from "../lib/utils";

const ROW_HEIGHT = 34;
const COL_WIDTH = 22;
const LEFT_PAD = 16;

interface Laid extends BranchNode {
  depth: number;
  row: number;
}

/** 按父子关系做深度优先布局：depth 决定横向缩进，row 决定纵向位置 */
function layout(nodes: BranchNode[]): Laid[] {
  const children = new Map<string | null, BranchNode[]>();
  for (const node of nodes) {
    const list = children.get(node.parentId) ?? [];
    list.push(node);
    children.set(node.parentId, list);
  }

  const result: Laid[] = [];
  let row = 0;

  const walk = (parentId: string | null, depth: number): void => {
    for (const node of children.get(parentId) ?? []) {
      result.push({ ...node, depth, row: row++ });
      const kids = children.get(node.id) ?? [];
      // 单链不增加缩进，只有真正分叉时才加，避免树被拉得很宽
      walk(node.id, kids.length > 1 ? depth + 1 : depth);
    }
  };

  walk(null, 0);
  return result;
}

const KIND_COLOR: Record<string, string> = {
  user: "#3b82f6",
  assistant: "#a855f7",
  toolResult: "#64748b",
  compaction: "#f59e0b",
  branch_summary: "#f59e0b",
};

export function BranchTree({
  sessionId,
  onNavigated,
}: {
  sessionId: string;
  onNavigated?: () => void;
}): React.JSX.Element {
  const [nodes, setNodes] = useState<BranchNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useMemo(
    () => async () => {
      setLoading(true);
      setError(null);
      try {
        setNodes(await window.banyan.invoke("session.branches", { sessionId }));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [sessionId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const laid = useMemo(() => layout(nodes), [nodes]);
  const maxDepth = laid.reduce((max, node) => Math.max(max, node.depth), 0);
  const height = Math.max(laid.length * ROW_HEIGHT + 16, 80);
  const byId = useMemo(() => new Map(laid.map((node) => [node.id, node])), [laid]);

  const navigate = async (targetId: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await window.banyan.invoke("session.navigate", { sessionId, targetId });
      await load();
      onNavigated?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="flex w-[340px] shrink-0 flex-col border-l border-[--color-border-subtle] bg-[--color-surface-raised]">
      <div className="flex shrink-0 items-center justify-between border-b border-[--color-border-subtle] px-3 py-2">
        <span className="flex items-center gap-1.5 text-xs font-medium text-[--color-text-secondary]">
          <GitBranch size={12} />
          分支树
        </span>
        <button
          type="button"
          onClick={() => void load()}
          className="text-[--color-text-muted] transition hover:text-[--color-text-primary]"
          title="刷新"
        >
          <RefreshCw size={12} className={cn(loading && "animate-spin")} />
        </button>
      </div>

      {error && (
        <div className="m-2 rounded-md border border-[--color-danger]/50 bg-[--color-danger]/10 px-2 py-1.5 text-xs text-[--color-danger]">
          {error}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {laid.length === 0 ? (
          <p className="px-3 py-8 text-center text-xs text-[--color-text-muted]">
            {loading ? "加载中…" : "还没有对话记录"}
          </p>
        ) : (
          <div className="relative" style={{ height }}>
            <svg
              className="absolute top-0 left-0"
              width={LEFT_PAD + (maxDepth + 1) * COL_WIDTH}
              height={height}
            >
              {laid.map((node) => {
                const parent = node.parentId ? byId.get(node.parentId) : undefined;
                if (!parent) return null;
                const x1 = LEFT_PAD + parent.depth * COL_WIDTH;
                const y1 = parent.row * ROW_HEIGHT + ROW_HEIGHT / 2;
                const x2 = LEFT_PAD + node.depth * COL_WIDTH;
                const y2 = node.row * ROW_HEIGHT + ROW_HEIGHT / 2;
                return (
                  <path
                    key={node.id}
                    d={`M ${x1} ${y1} L ${x1} ${y2 - 10} Q ${x1} ${y2} ${x2} ${y2}`}
                    fill="none"
                    stroke={node.onActivePath ? "#3b82f6" : "#3f3f46"}
                    strokeWidth={node.onActivePath ? 1.6 : 1}
                  />
                );
              })}
              {laid.map((node) => (
                <circle
                  key={node.id}
                  cx={LEFT_PAD + node.depth * COL_WIDTH}
                  cy={node.row * ROW_HEIGHT + ROW_HEIGHT / 2}
                  r={node.isTip ? 5.5 : 3.5}
                  fill={node.onActivePath ? (KIND_COLOR[node.kind] ?? "#64748b") : "#3f3f46"}
                  stroke={node.isTip ? "#e4e4e7" : "none"}
                  strokeWidth={node.isTip ? 1.5 : 0}
                />
              ))}
            </svg>

            {laid.map((node) => (
              <button
                key={node.id}
                type="button"
                disabled={busy || node.isTip}
                onClick={() => void navigate(node.id)}
                title={node.isTip ? "当前所在位置" : "跳转到此处（之后的对话会形成新分支）"}
                className={cn(
                  "absolute flex items-center rounded px-2 py-1 text-left text-xs transition",
                  node.isTip ? "cursor-default" : "hover:bg-[--color-surface-overlay]",
                  node.onActivePath ? "text-[--color-text-primary]" : "text-[--color-text-muted]",
                )}
                style={{
                  top: node.row * ROW_HEIGHT + 4,
                  left: LEFT_PAD + (maxDepth + 1) * COL_WIDTH,
                  width: `calc(100% - ${LEFT_PAD + (maxDepth + 1) * COL_WIDTH + 8}px)`,
                  height: ROW_HEIGHT - 8,
                }}
              >
                <span className="w-14 shrink-0 text-[10px] text-[--color-text-muted]">
                  {labelOf(node.kind)}
                </span>
                <span className="truncate">{node.summary}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <p className="shrink-0 border-t border-[--color-border-subtle] px-3 py-2 text-xs leading-relaxed text-[--color-text-muted]">
        点击历史节点可跳回该处，之后的对话会形成新分支，原分支保留。
      </p>
    </aside>
  );
}

function labelOf(kind: string): string {
  switch (kind) {
    case "user":
      return "用户";
    case "assistant":
      return "助手";
    case "toolResult":
      return "工具";
    case "compaction":
      return "压缩";
    case "branch_summary":
      return "分支摘要";
    default:
      return kind;
  }
}
