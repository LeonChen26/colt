import { useCallback, useEffect, useState } from "react";
import {
  FileDiff,
  FolderOpen,
  MessageSquare,
  MessageSquarePlus,
  Settings as SettingsIcon,
  ShieldAlert,
} from "lucide-react";
import type { EnvReport, Project, ProviderConfig, SessionInfo } from "@shared/protocol";
import { Conversation } from "./features/Conversation";
import { ProjectChanges } from "./features/ProjectChanges";
import { Settings } from "./features/Settings";
import { cn } from "./lib/utils";

/** 主区视图 */
type MainView = "chat" | "changes" | "settings";

/** M1 主界面：项目 → 会话 → 对话
 *  作者：陕耀云栈WorkMate */
export default function App(): React.JSX.Element {
  const [env, setEnv] = useState<EnvReport | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [activeSession, setActiveSession] = useState<SessionInfo | null>(null);
  const [secretReady, setSecretReady] = useState<boolean | null>(null);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [mainView, setMainView] = useState<MainView>("chat");
  const [error, setError] = useState<string | null>(null);

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

  // 全局监听会话视图：后台会话也能刷新标题与消息数
  // （若只靠当前会话的回调，未选中的会话永远停在「新会话」）
  useEffect(() => {
    return window.banyan.on("session.view", (view) => {
      const firstUser = view.messages.find((item) => item.role === "user");
      setSessions((list) =>
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
    });
  }, []);

  useEffect(() => {
    if (!activeProject) return;
    void (async () => {
      const list = await window.banyan.invoke("session.list", { projectId: activeProject.id });
      setSessions(list);
      setActiveSession(list[0] ?? null);
    })();
  }, [activeProject]);

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
      setSessions(await window.banyan.invoke("session.list", { projectId: activeProject.id }));
      setActiveSession(session);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [activeProject]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-[--color-border-subtle] bg-[--color-surface-raised] px-4">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold tracking-wide">Banyan</span>
          <span className="text-xs text-[--color-text-muted]">桌面 Agent 工作台</span>
        </div>
        <div className="flex items-center gap-3">
          {activeProject && (
            <nav className="flex items-center gap-1 rounded-md border border-[--color-border-subtle] p-0.5">
              <ViewTab
                active={mainView === "chat"}
                icon={<MessageSquare size={12} />}
                label="会话"
                onClick={() => setMainView("chat")}
              />
              <ViewTab
                active={mainView === "changes"}
                icon={<FileDiff size={12} />}
                label="改动"
                onClick={() => setMainView("changes")}
              />
              <ViewTab
                active={mainView === "settings"}
                icon={<SettingsIcon size={12} />}
                label="设置"
                onClick={() => setMainView("settings")}
              />
            </nav>
          )}
          {env?.bashPath ? null : (
            <span className="text-xs text-[--color-danger]">未找到 bash，命令工具不可用</span>
          )}
          <span className="flex items-center gap-1.5 rounded-full border border-[--color-warning]/40 bg-[--color-warning]/10 px-2.5 py-1 text-xs text-[--color-warning]">
            <ShieldAlert size={13} />
            全权执行模式
          </span>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <aside className="flex w-64 shrink-0 flex-col border-r border-[--color-border-subtle] bg-[--color-surface-raised]">
          <SidebarSection
            title="项目"
            action={{ label: "打开", icon: <FolderOpen size={14} />, onClick: () => void pickProject() }}
          >
            {projects.length === 0 ? (
              <Empty>还没有项目，点「打开」选择目录</Empty>
            ) : (
              projects.map((project) => (
                <SidebarItem
                  key={project.id}
                  active={project.id === activeProject?.id}
                  title={project.name}
                  subtitle={project.rootPath}
                  onClick={() => setActiveProject(project)}
                />
              ))
            )}
          </SidebarSection>

          <div className="h-px bg-[--color-border-subtle]" />

          <SidebarSection
            title="会话"
            action={
              activeProject
                ? {
                    label: "新建",
                    icon: <MessageSquarePlus size={14} />,
                    onClick: () => void newSession(),
                  }
                : undefined
            }
          >
            {!activeProject ? (
              <Empty>先选择一个项目</Empty>
            ) : sessions.length === 0 ? (
              <Empty>还没有会话，点「新建」开始</Empty>
            ) : (
              sessions.map((session) => (
                <SidebarItem
                  key={session.id}
                  active={session.id === activeSession?.id}
                  title={session.title}
                  subtitle={new Date(session.updatedAt).toLocaleString("zh-CN")}
                  onClick={() => setActiveSession(session)}
                />
              ))
            )}
          </SidebarSection>
        </aside>

        <main className="flex-1 overflow-hidden">
          {error && (
            <div className="m-4 rounded-lg border border-[--color-danger]/50 bg-[--color-danger]/10 px-4 py-3 text-sm text-[--color-danger]">
              {error}
            </div>
          )}

          {secretReady === false && (
            <div className="m-4 rounded-lg border border-[--color-warning]/50 bg-[--color-warning]/10 px-4 py-3 text-sm text-[--color-warning]">
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
              <p className="text-sm text-[--color-text-muted]">
                {activeProject ? "新建一个会话开始对话" : "打开一个项目目录开始"}
              </p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function ViewTab({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded px-2.5 py-1 text-xs transition",
        active
          ? "bg-[--color-surface-overlay] text-[--color-text-primary]"
          : "text-[--color-text-secondary] hover:text-[--color-text-primary]",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function SidebarSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: { label: string; icon: React.ReactNode; onClick: () => void };
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between px-4 py-2.5">
        <span className="text-xs font-medium tracking-wide text-[--color-text-secondary]">
          {title}
        </span>
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[--color-text-secondary] transition hover:bg-[--color-surface-overlay] hover:text-[--color-text-primary]"
          >
            {action.icon}
            {action.label}
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">{children}</div>
    </div>
  );
}

function SidebarItem({
  active,
  title,
  subtitle,
  onClick,
}: {
  active: boolean;
  title: string;
  subtitle: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "mb-1 w-full rounded-md px-2 py-2 text-left transition",
        active ? "bg-[--color-surface-overlay]" : "hover:bg-[--color-surface-overlay]/60",
      )}
    >
      <div className="truncate text-sm text-[--color-text-primary]">{title}</div>
      <div className="truncate text-xs text-[--color-text-muted]">{subtitle}</div>
    </button>
  );
}

function Empty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p className="px-2 py-6 text-center text-xs leading-relaxed text-[--color-text-muted]">
      {children}
    </p>
  );
}
