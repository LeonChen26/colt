/**
 * 首次运行引导弹窗。
 *
 * 两种场景：
 * - 全新环境（无历史数据）→ 显示欢迎与使用前置条件；
 * - 检测到历史数据 → 让用户选择「沿用历史数据」或「清空重来」。
 *
 */
import { useState } from "react";
import { Database, FolderOpen, RefreshCw, Trash2 } from "lucide-react";
import { ICON } from "@/lib/icon";
import type { FirstRunChoice, FirstRunReport } from "@shared/protocol";
import { cn } from "../lib/utils";

export function FirstRunGate({
  report,
  onResolved,
}: {
  report: FirstRunReport;
  onResolved: (choice: FirstRunChoice) => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState<FirstRunChoice | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = async (choice: FirstRunChoice): Promise<void> => {
    setBusy(choice);
    setError(null);
    try {
      await window.colt.invoke("firstRun.resolve", { choice });
      onResolved(choice);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  const historical = report.hasHistoricalData;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-[520px] max-w-[92vw] rounded-xl border border-line bg-surface-raised p-6 shadow-2xl">
        <h1 className="text-lg font-semibold text-text-primary">
          {historical ? "检测到历史数据" : "欢迎使用 Colt"}
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-text-secondary">
          {historical
            ? "本机已存在 Colt 的工作台数据。请选择是继续沿用，还是清空后重新开始。"
            : "Colt 是桌面 Agent 工作台。开始前请确认运行环境满足要求，随后即可打开项目目录与 Agent 对话。"}
        </p>

        <div className="mt-4 rounded-lg border border-line bg-surface p-3 text-xs">
          {historical ? (
            <ul className="space-y-1.5 text-text-secondary">
              <li className="flex items-center gap-2">
                <FolderOpen {...ICON.sm} />
                <span>项目 {report.projectCount} 个 · 会话 {report.sessionCount} 个</span>
              </li>
              <li className="flex items-center gap-2">
                <Database {...ICON.sm} />
                <span className="truncate">数据目录：{report.userDataPath}</span>
              </li>
              <li className="flex items-center gap-2">
                <Database {...ICON.sm} />
                <span>{report.hasSecret ? "已配置 API Key" : "尚未配置 API Key"}</span>
              </li>
            </ul>
          ) : (
            <ul className="space-y-1.5 text-text-secondary">
              <li>1. 需要 Git for Windows（提供 bash，命令工具依赖它）</li>
              <li>2. 需要在「设置」中配置模型 API Key</li>
              <li>3. 打开一个项目目录即可新建会话</li>
            </ul>
          )}
        </div>

        {error && (
          <p className="mt-3 rounded-md border border-danger/50 bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          {historical ? (
            <>
              <ActionButton
                variant="ghost"
                icon={<Trash2 {...ICON.md} />}
                label="清空重来"
                loading={busy === "fresh"}
                disabled={busy !== null}
                onClick={() => void decide("fresh")}
              />
              <ActionButton
                variant="primary"
                icon={<RefreshCw {...ICON.md} />}
                label="沿用历史数据"
                loading={busy === "import"}
                disabled={busy !== null}
                onClick={() => void decide("import")}
              />
            </>
          ) : (
            <ActionButton
              variant="primary"
              icon={<RefreshCw {...ICON.md} />}
              label="开始使用"
              loading={busy === "import"}
              disabled={busy !== null}
              onClick={() => void decide("import")}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function ActionButton({
  variant,
  icon,
  label,
  loading,
  disabled,
  onClick,
}: {
  variant: "primary" | "ghost";
  icon: React.ReactNode;
  label: string;
  loading: boolean;
  disabled: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-3.5 py-2 text-sm transition disabled:opacity-50",
        variant === "primary"
          ? "bg-accent text-accent-fg hover:opacity-90"
          : "border border-line text-text-secondary hover:text-text-primary",
      )}
    >
      {icon}
      {loading ? "处理中…" : label}
    </button>
  );
}
