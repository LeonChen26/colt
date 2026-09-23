// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  Check,
  ChevronDown,
  Copy,
  FileDiff,
  FolderOpen,
  Monitor,
  Moon,
  Pin,
  Plus,
  Settings as SettingsIcon,
  Sun,
  Trash2,
} from "lucide-react";
import { formatSessionStamp } from "@/lib/format";
import { ICON } from "@/lib/icon";
import { applyTheme, loadTheme, saveTheme, type Theme } from "@/lib/theme";
import { useVisibleInterval } from "@/lib/use-visible-interval";
import { hasUsableProvider } from "@shared/model-ref";
import type { EnvReport, FirstRunReport, Project, ProviderConfig, SessionInfo } from "@shared/protocol";
import type { ThinkingLevel } from "@shared/thinking-level";
import { Conversation } from "./features/Conversation";
import { dropCachedView } from "./features/Conversation/view-cache";
import { FirstRunGate } from "./features/FirstRunGate";
import { ProjectChanges } from "./features/ProjectChanges";
import { Settings } from "./features/Settings";
import { isDraftSession, shouldOfferDraft } from "./lib/session";
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
  /**
   * 是否已有「可用的模型服务」（任一 provider 配了密钥且填了模型）。
   * 不能用「内置 DeepSeek 是否配了密钥」代替：只配 OpenAI 兼容服务时同样能对话，
   * 按内置项判定会让黄色警告一直挂着（假报错）。
   */
  const [modelServiceReady, setModelServiceReady] = useState<boolean | null>(null);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [mainView, setMainView] = useState<MainView>("chat");
  const [firstRun, setFirstRun] = useState<FirstRunReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(() => loadTheme());
  /** 运行中的会话 → 开始时刻（用于侧栏「运行中 · mm:ss」） */
  const [runningSessions, setRunningSessions] = useState<Map<string, number>>(new Map());
  /**
   * 已停止会话 id → 停止原因。
   * worker 被空闲回收或崩溃后进程消失，但列表项与消息仍保留，界面看上去“会话还在”。
   * 主进程以 session.status 告知，侧栏据此区分：
   * - "dormant"：空闲休眠（长时间未用被回收 / 主动关闭），低调提示「空闲休眠 · 发送即恢复」
   * - "crashed"：异常退出，醒目提示「异常中断 · 发送即恢复」
   * 重新就绪（idle）或运行中（running）时移出。
   */
  const [offlineSessions, setOfflineSessions] = useState<Map<string, "dormant" | "crashed">>(
    new Map(),
  );
  /**
   * 被用户「钉住」的会话 id：系统不再自动回收它们的 worker（空闲不回收、池满最后才淘汰）。
   *
   * 真相在主进程（`session-pins.ts`），这里只是让图钉的视觉状态跟上——所以每次切换都
   * 回主进程写一次，挂载时用 `session.listPinned` 对齐回来（dev 下 reload 也走这条）。
   */
  const [pinnedSessions, setPinnedSessions] = useState<Set<string>>(() => new Set());
  /**
   * 有待用户处置的请求的会话 id：审批（等人给许可）与提问（等人给信息）两类。
   *
   * 与「运行中」正交：会话确实还在跑，但 Agent 正阻塞在等人回话上不动了。
   * 只显示「运行中 · mm:ss」会让人以为它在正常干活，实际上它在等用户拍板——
   * 而这个状态是有代价的：5 分钟内没人处置，审批被自动拒绝、提问则落到「按假设继续」。
   *
   * 两类**分开存**：同一会话可能同时挂着审批与提问，合成一份集合就会互相清标记——
   * 审批处置完提问还在，标记不能跟着一起消失。
   */
  const [approvalSessions, setApprovalSessions] = useState<Set<string>>(() => new Set());
  const [questionSessions, setQuestionSessions] = useState<Set<string>>(() => new Set());
  /**
   * 当前会话**自己**属于哪个项目——中间区的工作目录（cwd）由此推出，而不是取当前选中的项目。
   *
   * 「会话归哪个项目」与「worker 在哪个目录里干活」必须是同一条链：归属由 `projectId` 决定
   * （主进程落库、建 JSONL 时用的也是它），而切项目那一下 `activeProject` 会**先**变、
   * `activeSession` 要等会话列表 IPC 回来才变——那一瞬间若 cwd 取 `activeProject`，就成了
   * 「会话落进 A、worker 在 B 里跑」（草稿首次发送必然新 fork，没有已在跑的 worker 兜底，
   * 所以这一档尤其要按会话自己的项目走）。抽出会话自己的项目后，`activeProject` 只剩
   * 「左栏高亮 / 展开谁 / 新建会话建到哪」这几件事。
   *
   * 反查不到（理论不该发生：会话都来自某个在列项目的 list）时退回 `activeProject`，
   * 免得中间区整块空掉。
   */
  const conversationProject = useMemo(() => {
    if (!activeSession) return null;
    return projects.find((item) => item.id === activeSession.projectId) ?? activeProject;
  }, [projects, activeSession, activeProject]);
  const [now, setNow] = useState(() => Date.now());

  // 主题挂载到下 <html>，并在变更时持久化
  useEffect(() => {
    applyTheme(theme);
    saveTheme(theme);
  }, [theme]);

  // 有会话在运行时每秒重渲染，驱动侧栏心跳计时（窗口不可见时暂停，F11）
  useVisibleInterval(() => setNow(Date.now()), 1000, runningSessions.size > 0);

  useEffect(() => {
    void (async () => {
      // 分开取值而不是 Promise.all：三者互不依赖，任何一个失败（如 env.check 在
      // 探测 bash 时揽到异常）都不应该拖紧其余两项。
      // 旧写法下三者共用一次 try，任一 reject 就让 setProviders 永不执行——
      // 模型下拉因 options 为空而**点开无任何反应**，用户看到的就是「选不了模型」。
      const [envReport, projectList, providerList] = await Promise.all([
        window.colt.invoke("env.check", undefined).catch(() => null),
        window.colt.invoke("project.list", undefined).catch(() => [] as Project[]),
        window.colt.invoke("providers.list", undefined).catch(() => [] as ProviderConfig[]),
      ]);
      if (envReport) setEnv(envReport);
      setProjects(projectList);
      setProviders(providerList);
      setModelServiceReady(hasUsableProvider(providerList));
      if (projectList.length > 0) setActiveProject(projectList[0]!);

      // 首启引导：仅在尚未完成引导时弹出（已完成则直接进主界面）
      try {
        const report = await window.colt.invoke("firstRun.check", undefined);
        if (!report.onboardingDone) setFirstRun(report);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  // 离开设置页时重新拉取 provider 与密钥状态：既让模型下拉及时反映改动，
  // 也让「未配置密钥」的黄色提示在配好之后立刻消失（否则要重启才更新）
  useEffect(() => {
    if (mainView === "settings") return;
    void (async () => {
      const providerList = await window.colt.invoke("providers.list", undefined);
      setProviders(providerList);
      setModelServiceReady(hasUsableProvider(providerList));
    })();
  }, [mainView]);

  /**
   * 拉取某项目的会话列表并写入缓存。
   *
   * 这里**直接以库为准**（整份替换）：`session.list` 只读库，而**草稿**（首次发消息才落库）
   * 不在库中——这正是我们要的。草稿只当「当前会话」用，不进侧栏；转正后由 `session.status`
   * 监听重新拉一次，它才以真实会话的身份出现。
   *
   * 这也把「点了新建就退出」留下的空会话挡在门外：那类会话从不落库，列表里自然没有它。
   */
  const loadProjectSessions = useCallback(async (projectId: string) => {
    const list = await window.colt.invoke("session.list", { projectId });
    setSessionsByProject((map) => new Map(map).set(projectId, list));
    return list;
  }, []);

  /**
   * 手里那条**还没用起来**的草稿（id + 所属项目）。
   *
   * 用 ref 而不是 state：它只在事件与 effect 里读写，渲染看的是 `activeSession`，
   * 放 state 只会多出无谓的重渲染。
   */
  const draftRef = useRef<{ id: string; projectId: string } | null>(null);

  /**
   * 丢掉当前草稿——「还没用起来就离开」的落点。
   *
   * 走 `session.discardDraft` 而不是 `session.delete`：前者在主进程里**只在它仍是草稿时**
   * 生效。渲染层判断「有没有用起来」有一瞬间的不确定（首次发消息落库、与之相伴的进程状态
   * 推送之间），用 `delete` 一旦错判就是删掉用户刚发出去的会话。
   */
  const discardDraft = useCallback(() => {
    const pending = draftRef.current;
    if (!pending) return;
    draftRef.current = null;
    void window.colt.invoke("session.discardDraft", { sessionId: pending.id }).catch(() => {});
  }, []);

  // 当前会话不再是那条草稿了 → 丢掉它。切项目、点了别的会话、又新建了一条，都算「离开」；
  // 草稿没落库也没内容，丢掉不会有任何损失。
  useEffect(() => {
    if (draftRef.current && activeSession?.id !== draftRef.current.id) discardDraft();
  }, [activeSession, discardDraft]);

  // 全局监听会话视图：后台会话也能刷新标题、消息数与运行状态
  // （若只靠当前会话的回调，未选中的会话永远停在「新会话」）
  useEffect(() => {
    return window.colt.on("session.view", (view) => {
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

  // 全局监听会话进程状态：worker 停止/崩溃后侧栏要能看出来，否则界面看上去“会话还在”
  useEffect(() => {
    return window.colt.on("session.status", ({ sessionId, state }) => {
      // 草稿「转正」：草稿本身**不会**有进程（`session.open` 对它直接返回，不 fork worker），
      // 所以一旦它有了进程，就说明它刚落过库（首次 prompt / compact / skill 时先落库、再拉起）。
      // 此刻把它拉进侧栏——草稿在侧栏里本来是不显示的。
      // 判断权在主进程的落库时机上，不依赖模型是否回话，因此不会「发了消息却一直不在侧栏」。
      const pending = draftRef.current;
      if (pending?.id === sessionId) {
        draftRef.current = null;
        void loadProjectSessions(pending.projectId).then((list) => {
          const persisted = list.find((item) => item.id === sessionId);
          // 用落库后的那一份替换手里的草稿副本：jsonlPath 不再是空串，
          // 「它还是不是草稿」的判断从此与本项目列表一致
          if (persisted) {
            setActiveSession((current) => (current?.id === persisted.id ? persisted : current));
          }
        });
      }
      setOfflineSessions((map) => {
        const next = new Map(map);
        if (state === "dormant" || state === "crashed") {
          next.set(sessionId, state);
        } else {
          // idle（worker 就绪）或 running（Agent 跑起来）都意味着进程活着
          next.delete(sessionId);
        }
        return next;
      });
    });
  }, [loadProjectSessions]);

  // 全局监听两张等人回话的队列：侧栏据此标出「在等你」。
  // 主进程已在窗口不在前台时额外闪任务栏并发系统通知，这里只负责让状态在界面上可见。
  useEffect(() => {
    const track =
      (setter: Dispatch<SetStateAction<Set<string>>>) =>
      ({ sessionId, requests }: { sessionId: string; requests: unknown[] }): void => {
        setter((prev) => {
          const next = new Set(prev);
          if (requests.length > 0) next.add(sessionId);
          else next.delete(sessionId);
          return next;
        });
      };
    const offApproval = window.colt.on("approval.pending", track(setApprovalSessions));
    const offQuestion = window.colt.on("userquestion.pending", track(setQuestionSessions));
    return () => {
      offApproval();
      offQuestion();
    };
  }, []);

  // 图钉只活在主进程内存里（不进库），挂载时对齐回来——dev 下 reload 之后也走这条
  useEffect(() => {
    void (async () => {
      const list = await window.colt
        .invoke("session.listPinned", undefined)
        .catch(() => [] as string[]);
      setPinnedSessions(new Set(list));
    })();
  }, []);

  /**
   * 切换图钉。写主进程的是**绝对状态**（pinned: true/false）而非「翻转」，
   * 所以即便重放/重试，重复写同一个值也不会把状态翻回去。
   */
  const togglePin = useCallback(
    (sessionId: string) => {
      const pinned = !pinnedSessions.has(sessionId);
      setPinnedSessions((set) => {
        const next = new Set(set);
        if (pinned) next.add(sessionId);
        else next.delete(sessionId);
        return next;
      });
      void window.colt.invoke("session.setPinned", { sessionId, pinned }).catch(() => {});
    },
    [pinnedSessions],
  );
  /**
   * 把某个会话的字段就地写回本地缓存（会话列表 + 当前会话）。
   *
   * 「选择已落库」的接口（模型、思考等级）都可能发生在**没有 worker** 的会话上：
   * 那时 view 永远不会更新，不回写缓存的话，切走再回来（Conversation 以 sessionId 重挂载）
   * 就会退回旧值，用户再次看到「选了没生效」。
   */
  const updateSessionCache = useCallback(
    (sessionId: string, patch: (item: SessionInfo) => SessionInfo) => {
      setSessionsByProject((map) => {
        const next = new Map(map);
        for (const [projectId, list] of next) {
          if (!list.some((item) => item.id === sessionId)) continue;
          next.set(
            projectId,
            list.map((item) => (item.id === sessionId ? patch(item) : item)),
          );
          break;
        }
        return next;
      });
      setActiveSession((current) => (current?.id === sessionId ? patch(current) : current));
    },
    [],
  );

  /**
   * 会话模型选择已落库后同步本地缓存，让 `sessionModelRef` 立刻反映新值。
   *
   * 不做这一步，切走再回来（Conversation 以 sessionId 为 key 重挂载）会退回旧值；
   * 而这类会话常常**没有 worker**，`view.model` 也补不上，用户会再次看到「选了没生效」。
   */
  const applySessionModel = useCallback((sessionId: string, modelRef: string) => {
    updateSessionCache(sessionId, (item) => ({ ...item, modelRef }));
  }, [updateSessionCache]);

  /**
   * 思考等级同理：它同样可能「只落库、没有 worker」，不回写缓存就会在重挂载后退回旧值。
   */
  const applySessionThinkingLevel = useCallback(
    (sessionId: string, thinkingLevel: ThinkingLevel) => {
      updateSessionCache(sessionId, (item) => ({ ...item, thinkingLevel }));
    },
    [updateSessionCache],
  );

  // 切换项目时：展开该项目并拉取其会话
  useEffect(() => {
    if (!activeProject) return;
    const projectId = activeProject.id;
    setExpandedProjects((set) => new Set(set).add(projectId));
    let stale = false;
    void (async () => {
      const list = await loadProjectSessions(projectId);
      // 响应到达时可能已经切到别的项目（会话多、IPC 慢时后到）：不能把**上一个项目**
      // 的响应写进选中态，否则主区会用当前项目的 cwd 去开另一个项目的会话。
      if (stale) return;
      setActiveSession((current) => {
        if (!current) return list[0] ?? null;
        // 在库列表里 → 保留
        if (list.some((item) => item.id === current.id)) return current;
        // 草稿不在 session.list 里（尚未落库），但它确实属于本项目、也还在侧栏里 → 保留，
        // 否则切走再切回会被莫名换成别的会话。必须**同时**校验 projectId：当前会话若属于
        // 另一个项目（切项目后响应到达），就该换掉，不能因为它是草稿就留住。
        if (current.projectId === projectId && isDraftSession(current)) return current;
        return list[0] ?? null;
      });
    })();
    return () => {
      stale = true;
    };
  }, [activeProject, loadProjectSessions]);

  const pickProject = useCallback(async () => {
    try {
      const project = await window.colt.invoke("project.pick", undefined);
      if (!project) return;
      setProjects(await window.colt.invoke("project.list", undefined));
      setActiveProject(project);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  /**
   * 新建一个工作目录（`~/.colt/<年月日-时分秒>/workspace`）并切过去——起手区「什么都不选」时的一键出口。
   *
   * 与 `pickProject` 只差「目录从哪来」：一个走原生选目录框，一个由主进程直接造。
   * 切过去之后草稿会由自动草稿那条路重建（旧草稿随「离开就丢掉」退场），所以这里不必手动建会话。
   */
  const createWorkspace = useCallback(async () => {
    try {
      const project = await window.colt.invoke("project.createScratch", undefined);
      setProjects(await window.colt.invoke("project.list", undefined));
      setActiveProject(project);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  /**
   * 新建会话。`projectId` 必须由调用方显式传入：侧栏每个项目行都有自己的「+」，
   * 点的是哪个项目就建在哪个项目——不能依赖闭包里的 `activeProject`，
   * 否则「先 setActiveProject(B)、再同步调 newSession()」时，读到的还是**本次渲染**的 A，
   * 会话就被建到 A 项目里去了（stale closure）。
   */
  const newSession = useCallback(async (projectId?: string) => {
    const targetId = projectId ?? activeProject?.id;
    if (!targetId) return;
    try {
      const session = await window.colt.invoke("session.create", { projectId: targetId });
      // 新会话是**草稿**：只分配 id，不落库、不 fork worker、不建 JSONL。
      // 因此它**不进侧栏**（列表以库为准，见 loadProjectSessions）——「点了新建就退出」
      // 不该在侧栏留下一串空会话。这里只把它置为当前会话，好让中间区立刻出现输入框；
      // 首次发消息落库后由 session.status 监听把它拉进侧栏。
      discardDraft();
      draftRef.current = { id: session.id, projectId: targetId };
      setActiveSession(session);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [activeProject, discardDraft]);

  /**
   * 项目在跟前、却一个会话都没有时，直接给一条草稿：中间区立刻是「欢迎语 + 输入框」，
   * 用户不必先跑到侧栏去点「+」。
   *
   * 放在 `newSession` 之后：effect 的依赖数组在**渲染期**求值，引用还没初始化的 `const`
   * 会直接 TDZ 报错（切项目那个 effect 因此引用不到它）。
   */
  useEffect(() => {
    if (mainView !== "chat" || !activeProject) return;
    if (!shouldOfferDraft(activeProject.id, sessionsByProject.get(activeProject.id), activeSession))
      return;
    void newSession(activeProject.id);
  }, [mainView, activeProject, sessionsByProject, activeSession, newSession]);

  /** 删除会话：确认 → 调后端 → 刷新列表并适时清空选中 */
  const deleteSession = useCallback(
    async (session: SessionInfo) => {
      try {
        // 走主进程的原生确认框，不用 `window.confirm`：后者的 JS 对话框关掉后会让页面
        // 失去焦点（输入框点不出光标、敲不进字，需窗口失焦再聚焦才恢复）。
        const { confirmed } = await window.colt.invoke("dialog.confirm", {
          message: `确定删除会话「${session.title}」？`,
          detail: "此操作不可恢复。",
          confirmLabel: "删除",
        });
        if (!confirmed) return;
        await window.colt.invoke("session.delete", { sessionId: session.id });
        // 缓存与库同寿命：会话删了，渲染层那份「最后视图」也别留着
        dropCachedView(session.id);
        // 主进程那份图钉标记已随 session.delete 清掉（见 ipc 的 dropSessionPin），这里同步视觉状态
        setPinnedSessions((set) => {
          if (!set.has(session.id)) return set;
          const next = new Set(set);
          next.delete(session.id);
          return next;
        });
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

  /**
   * 移除工作区：断开登记并清掉它名下的全部会话；**磁盘上的代码一行不动**。
   *
   * 与 `deleteSession` 同一套纪律：先走主进程的原生确认框（不用 `window.confirm`，
   * 理由见协议注释），再调后端，最后把渲染层里「与库同寿命」的状态全部收干净——
   * 缓存视图、图钉、会话列表、展开态，以及删的正好是当前项目时的选中态。
   */
  const deleteProject = useCallback(
    async (project: Project) => {
      try {
        const { confirmed } = await window.colt.invoke("dialog.confirm", {
          message: `确定移除工作区「${project.name}」？`,
          detail:
            "该项目下的会话记录会被一并清除，且不可恢复。磁盘上的文件不受影响，之后重新打开该目录即可恢复登记。",
          confirmLabel: "移除",
        });
        if (!confirmed) return;
        // 先取一份 id 清单：删完再问就问不到了（`session.list` 读的是库）。它同时也覆盖
        // 「该项目没展开、渲染层手里根本没有它的会话列表」这一档——不能拿缓存当依据。
        const doomed = await window.colt.invoke("session.list", { projectId: project.id });
        await window.colt.invoke("project.delete", { projectId: project.id });

        const removedIds = new Set(doomed.map((session) => session.id));
        // 缓存与库同寿命：会话没了，渲染层那份「最后视图」也别留着
        for (const id of removedIds) dropCachedView(id);
        // 主进程那份图钉已随 project.delete 清掉（见 ipc），这里同步视觉状态
        setPinnedSessions((set) => {
          let changed = false;
          const next = new Set(set);
          for (const id of removedIds) if (next.delete(id)) changed = true;
          return changed ? next : set;
        });
        // 草稿没落库、也不在 sessionsByProject 里：它属于被删项目时同样要丢掉
        if (draftRef.current?.projectId === project.id) discardDraft();

        setSessionsByProject((map) => {
          if (!map.has(project.id)) return map;
          const next = new Map(map);
          next.delete(project.id);
          return next;
        });
        setExpandedProjects((set) => {
          if (!set.has(project.id)) return set;
          const next = new Set(set);
          next.delete(project.id);
          return next;
        });

        const list = await window.colt.invoke("project.list", undefined);
        setProjects(list);
        // 删的正好是当前项目：切到列表里的下一条（没有就留空，中间区回到「还没有项目」）
        setActiveProject((current) => (current?.id === project.id ? (list[0] ?? null) : current));
        setActiveSession((current) =>
          current && current.projectId === project.id ? null : current,
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [discardDraft],
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
              const [projectList, providerList] = await Promise.all([
                window.colt.invoke("project.list", undefined),
                window.colt.invoke("providers.list", undefined),
              ]);
              setProjects(projectList);
              setActiveProject(projectList[0] ?? null);
              setProviders(providerList);
              setModelServiceReady(hasUsableProvider(providerList));
              if (choice === "fresh") setActiveSession(null);
            })();
          }}
        />
      )}
      <header className="flex h-[var(--h-topbar)] shrink-0 items-center justify-between border-b border-line bg-surface-raised px-3.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold tracking-[.2px] text-text-primary">
            Colt
          </span>
        </div>
        <div className="flex items-center gap-2">
          {/* env 尚未探测完成（null）时不能渲染红条：那只是「还不知道」，不是「确认没有」——
              否则每次启动都会先闪一帧「未找到 bash」再消失（探测要做多轮文件系统访问）。 */}
          {env !== null && !env.bashPath ? (
            <span className="text-xs text-danger">未找到 bash，命令工具不可用</span>
          ) : null}
          <div className="flex items-center gap-0.5 rounded-sm border border-line p-0.5">
            {THEME_OPTIONS.map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => setTheme(item.value)}
                title={item.label}
                aria-label={`主题：${item.label}`}
                aria-pressed={theme === item.value}
                className={cn(
                  "flex h-6 w-6 items-center justify-center rounded-xs transition",
                  theme === item.value
                    ? "bg-surface-overlay text-text-primary"
                    : "text-text-muted hover:bg-surface-overlay/60 hover:text-text-secondary",
                )}
              >
                <item.Icon {...ICON.xs} />
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setMainView((value) => (value === "changes" ? "chat" : "changes"))}
            title={activeProject ? "项目改动汇总" : "打开项目后可查看改动"}
            disabled={!activeProject}
            className={cn(
              "flex items-center gap-1.5 rounded-sm border px-2 py-1 text-xs transition disabled:cursor-not-allowed disabled:opacity-40",
              mainView === "changes"
                ? "border-accent bg-accent-soft text-text-primary"
                : "border-line text-text-secondary hover:border-line-strong hover:text-text-primary",
            )}
          >
            <FileDiff {...ICON.sm} />
            改动
          </button>
          <button
            type="button"
            onClick={() => setMainView((value) => (value === "settings" ? "chat" : "settings"))}
            title="设置"
            className={cn(
              "flex items-center gap-1.5 rounded-sm border px-2 py-1 text-xs transition",
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
                      busy={list.some((session) => runningSessions.has(session.id))}
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
                        // 无论当前在哪个视图（设置 / 改动），新建会话都要回到对话视图：
                        // 否则主区停在原页面、会话在后台静默创建——看起来就是「点了没反应」。
                        setMainView("chat");
                        void newSession(project.id);
                      }}
                      onDelete={() => void deleteProject(project)}
                    />
                    {expanded && (
                      <div className="mt-0.5 pl-3">
                        <div className="truncate px-2 py-0.5 font-mono text-2xs text-text-muted">
                          {project.rootPath}
                        </div>
                        {list.length === 0 ? (
                          <div className="px-2 py-1.5 text-xs text-text-muted">还没有会话</div>
                        ) : (
                          list.map((session) => (
                            <SessionRow
                              key={session.id}
                              session={session}
                              active={session.id === activeSession?.id}
                              startedAt={runningSessions.get(session.id)}
                              offlineState={offlineSessions.get(session.id)}
                              waiting={
                                approvalSessions.has(session.id)
                                  ? "approval"
                                  : questionSessions.has(session.id)
                                    ? "question"
                                    : undefined
                              }
                              pinned={pinnedSessions.has(session.id)}
                              now={now}
                              onClick={() => {
                                if (project.id !== activeProject?.id) setActiveProject(project);
                                // 同 onNewSession：在设置页点会话行也必须回到对话视图
                                setMainView("chat");
                                setActiveSession(session);
                              }}
                              onTogglePin={() => togglePin(session.id)}
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
        </aside>

        <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {error && (
            <div className="m-3.5 shrink-0 rounded-md border border-line bg-danger-soft px-3.5 py-3 text-sm text-danger-fg">
              {error}
            </div>
          )}

          {modelServiceReady === false && (
            <div className="m-3.5 shrink-0 rounded-md border border-line bg-warning-soft px-3.5 py-3 text-sm text-warning">
              尚未配置任何模型服务的 API Key，无法开始对话。请在设置中填写密钥（内置
              DeepSeek 或自建的 OpenAI 兼容服务均可）。
            </div>
          )}

          {/*
            视图区必须是「主区剩余高度」的**独立一格**（min-h-0 flex-1），不能像以前那样
            直接与提示条并列：视图根节点是 h-full，而 h-full 量的是**整个 main** 的高度，
            于是只要上面挂了提示条（无可用模型时的黄条、拉取失败时的红条），视图就会
            多出「提示条高」那么一截、从**底部**溢出，被 main 的 overflow-hidden 裁掉——
            输入卡片的下半行（访问模式 / /compact / 模型选择 / 发送）正好落在那一截里，
            表现为「没有可用模型时输入框下半部分看不见」。
            min-h-0 不可省：否则内容的最小高度会顶破 flex-1，视图又会被撑回去。
          */}
          <div className="min-h-0 flex-1">
            {mainView === "settings" ? (
              <Settings project={activeProject} />
            ) : mainView === "changes" && activeProject ? (
              <ProjectChanges key={activeProject.id} projectId={activeProject.id} />
            ) : activeSession && conversationProject ? (
              <Conversation
                key={activeSession.id}
                sessionId={activeSession.id}
                cwd={conversationProject.rootPath}
                sessionModelRef={activeSession.modelRef}
                sessionThinkingLevel={activeSession.thinkingLevel}
                runStartedAt={runningSessions.get(activeSession.id)}
                providers={providers}
                onModelSelected={(modelRef) => applySessionModel(activeSession.id, modelRef)}
                onThinkingLevelSelected={(level) =>
                  applySessionThinkingLevel(activeSession.id, level)
                }
                onPickDirectory={() => void pickProject()}
                onNewWorkspace={() => void createWorkspace()}
              />
            ) : (
              <div className="flex h-full items-center justify-center">
                {/* 走到这里只有两种情形：还没选中项目（让用户先去打开一个），
                    或项目在跟前但会话列表还在路上——后者马上会由自动草稿补上输入框，
                    所以不再说「新建一个会话开始对话」（那会把用户支使去点侧栏的「+」）。 */}
                <p className="text-sm text-text-muted">
                  {activeProject ? "正在准备会话…" : "打开一个项目目录开始"}
                </p>
              </div>
            )}
          </div>
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
          <span className="truncate text-xs font-semibold uppercase tracking-[.5px] text-text-muted">
            {title}
          </span>
        </button>
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            className="flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-1 text-xs text-text-secondary opacity-0 transition group-hover:opacity-100 hover:bg-surface-overlay hover:text-text-primary focus:opacity-100"
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

/** 已运行时长：mm:ss */
function formatElapsed(startedAt: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - startedAt) / 1000));
  return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
}

/** 项目行：折叠三角 + 项目名 + 新建会话 + 移除工作区 */
function ProjectRow({
  project,
  active,
  expanded,
  busy,
  onToggle,
  onActivate,
  onNewSession,
  onDelete,
}: {
  project: Project;
  active: boolean;
  expanded: boolean;
  /** 该项目下有会话正在运行（含等人回话）——此时不允许移除，与 session.delete 一致 */
  busy: boolean;
  onToggle: () => void;
  onActivate: () => void;
  onNewSession: () => void;
  onDelete: () => void;
}): React.JSX.Element {
  return (
    <div
      data-project-row={project.id}
      className={cn(
        "group flex items-center gap-1 rounded-sm py-1.5 pl-1.5 pr-1.5 transition",
        active ? "bg-surface-overlay" : "hover:bg-surface-overlay/60",
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
        <div className="truncate text-sm text-text-primary">{project.name}</div>
      </button>
      <button
        type="button"
        onClick={onNewSession}
        title="新建会话"
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-xs text-text-muted opacity-0 transition group-hover:opacity-100 hover:bg-line-soft hover:text-text-primary focus:opacity-100"
      >
        <Plus {...ICON.xs} />
      </button>
      <button
        type="button"
        onClick={onDelete}
        disabled={busy}
        data-project-remove
        title={busy ? "有会话正在运行，不可移除工作区" : "移除工作区（不影响磁盘上的文件）"}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-xs text-text-muted opacity-0 transition group-hover:opacity-100 hover:bg-line-soft hover:text-danger-fg focus:opacity-100 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-text-muted"
      >
        <Trash2 {...ICON.xs} />
      </button>
    </div>
  );
}

/** 会话行：状态点 + 标题 / 副标题（运行中带计时），悬停显示复制/删除 */
function SessionRow({
  session,
  active,
  startedAt,
  offlineState,
  waiting,
  pinned,
  now,
  onClick,
  onTogglePin,
  onDelete,
}: {
  session: SessionInfo;
  active: boolean;
  startedAt?: number;
  /**
   * worker 已离开内存的原因：空闲休眠（stopped）/ 崩溃（crashed）。
   * 与 startedAt 正交：停止的会话一定不在运行中。
   */
  offlineState?: "dormant" | "crashed";
  /**
   * 有待用户处置的请求，及是哪一类：**授权**（等人给许可）还是**提问**（等人给信息）。
   * 协议层刻意把两者分成两条通道（approval.pending / userquestion.pending），
   * 这里也必须分开说——模型提问不是申请授权，混用会稀释用户对真正授权卡的警觉。
   * undefined = 没有待处置。同一会话两类同时挂起时取「授权」（更该被看见）。
   */
  waiting: "approval" | "question" | undefined;
  /** 被钉住的会话不被自动回收。与 offlineState 正交：钉住只是「别收」，不代表进程还活着 */
  pinned: boolean;
  now: number;
  onClick: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
}): React.JSX.Element {
  const running = startedAt !== undefined;
  const [copied, setCopied] = useState(false);

  // 同 Markdown.tsx：复位定时器挂到 effect 上，卸载即清，不对已卸载组件 setState
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const copyId = (): void => {
    void navigator.clipboard.writeText(session.id).then(() => setCopied(true));
  };

  return (
    <div
      data-session-row={session.id}
      className={cn(
        "group/session flex w-full items-center gap-2 rounded-sm px-1.5 py-1.5 transition",
        active ? "bg-surface-overlay" : "hover:bg-surface-overlay/60",
      )}
    >
      <button type="button" onClick={onClick} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <span
          className={cn(
            "h-[7px] w-[7px] shrink-0 rounded-full border-[1.5px]",
            waiting
              ? "pulse-dot border-warning bg-warning"
              : running
                ? "pulse-dot border-success bg-success"
                : offlineState === "crashed"
                  ? "border-danger bg-danger"
                  : offlineState === "dormant"
                    ? "border-warning"
                    : active
                      ? "border-accent bg-accent"
                      : "border-text-muted",
          )}
        />
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block truncate text-sm leading-tight",
              active ? "text-text-primary" : "text-text-secondary",
            )}
          >
            {session.title}
          </span>
          <span
            className={cn(
              "block truncate text-2xs leading-tight tabular-nums",
              waiting
                ? "text-warning"
                : offlineState === "crashed"
                  ? "text-danger-fg"
                  : "text-text-muted",
            )}
          >
            {waiting
              ? waiting === "approval"
                ? "等待你的授权"
                : "等待你的回答"
              : running
                ? `运行中 · ${formatElapsed(startedAt, now)}`
                : offlineState === "crashed"
                  ? "异常中断 · 发送即恢复"
                  : offlineState === "dormant"
                    ? "空闲休眠 · 发送即恢复"
                    : formatSessionStamp(session.updatedAt)}
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={onTogglePin}
        title={pinned ? "已钉住 · 不会被自动回收" : "钉住：不让它被自动回收"}
        aria-label={pinned ? "取消钉住" : "钉住会话"}
        aria-pressed={pinned}
        className={cn(
          "flex h-5 w-5 shrink-0 items-center justify-center rounded-xs transition hover:bg-line-soft focus:opacity-100",
          pinned
            ? "text-accent opacity-100"
            : "text-text-muted opacity-0 group-hover/session:opacity-100 hover:text-text-primary",
        )}
      >
        <Pin {...ICON.xs} className={pinned ? "fill-current" : undefined} />
      </button>
      <button
        type="button"
        onClick={copyId}
        title={copied ? "已复制" : "复制会话 ID"}
        className={cn(
          "flex h-5 w-5 shrink-0 items-center justify-center rounded-xs text-text-muted transition hover:bg-line-soft hover:text-text-primary focus:opacity-100",
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
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-xs text-text-muted opacity-0 transition group-hover/session:opacity-100 hover:bg-line-soft hover:text-danger-fg focus:opacity-100 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-text-muted"
      >
        <Trash2 {...ICON.xs} />
      </button>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p className="px-3 py-6 text-center text-xs leading-relaxed text-text-muted">
      {children}
    </p>
  );
}
