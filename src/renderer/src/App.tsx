import { useCallback, useEffect, useState } from "react";
import {
  Check,
  ChevronDown,
  Copy,
  FolderOpen,
  Monitor,
  Moon,
  Plus,
  Settings as SettingsIcon,
  Sun,
  Trash2,
  Trees,
} from "lucide-react";
import { ICON } from "@/lib/icon";
import { applyTheme, loadTheme, saveTheme, type Theme } from "@/lib/theme";
import type { EnvReport, FirstRunReport, Project, ProviderConfig, SessionInfo } from "@shared/protocol";
import { BranchTree } from "./features/BranchTree";
import { Conversation } from "./features/Conversation";
import { FirstRunGate } from "./features/FirstRunGate";
import { ProjectChanges } from "./features/ProjectChanges";
import { Settings } from "./features/Settings";
import { cn } from "./lib/utils";

/** 主区视图 */
type MainView = "chat" | "changes" | "settings";

/** 主题三态按钮（亮 / 暗 / 跟随系统） */
const THEME_OPTIONS = [
  { value: "light" as const, label: "亮色", Icon: Sun },
  { value: "dark" as const, label: "暗色", Icon: Moon },
  { value: "system" as const, label: "跟随系统", Icon: Monitor },
];

/** M1 主界面：项目 → 会话 → 对话 */
export default function App(): React.JSX.Element {
  const [env, setEnv] = useState<EnvReport | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessionsByProject, setSessionsByProject] = useState<Map<string, SessionInfo[]>>(new Map());
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [activeSession, setActiveSession] = useState<SessionInfo | null>(null);
  const [secretReady, setSecretReady] = useState<boolean | null>(null);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [mainView, setMainView] = useState<MainView>("chat");
  const [firstRun, setFirstRun] = useState<FirstRunReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(() => loadTheme());
  /** 运行中的会话 → 开始时刻（用于侧栏「运行中 · mm:ss」） */
  const [runningSessions, setRunningSessions] = useState<Map<string, number>>(new Map());
  const [now, setNow] = useState(() => Date.now());

  // 主题挂载到下 <html>，并在变更时持久化
  useEffect(() => {
    applyTheme(theme);
    saveTheme(theme);
  }, [theme]);

  // 有会话在运行时每秒重渲染，驱动侧栏心跳计时
  useEffect(() => {
    if (runningSessions.size === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [runningSessions.size]);

  useEffect(() => {
    void (async () => {
      try {
        const [envReport, projectList, secrets, providerList] = await Promise.all([
          window.banyan.invoke("env.check", undefined),
          window.banyan.invoke("project.list", undefined),
          window.banyan.invoke("secrets.status", undefined),
          window.banyan.invoke("providers.list", undefined),
        ]);
        setEnv(envReport);
        setProjects(projectList);
        setSecretReady(secrets.deepseek);
        setProviders(providerList);
        if (projectList.length > 0) setActiveProject(projectList[0]!);

        // 首启引导：仅在尚未完成引导时弹出（已完成则直接进主界面）
        const report = await window.banyan.invoke("firstRun.check", undefined);
        if (!report.onboardingDone) setFirstRun(report);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  // 离开设置页时重新拉取 provider，让模型下拉及时反映改动
  useEffect(() => {
    if (mainView !== "settings") {
      void window.banyan.invoke("providers.list", undefined).then(setProviders);
    }
  }, [mainView]);

  // 全局监听会话视图：后台会话也能刷新标题、消息数与运行状态
  // （若只靠当前会话的回调，未选中的会话永远停在「新会话」）
  useEffect(() => {
    return window.banyan.on("session.view", (view) => {
      const firstUser = view.messages.find((item) => item.role === "user");
      setSessionsByProject((map) => {
        const next = new Map(map);
        for (const [projectId, list] of next) {
          if (!list.some((item) => item.id === view.sessionId)) continue;
          next.set(
            projectId,
            list.map((item) =>
              item.id === view.sessionId
                ? {
                    ...item,
                    title: firstUser?.text.slice(0, 30) || item.title,
                    messageCount: view.messages.length,
                    updatedAt: Date.now(),
                  }
                : item,
            ),
          );
          break;
        }
        return next;
      });
      // 记录运行中的会话及其开始时刻，供侧栏显示呼吸绿点与计时
      setRunningSessions((map) => {
        const next = new Map(map);
        if (view.running) {
          if (!next.has(view.sessionId)) next.set(view.sessionId, Date.now());
        } else {
          next.delete(view.sessionId);
        }
        return next;
      });
    });
  }, []);

  /** 拉取某项目的会话列表并写入缓存；force 时重拉 */
  const loadProjectSessions = useCallback(async (projectId: string) => {
    const list = await window.banyan.invoke("session.list", { projectId });
    setSessionsByProject((map) => new Map(map).set(projectId, list));
    return list;
  }, []);

  // 切换项目时：展开该项目并拉取其会话
  useEffect(() => {
    if (!activeProject) return;
    const projectId = activeProject.id;
    setExpandedProjects((set) => new Set(set).add(projectId));
    void (async () => {
      const list = await loadProjectSessions(projectId);
      setActiveSession((current) =>
        current && list.some((item) => item.id === current.id) ? current : (list[0] ?? null),
      );
    })();
  }, [activeProject, loadProjectSessions]);

  const pickProject = useCallback(async () => {
    try {
      const project = await window.banyan.invoke("project.pick", undefined);
      if (!project) return;
      setProjects(await window.banyan.invoke("project.list", undefined));
      setActiveProject(project);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const newSession = useCallback(async () => {
    if (!activeProject) return;
    try {
      const session = await window.banyan.invoke("session.create", {
        projectId: activeProject.id,
      });
      await loadProjectSessions(activeProject.id);
      setActiveSession(session);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [activeProject, loadProjectSessions]);

  /** 删除会话：确认 → 调后端 → 刷新列表并适时清空选中 */
  const deleteSession = useCallback(
    async (session: SessionInfo) => {
      if (!window.confirm(`确定删除会话「${session.title}」？此操作不可恢复。`)) return;
      try {
        await window.banyan.invoke("session.delete", { sessionId: session.id });
        const list = await loadProjectSessions(session.projectId);
        setActiveSession((current) => {
          if (current?.id !== session.id) return current;
          return list[0] ?? null;
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [loadProjectSessions],
  );

  return (
    <div className="flex h-full flex-col">
      {firstRun && (
        <FirstRunGate
          report={firstRun}
          onResolved={(choice) => {
            setFirstRun(null);
            // 选择「清空重来」后历史项目/会话已删，需重新拉取；并同步密钥状态
            void (async () => {
              const [projectList, secrets] = await Promise.all([
                window.banyan.invoke("project.list", undefined),
                window.banyan.invoke("secrets.status", undefined),
              ]);
              setProjects(projectList);
              setActiveProject(projectList[0] ?? null);
              setSecretReady(secrets.deepseek);
              if (choice === "fresh") setActiveSession(null);
            })();
          }}
        />
      )}
      <header className="flex h-[42px] shrink-0 items-center justify-between border-b border-line bg-surface-raised px-3.5">
        <div className="flex items-center gap-2">
          <Trees {...ICON.lg} className="text-text-primary" />
          <span className="text-[13.5px] font-semibold tracking-[.2px] text-text-primary">
            Banyan
          </span>
        </div>
        <div className="flex items-center gap-2">
          {env?.bashPath ? null : (
            <span className="text-[11.5px] text-danger">未找到 bash，命令工具不可用</span>
          )}
          <div className="flex items-center gap-0.5 rounded-[6px] border border-line p-0.5">
            {THEME_OPTIONS.map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => setTheme(item.value)}
                title={item.label}
                aria-label={`主题：${item.label}`}
                aria-pressed={theme === item.value}
                className={cn(
                  "flex h-6 w-6 items-center justify-center rounded-[5px] transition",
                  theme === item.value
                    ? "bg-surface-overlay text-text-primary"
                    : "text-text-muted hover:text-text-secondary",
                )}
              >
                <item.Icon {...ICON.xs} />
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setMainView((value) => (value === "settings" ? "chat" : "settings"))}
            title="设置"
            className={cn(
              "flex items-center gap-1.5 rounded-[6px] border px-2 py-1 text-[11.5px] transition",
              mainView === "settings"
                ? "border-accent bg-accent-soft text-text-primary"
                : "border-line text-text-secondary hover:border-line-strong hover:text-text-primary",
            )}
          >
            <SettingsIcon {...ICON.sm} />
            设置
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <aside className="flex w-[240px] shrink-0 flex-col border-r border-line bg-surface-raised">
          <SidebarSection
            title="项目"
            action={{ label: "打开", icon: <FolderOpen {...ICON.xs} />, onClick: () => void pickProject() }}
          >
            {projects.length === 0 ? (
              <Empty>还没有项目，点「打开」选择目录</Empty>
            ) : (
              projects.map((project) => {
                const expanded = expandedProjects.has(project.id);
                const list = sessionsByProject.get(project.id) ?? [];
                return (
                  <div key={project.id} className="mb-0.5">
                    <ProjectRow
                      project={project}
                      active={project.id === activeProject?.id}
                      expanded={expanded}
                      onToggle={() =>
                        setExpandedProjects((set) => {
                          const next = new Set(set);
                          if (next.has(project.id)) next.delete(project.id);
                          else next.add(project.id);
                          return next;
                        })
                      }
                      onActivate={() => setActiveProject(project)}
                      onNewSession={() => {
                        if (project.id !== activeProject?.id) setActiveProject(project);
                        void newSession();
                      }}
                    />
                    {expanded && (
                      <div className="mt-0.5 pl-3">
                        <div className="truncate px-2 py-0.5 font-mono text-[10.5px] text-text-muted">
                          {project.rootPath}
                        </div>
                        {list.length === 0 ? (
                          <div className="px-2 py-1.5 text-[11px] text-text-muted">还没有会话</div>
                        ) : (
                          list.map((session) => (
                            <SessionRow
                              key={session.id}
                              session={session}
                              active={session.id === activeSession?.id}
                              startedAt={runningSessions.get(session.id)}
                              now={now}
                              onClick={() => {
                                if (project.id !== activeProject?.id) setActiveProject(project);
                                setActiveSession(session);
                              }}
                              onDelete={() => void deleteSession(session)}
                            />
                          ))
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </SidebarSection>

          <div className="h-px shrink-0 bg-line" />

          {/* 会话分支：git graph 风格，标注当前会话在树中的位置 */}
          <div className="flex min-h-0 flex-1 flex-col">
            {activeSession ? (
              <BranchTree key={activeSession.id} sessionId={activeSession.id} />
            ) : (
              <SidebarSection title="会话分支">
                <Empty>选择一个会话查看分支</Empty>
              </SidebarSection>
            )}
          </div>
        </aside>

        <main className="flex-1 overflow-hidden">
          {error && (
            <div className="m-3.5 rounded-[8px] border border-danger/50 bg-danger-soft px-3.5 py-3 text-[12.5px] text-danger-fg">
              {error}
            </div>
          )}

          {secretReady === false && (
            <div className="m-3.5 rounded-[8px] border border-warning/50 bg-warning-soft px-3.5 py-3 text-[12.5px] text-warning">
              尚未配置 DeepSeek API Key，无法开始对话。
            </div>
          )}

          {mainView === "settings" ? (
            <Settings />
          ) : mainView === "changes" && activeProject ? (
            <ProjectChanges projectId={activeProject.id} />
          ) : activeSession && activeProject ? (
            <Conversation
              key={activeSession.id}
              sessionId={activeSession.id}
              cwd={activeProject.rootPath}
              providers={providers}
            />
          ) : (
            <div className="flex h-full items-center justify-center">
              <p className="text-[12.5px] text-text-muted">
                {activeProject ? "新建一个会话开始对话" : "打开一个项目目录开始"}
              </p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function SidebarSection({
  title,
  action,
  collapsible = true,
  children,
}: {
  title: string;
  action?: { label: string; icon: React.ReactNode; onClick: () => void };
  collapsible?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="group flex shrink-0 items-center gap-1.5 px-3.5 py-2">
        <button
          type="button"
          onClick={() => collapsible && setCollapsed((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          {collapsible && (
            <ChevronDown
              {...ICON.xs}
              className={cn(
                "shrink-0 text-text-muted transition-transform",
                collapsed && "-rotate-90",
              )}
            />
          )}
          <span className="truncate text-[11px] font-semibold uppercase tracking-[.6px] text-text-muted">
            {title}
          </span>
        </button>
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            className="flex shrink-0 items-center gap-1 rounded-[6px] px-1.5 py-1 text-[11.5px] text-text-secondary opacity-0 transition group-hover:opacity-100 hover:bg-surface-overlay hover:text-text-primary focus:opacity-100"
          >
            {action.icon}
            {action.label}
          </button>
        )}
      </div>
      {!collapsed && <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">{children}</div>}
    </div>
  );
}

/** 相对时间：今天 HH:mm / 昨天 / M月D日 */
function formatAgo(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate()
  ) {
    return "昨天";
  }
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 已运行时长：mm:ss */
function formatElapsed(startedAt: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - startedAt) / 1000));
  return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
}

/** 项目行：折叠三角 + 项目名 + 新建会话 */
function ProjectRow({
  project,
  active,
  expanded,
  onToggle,
  onActivate,
  onNewSession,
}: {
  project: Project;
  active: boolean;
  expanded: boolean;
  onToggle: () => void;
  onActivate: () => void;
  onNewSession: () => void;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "group flex items-center gap-1 rounded-[7px] border-l-2 py-1.5 pl-1.5 pr-1.5 transition",
        active
          ? "border-accent bg-surface-overlay"
          : "border-transparent hover:bg-surface-overlay/60",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-label={expanded ? "收起" : "展开"}
        className="flex h-4 w-4 shrink-0 items-center justify-center text-text-muted transition hover:text-text-primary"
      >
        <ChevronDown
          {...ICON.xs}
          className={cn("transition-transform", !expanded && "-rotate-90")}
        />
      </button>
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-text-muted" />
      <button type="button" onClick={onActivate} className="min-w-0 flex-1 text-left">
        <div className="truncate text-[12.5px] text-text-primary">{project.name}</div>
      </button>
      <button
        type="button"
        onClick={onNewSession}
        title="新建会话"
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] text-text-muted opacity-0 transition group-hover:opacity-100 hover:bg-surface-raised hover:text-text-primary focus:opacity-100"
      >
        <Plus {...ICON.xs} />
      </button>
    </div>
  );
}

/** 会话行：状态点 + 标题 / 副标题（运行中带计时），悬停显示复制/删除 */
function SessionRow({
  session,
  active,
  startedAt,
  now,
  onClick,
  onDelete,
}: {
  session: SessionInfo;
  active: boolean;
  startedAt?: number;
  now: number;
  onClick: () => void;
  onDelete: () => void;
}): React.JSX.Element {
  const running = startedAt !== undefined;
  const [copied, setCopied] = useState(false);

  const copyId = (): void => {
    void navigator.clipboard.writeText(session.id).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div
      className={cn(
        "group/session flex w-full items-center gap-2 rounded-[6px] px-1.5 py-1.5 transition",
        active ? "bg-surface-overlay" : "hover:bg-surface-overlay/60",
      )}
    >
      <button type="button" onClick={onClick} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <span
          className={cn(
            "h-[7px] w-[7px] shrink-0 rounded-full border-[1.5px]",
            running
              ? "pulse-dot border-success bg-success"
              : active
                ? "border-accent bg-accent"
                : "border-text-muted",
          )}
        />
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block truncate text-[12.5px]",
              active ? "text-text-primary" : "text-text-secondary",
            )}
          >
            {session.title}
          </span>
          <span className="block truncate text-[10.5px] text-text-muted">
            {running ? `运行中 · ${formatElapsed(startedAt, now)}` : formatAgo(session.updatedAt)}
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={copyId}
        title={copied ? "已复制" : "复制会话 ID"}
        className={cn(
          "flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] text-text-muted transition hover:bg-surface-raised hover:text-text-primary focus:opacity-100",
          copied ? "text-success-fg opacity-100" : "opacity-0 group-hover/session:opacity-100",
        )}
      >
        {copied ? <Check {...ICON.xs} /> : <Copy {...ICON.xs} />}
      </button>
      <button
        type="button"
        onClick={onDelete}
        disabled={running}
        title={running ? "运行中的会话不可删除" : "删除会话"}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] text-text-muted opacity-0 transition group-hover/session:opacity-100 hover:bg-surface-raised hover:text-danger-fg focus:opacity-100 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-text-muted"
      >
        <Trash2 {...ICON.xs} />
      </button>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p className="px-3 py-6 text-center text-[11.5px] leading-relaxed text-text-muted">
      {children}
    </p>
  );
}
