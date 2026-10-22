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
  Archive,
  ArchiveRestore,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileDiff,
  FolderOpen,
  Monitor,
  Moon,
  Pin,
  Plus,
  Search,
  Settings as SettingsIcon,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import { formatSessionStamp } from "@/lib/format";
import { ICON } from "@/lib/icon";
import { applyTheme, loadTheme, saveTheme, type Theme } from "@/lib/theme";
import { useVisibleInterval } from "@/lib/use-visible-interval";
import { hasUsableProvider } from "@shared/model-ref";
import type { EnvReport, FirstRunReport, Project, ProviderConfig, SessionInfo } from "@shared/protocol";
import { deriveSessionTitle, keepContinuationSuffix } from "@shared/session-title";
import type { ThinkingLevel } from "@shared/thinking-level";
import { Conversation } from "./features/Conversation";
import { DefaultSpaceArtifacts } from "./features/Artifacts";
import { ErrorNotice } from "./components/ErrorNotice";
import { dropCachedView } from "./features/Conversation/view-cache";
import { FirstRunGate } from "./features/FirstRunGate";
import { ProjectChanges } from "./features/ProjectChanges";
import { Settings } from "./features/Settings";
import { shouldKeepSessionOnLoad, shouldOfferDraft, splitArchived } from "./lib/session";
import { cn } from "./lib/utils";

/** 主区视图 */
type MainView = "chat" | "changes" | "settings" | "artifacts";

/** 主题三态按钮（亮 / 暗 / 跟随系统） */
const THEME_OPTIONS = [
  { value: "light" as const, label: "亮色", Icon: Sun },
  { value: "dark" as const, label: "暗色", Icon: Moon },
  { value: "system" as const, label: "跟随系统", Icon: Monitor },
];

/** M1 主界面：空间 / 任务 → 会话 → 对话 */
export default function App(): React.JSX.Element {
  const [env, setEnv] = useState<EnvReport | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessionsByProject, setSessionsByProject] = useState<Map<string, SessionInfo[]>>(new Map());
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  /**
   * 侧栏底部「已归档」区是否展开。默认收起——归档的目的就是让侧栏变短，展开只是临时查看，
   * 故不持久化。
   */
  const [archivedOpen, setArchivedOpen] = useState(false);
  /** 侧栏底部「已移除」区是否展开（FR-07：默认收起，标题带数量；不持久化） */
  const [removedOpen, setRemovedOpen] = useState(false);
  /**
   * 「在新位置继续」的目标选择框（FR-03）：`null` = 关着；有值 = 正在为这条会话选目标。
   * `continuingTo` 是选中的目标项目 id（确认按钮据此置灰：与当前位置相同时不可确认）。
   */
  const [continueFor, setContinueFor] = useState<SessionInfo | null>(null);
  const [continuingTo, setContinuingTo] = useState<string | null>(null);
  const [continuing, setContinuing] = useState(false);
  /**
   * 当前不可用的工作目录 id（FR-04）：启动、回到窗口时各查一次，异步带超时。
   * 它决定左栏的「位置不可用」标记与「不把新会话建进去」；**发送前**的拦截在主进程
   * （那是唯一可靠的关口，界面上的状态只是提前告知）。
   */
  const [unavailableProjects, setUnavailableProjects] = useState<Set<string>>(() => new Set());
  /** 产物目录当前不可用的默认空间会话 id（目录被外部删除等，FR-02 异常路径） */
  const [unavailableSessions, setUnavailableSessions] = useState<Set<string>>(() => new Set());
  /**
   * 全量**已归档**会话，**跨项目**（侧栏底部那一个区里混着各项目的归档会话，每行标出所属项目）。
   *
   * 为什么不从 `sessionsByProject` 拼：那份缓存是**按项目懒加载**的，没展开过的项目根本不在
   * 里面，跨项目汇总会漏。故单独按需拉一次全量（`session.list` 不传 projectId）再筛归档。
   * 刷新跟着「会话集合变了」的那些动作走——归档 / 恢复 / 删除会话 / 删除项目 / 已归档会话
   * 跑起来被自动取消归档（见各处 `refreshArchived`）。
   */
  const [archivedSessions, setArchivedSessions] = useState<SessionInfo[]>([]);
  /**
   * 侧栏搜索词（匹配会话**标题** / 项目**名与路径**）。非空时侧栏切成**过滤视图**：
   * 只显示命中的行、命中的会话自动展开其项目；清空即恢复原样——`expandedProjects`
   * **一个字都不动**，用户原来的展开态会原样回来。
   */
  const [sidebarQuery, setSidebarQuery] = useState("");
  /**
   * 搜索用的**全量会话**（跨项目）。侧栏平时是按项目**懒加载**的（只会拉到展开过的项目），
   * 而搜索必须能跨项目命中，所以查询一变就重拉一次 `session.list`（不传 projectId = 全部）。
   * 每次都重拉是为了**永远新鲜**：新建 / 删除 / 改标题之后不必再维护一套「何时该失效」的逻辑。
   * 多一次本地 SQLite 查询换「不会拿陈旧列表去答有没有匹配」，这个交换是划算的。
   */
  const [searchSessions, setSearchSessions] = useState<SessionInfo[] | null>(null);
  /**
   * 搜索态下**被手动收起**的项目。搜索时行是一律展开的，所以收起不能写进 `expandedProjects`
   * （那会污染用户平时的展开态）——另记一份，且**换搜索词就复位**。
   * 留着它的理由：不给这份状态，搜索态里那个收起箭头就成了「点了没反应」的死控件。
   */
  const [searchCollapsed, setSearchCollapsed] = useState<Set<string>>(new Set());
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
  /**
   * 任务工作区：**默认空间**容器背后的那条项目行（启动时 `project.ensureTask` 保证存在）。
   * 不指定工作位置新建的会话都归到它名下；每条会话落库时在自己的产物目录里干活。
   */
  const taskProject = useMemo(
    () => projects.find((item) => item.kind === "task") ?? null,
    [projects],
  );
  /** 「工作目录」区要画的项目：除去默认空间（它有自己的分区）与已移除（收进底部「已移除」区） */
  const spaceProjects = useMemo(
    () => projects.filter((item) => item.kind !== "task" && item.removedAt === null),
    [projects],
  );
  /** 已移除的工作目录（FR-07）：收进底部「已移除」区，登记与会话都还在 */
  const removedProjects = useMemo(
    () => projects.filter((item) => item.kind !== "task" && item.removedAt !== null),
    [projects],
  );
  /**
   * 顶部「新建会话」的落点（FR-01 跟随当前上下文）：当前会话属于某个工作目录 → 该目录；
   * 当前在默认空间、没有会话、或所属目录已被移除 → 默认空间。用户想精确指定时走
   * 目录行的「+」或默认空间分区头的「新建」，不依赖这里的推断。
   */
  const newSessionTarget = useMemo(() => {
    const current = conversationProject;
    if (
      current &&
      current.kind !== "task" &&
      current.removedAt === null &&
      !unavailableProjects.has(current.id)
    ) {
      return current;
    }
    // 当前目录不可用时不把新会话建进去（FR-01）：退回默认空间，用户想精确指定时走目录行「+」
    return taskProject;
  }, [conversationProject, taskProject, unavailableProjects]);
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
      // 分开取值而不是串行：四者互不依赖，任何一个失败（如 env.check 在
      // 探测 bash 时揽到异常）都不应该拖紧其余三项。
      // 旧写法下共用一次 try，任一 reject 就让 setProviders 永不执行——
      // 模型下拉因 options 为空而**点开无任何反应**，用户看到的就是「选不了模型」。
      const [envReport, projectList, providerList, taskWorkspace] = await Promise.all([
        window.colt.invoke("env.check", undefined).catch(() => null),
        window.colt.invoke("project.list", undefined).catch(() => [] as Project[]),
        window.colt.invoke("providers.list", undefined).catch(() => [] as ProviderConfig[]),
        // 任务工作区：不指定空间（目录）新建的会话都归到它名下（「任务」栏）。幂等，
        // 已登记就直接返回；可能本来就在 projectList 里（上次运行创建过），合并时按 id 去重。
        window.colt.invoke("project.ensureTask", undefined).catch(() => null),
      ]);
      if (envReport) setEnv(envReport);
      const merged =
        taskWorkspace && !projectList.some((item) => item.id === taskWorkspace.id)
          ? [...projectList, taskWorkspace]
          : projectList;
      setProjects(merged);
      setProviders(providerList);
      setModelServiceReady(hasUsableProvider(providerList));
      // 启动默认选中第一个**空间**——任务工作区不算（它不在「空间」栏里，也不该在
      // 启动时被当成当前空间；任务草稿由下方「无空间时的兜底」按需创建）。
      setActiveProject(merged.find((item) => item.kind !== "task") ?? null);

      // 首启引导：仅在尚未完成引导时弹出（已完成则直接进主界面）
      try {
        const report = await window.colt.invoke("firstRun.check", undefined);
        if (!report.onboardingDone) setFirstRun(report);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  /**
   * 位置可用性（FR-04）：启动、目录集合变化、窗口获焦、**恢复目录**、重建产物目录之后各查一次。
   *
   * 异步 + 主进程侧超时，界面从不等待它；查到的「不可用」只用来提前告知（左栏标记、
   * 不把新会话建进去），真正的关卡是发送前那一次主进程检查。
   */
  const refreshAvailability = useCallback(async () => {
    try {
      const report = await window.colt.invoke("project.availability", undefined);
      setUnavailableProjects(new Set(report.unavailable));
      setUnavailableSessions(new Set(report.unavailableSessions));
    } catch {
      // 查不到 ≠ 可用：保留上一次结论；发送前主进程仍会按根做最后一道拒绝
    }
  }, []);

  useEffect(() => {
    void refreshAvailability();
    const check = (): void => void refreshAvailability();
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [projects.length, refreshAvailability]);

  // 侧栏搜索：查询非空才拉全量会话（空串不拉——不进搜索就不付这份代价）。
  // `stale` 守卫防「连打几个字、先发的响应后到」把结果写反。
  useEffect(() => {
    // 换了搜索词就把「搜索内收起」复位：上一次的收起不该带到下一次的结果里。
    setSearchCollapsed(new Set());
    if (sidebarQuery.trim() === "") return;
    let stale = false;
    void (async () => {
      const list = await window.colt.invoke("session.list", {});
      if (!stale) setSearchSessions(list);
    })();
    return () => {
      stale = true;
    };
  }, [sidebarQuery]);

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
    const all = await window.colt.invoke("session.list", { projectId });
    // 归档的**不进这份缓存**：它们统一去侧栏底部的「已归档」区（跨项目汇总，见 archivedSessions）。
    // 于是这份按项目的列表只装常规会话——`shouldOfferDraft` 拿它判「项目里还有没有会话可显示」
    // 天然正确（只剩归档会话的项目照样会拿到一条草稿）。
    const list = splitArchived(all).active;
    setSessionsByProject((map) => new Map(map).set(projectId, list));
    return list;
  }, []);

  /**
   * 重拉全量已归档会话（跨项目）。必须问全库，不能从按项目的缓存拼（懒加载会漏）。
   *
   * 与侧栏搜索同一条思路：**每次会话集合一变就重拉**，用「永远新鲜」换掉一整套「何时该失效」
   * 的逻辑。调用点都是「会让某条会话在常规 / 归档之间搬家或消失」的动作。
   */
  const refreshArchived = useCallback(async () => {
    const all = await window.colt.invoke("session.list", {});
    setArchivedSessions(splitArchived(all).archived);
  }, []);

  // 挂载时先拉一次：底部「已归档」区的条数在收起状态下也要如实
  useEffect(() => {
    void refreshArchived();
  }, [refreshArchived]);

  // 任务栏的会话**不能**按「展开才拉」：它没有项目行、也没有展开态，启动即拉一次，
  // 任务栏才能从一开始就如实显示列表（任务工作区存在时才拉；ensureTask 失败则为 null）。
  useEffect(() => {
    if (!taskProject) return;
    void loadProjectSessions(taskProject.id);
  }, [taskProject, loadProjectSessions]);

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

  /**
   * ④「从这里分叉」成功：主进程已经建好新会话（源库快照 + 新对话），这里只负责
   * 「进侧栏 + 切过去」。新会话的 `key` 变了，`Conversation` 会重挂载并自己 `session.open`。
   *
   * 同 id 时保留侧栏里已有的标题/消息数（冒烟会用它替换 `sessionManager.fork` 来记账，
   * 那时返回的是当前会话本身；真分叉永远是新 id）。
   */
  const handleSessionForked = useCallback((session: SessionInfo) => {
    setSessionsByProject((map) => {
      const next = new Map(map);
      const list = next.get(session.projectId) ?? [];
      const existing = list.find((item) => item.id === session.id);
      next.set(session.projectId, [
        existing ? { ...session, ...existing } : session,
        ...list.filter((item) => item.id !== session.id),
      ]);
      return next;
    });
    setActiveSession(session);
  }, []);

  // 全局监听会话视图：后台会话也能刷新标题、消息数与运行状态
  // （若只靠当前会话的回调，未选中的会话永远停在「新会话」）
  useEffect(() => {
    return window.colt.on("session.view", (view) => {
      // 标题派生与主进程落库用的是**同一个函数**（`@shared/session-title`）：
      // 两处各写一遍同一条 `slice(0, 30)` 就迟早会漂开，而那是静默的不一致。
      const derivedTitle = deriveSessionTitle(view.messages);
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
                    // 「（续）」后缀在这里同样要保住：主进程与渲染层各算一遍标题，
                    // 两边的规则必须一致（见 `keepContinuationSuffix`）
                    title: keepContinuationSuffix(derivedTitle, item.title) ?? item.title,
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
      // 进程没了就不能再算「运行中」：主进程在异常退出时只发 session.status，
      // **不会**补一帧 running=false 的视图（见 session-manager 的 exit 分支），
      // 只靠 session.view 清这份映射的话，崩溃的会话会一直挂着绿点与计时，
      // 把「异常中断」整个遮掉，还会让 App 每秒空转重渲染。
      if (state === "dormant" || state === "crashed") {
        setRunningSessions((map) => {
          if (!map.has(sessionId)) return map;
          const next = new Map(map);
          next.delete(sessionId);
          return next;
        });
      }
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
   * 归档 / 取消归档一条会话。
   *
   * 不走确认框：归档**可逆、不删任何数据**（与 `deleteSession` 的分界正在这里）。成功后
   * 两份缓存都重拉——会话在「项目常规列表」与「底部已归档区」之间搬家，只改一处会不一致。
   * 归档会顺带解掉主进程里的图钉（见 ipc），这里把视觉状态同步收掉。
   */
  const setSessionArchived = useCallback(
    async (session: SessionInfo, archived: boolean) => {
      try {
        await window.colt.invoke("session.setArchived", { sessionId: session.id, archived });
        if (archived) {
          setPinnedSessions((set) => {
            if (!set.has(session.id)) return set;
            const next = new Set(set);
            next.delete(session.id);
            return next;
          });
        }
        await Promise.all([loadProjectSessions(session.projectId), refreshArchived()]);
        // 当前会话若正是它，直接同步 `status`：项目列表是 active-only、未必含这条归档会话，
        // 不能靠它回填；而这个标记必须准——下面那条「跑起来就取消归档」的 effect 依赖它。
        setActiveSession((current) =>
          current?.id === session.id
            ? { ...current, status: archived ? "archived" : "active" }
            : current,
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [loadProjectSessions, refreshArchived],
  );

  /** 正在「因跑起来而取消归档」的会话，防同一会话在 IPC 往返期间被重复触发 */
  const unarchivingRef = useRef<Set<string>>(new Set());

  /**
   * 已归档的会话一旦跑起来，立刻取消归档。
   *
   * 已归档会话只可能被「打开后发消息」跑起来（主进程 `session.prompt` 也会取消归档，那是
   * 数据层兜底）。界面这边若不同步，它会在**默认收起**的归档区里以「运行中」的身份待着，
   * 等于一条看不见的运行中会话。判据用已在跟踪的 `runningSessions`，不新增订阅。
   */
  useEffect(() => {
    const session = activeSession;
    if (!session || session.status !== "archived" || !runningSessions.has(session.id)) return;
    if (unarchivingRef.current.has(session.id)) return;
    unarchivingRef.current.add(session.id);
    void (async () => {
      try {
        await window.colt.invoke("session.setArchived", { sessionId: session.id, archived: false });
        await Promise.all([loadProjectSessions(session.projectId), refreshArchived()]);
        setActiveSession((current) =>
          current?.id === session.id ? { ...current, status: "active" } : current,
        );
      } catch {
        // 静默：主进程在 prompt 时已兜底取消归档，下次刷新列表自然对齐，不必打扰用户
      } finally {
        unarchivingRef.current.delete(session.id);
      }
    })();
  }, [activeSession, runningSessions, loadProjectSessions, refreshArchived]);

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
      setActiveSession((current) =>
        // 在列表里、是本项目草稿、或是用户从「已归档」区点开的归档会话 → 保留；
        // 判据与理由见 `shouldKeepSessionOnLoad`（那几条都有单测）。
        shouldKeepSessionOnLoad(current, list, projectId) ? current : (list[0] ?? null),
      );
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
    // 当前已有会话（哪怕是别处的任务草稿）就不动：这条 effect 的职责只是「中间区空着时
    // 给一条草稿」，不是「把当前会话换成项目的」。v1.93 前判「当前会话是否属于本项目」，
    // 代价是顶掉用户刚建的任务草稿（顶部「新建会话」→ 任务草稿 → 立刻被换成空间草稿，
    // 冒烟 model 实测抓到）；跨空间切换时旧会话由「切项目」那条 effect 负责换成 list[0]。
    if (activeSession) return;
    // 这份缓存只含常规会话（已归档的已由 loadProjectSessions 滤掉），所以「归档了不算还有会话」
    // 天然成立：只剩归档会话的项目照样会拿到一条草稿（`undefined` = 还没拉到，照旧要等）
    if (!shouldOfferDraft(activeProject.id, sessionsByProject.get(activeProject.id), activeSession))
      return;
    void newSession(activeProject.id);
  }, [mainView, activeProject, sessionsByProject, activeSession, newSession]);

  /**
   * 没有任何空间可选（一个空间都没有 / 刚移除了最后一个）时，给一条**任务**草稿：
   * 中间区立刻是输入框，会话归「任务」栏——「不指定空间（目录）时，新建会话归任务栏」
   * 在启动态的落点。有 activeProject 时走上面那个 effect，草稿建到那个空间里。
   */
  useEffect(() => {
    if (mainView !== "chat" || activeProject || !taskProject) return;
    if (activeSession) return;
    void newSession(taskProject.id);
  }, [mainView, activeProject, taskProject, activeSession, newSession]);

  /** 删除会话：确认 → 调后端 → 刷新列表并适时清空选中 */
  const deleteSession = useCallback(
    async (session: SessionInfo) => {
      try {
        // 走主进程的原生确认框，不用 `window.confirm`：后者的 JS 对话框关掉后会让页面
        // 失去焦点（输入框点不出光标、敲不进字，需窗口失焦再聚焦才恢复）。
        // 文案**按位置区分**（FR-07）：默认空间的目录留着 manifest 可再找回；工作目录的
        // 文件本来就在共享目录里，产品不再提供「这条会话碰过哪些文件」的线索——不对称如实说。
        const project = projects.find((item) => item.id === session.projectId);
        const isDefaultSpace = project?.kind === "task";
        const { confirmed } = await window.colt.invoke("dialog.confirm", {
          message: `确定删除会话「${session.title}」？`,
          detail: isDefaultSpace
            ? "只删除对话与记录，不删除磁盘上的文件。默认空间的产物目录会保留，manifest 里仍有标题与文件列表，可在「产物」清单里再找回。"
            : `只删除对话与记录，不删除磁盘上的文件——它们仍在「${project?.name ?? "该工作目录"}」里；删除后产品不再提供这条会话碰过哪些文件的线索。`,
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
        // 删掉的也可能是一条**已归档**会话（在底部那个区里删的）：那份跨项目列表也要刷新
        void refreshArchived();
        setActiveSession((current) => {
          if (current?.id !== session.id) return current;
          return list[0] ?? null;
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [loadProjectSessions, refreshArchived, projects],
  );

  /**
   * 从列表移除工作目录（FR-07）：**只收进「已移除」区**——登记、会话记录与磁盘
   * 全都不动，随时可恢复。P0 不提供「同时删除这里的会话记录」：删除会话是单条
   * 会话的动作，避免一次误操作销毁一批对话。
   *
   * 运行中的会话由主进程拒绝（它知道哪条在跑），错误照常落到顶部的错误条。
   */
  const removeProject = useCallback(
    async (project: Project) => {
      try {
        // 条数取自库而不是缓存：项目可能没展开，渲染层手里根本没有它的会话列表
        const sessions = await window.colt.invoke("session.list", { projectId: project.id });
        const { confirmed } = await window.colt.invoke("dialog.confirm", {
          message: `将把「${project.name}」从列表移除，并收进「已移除」。`,
          detail: `磁盘上的文件夹与其中的文件不会被删除。这里的 ${sessions.length} 条会话会一并收起，随时可以恢复；不会删除任何会话记录。`,
          confirmLabel: "移除",
        });
        if (!confirmed) return;
        await window.colt.invoke("project.remove", { projectId: project.id });

        setExpandedProjects((set) => {
          if (!set.has(project.id)) return set;
          const next = new Set(set);
          next.delete(project.id);
          return next;
        });
        const list = await window.colt.invoke("project.list", undefined);
        setProjects(list);
        // 被移除的目录不能继续当「当前项目」：切到下一条在列的**工作目录**（没有就留空，
        // 「无位置时的兜底」那条 effect 会给一条默认空间草稿，中间区不落空）
        setActiveProject((current) =>
          current?.id === project.id
            ? (list.find((item) => item.kind !== "task" && item.removedAt === null) ?? null)
            : current,
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [],
  );

  /** 从「已移除」区恢复工作目录：登记与会话原样回来（FR-04；同一路径已重开则主进程合并到那一行） */
  const restoreProject = useCallback(
    async (project: Project) => {
      try {
        await window.colt.invoke("project.restore", { projectId: project.id });
        const list = await window.colt.invoke("project.list", undefined);
        setProjects(list);
        // 恢复后必须复检：目录可能仍然缺失/不可访问，结论不能沿用「被移除」时的旧状态
        await refreshAvailability();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [refreshAvailability],
  );

  /**
   * 重建默认空间会话的产物目录（FR-02 异常路径）：只补目录与 manifest，保留对话。
   * 重建后立刻重查一次可用性，横幅应随之消失。
   */
  const rebuildArtifactDir = useCallback(
    async (sessionId: string) => {
      try {
        await window.colt.invoke("session.rebuildArtifactDir", { sessionId });
        await refreshAvailability();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [refreshAvailability],
  );

  /**
   * 执行「在新位置继续」（FR-03）：主进程复制对话与改动记录并建好新会话，这里只负责
   * 把它接进侧栏、切过去。源会话保持原样——复制期间它只读，完成后可继续。
   */
  const continueAtNewLocation = useCallback(
    async (source: SessionInfo, target: Project) => {
      setContinuing(true);
      try {
        const { session } = await window.colt.invoke("session.continueAtNewLocation", {
          sessionId: source.id,
          projectId: target.id,
        });
        setContinueFor(null);
        setContinuingTo(null);
        await loadProjectSessions(target.id);
        setProjects(await window.colt.invoke("project.list", undefined));
        setActiveProject(target);
        setActiveSession(session);
        setMainView("chat");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setContinuing(false);
      }
    },
    [loadProjectSessions],
  );

  const query = sidebarQuery.trim().toLowerCase();
  const searching = query !== "";
  /**
   * 侧栏「空间」栏要画的「空间 → 会话」行：平时直接来自按项目懒加载的缓存；搜索时换成
   * **过滤后**的集合。任务工作区不在这里画（它有自己的「任务」栏，见 taskRows）。
   *
   * 搜索两条规则（都按数据本身判，不猜）：① 空间命中 `name` / `rootPath` → 显示该空间行，
   * 并给它的**全部**会话（你搜的就是这个空间）；② 空间没命中、但有会话命中 `title` → 同样
   * 显示空间行，但只给命中的会话。搜索时一律展开（命中就得看得见），而 `expandedProjects`
   * **不动**——清空后用户原来的展开态原样回来。
   */
  const sidebarRows = useMemo<
    { project: Project; sessions: SessionInfo[] | undefined; expanded: boolean }[]
  >(() => {
    if (!searching) {
      return spaceProjects.map((project) => ({
        project,
        sessions: sessionsByProject.get(project.id),
        expanded: expandedProjects.has(project.id),
      }));
    }
    const all = searchSessions ?? [];
    const matched: { project: Project; sessions: SessionInfo[]; expanded: boolean }[] = [];
    for (const project of spaceProjects) {
      const projectHit =
        project.name.toLowerCase().includes(query) ||
        project.rootPath.toLowerCase().includes(query);
      // 归档的会话不进搜索结果：它们在侧栏是「收起来」的，搜索把它翻出来会与那个语义打架
      const mine = all.filter(
        (session) => session.projectId === project.id && session.status !== "archived",
      );
      const hits = mine.filter((session) => session.title.toLowerCase().includes(query));
      if (!projectHit && hits.length === 0) continue;
      matched.push({ project, sessions: projectHit ? mine : hits, expanded: true });
    }
    return matched;
  }, [searching, query, spaceProjects, searchSessions, sessionsByProject, expandedProjects]);

  /**
   * 「任务」栏要画的会话行（平铺，无分组）。平时来自任务工作区的缓存（启动即拉，
   * 见上方常载 effect）；搜索时从全量会话里过滤，规则与「空间」栏一致——任务工作区的
   * 名字 / 路径命中就给全部任务会话，否则只给标题命中的；归档的不进。
   *
   * 三态：`undefined` = 还没拉到（极短的启动窗口）；`null` = 搜索中（全量还没回来）；
   * 数组 = 可直接画的列表。
   */
  const taskRows = useMemo<SessionInfo[] | null | undefined>(() => {
    if (!taskProject) return undefined;
    if (!searching) return sessionsByProject.get(taskProject.id);
    if (searchSessions === null) return null;
    const mine = searchSessions.filter(
      (session) => session.projectId === taskProject.id && session.status !== "archived",
    );
    const projectHit =
      taskProject.name.toLowerCase().includes(query) ||
      taskProject.rootPath.toLowerCase().includes(query);
    return projectHit ? mine : mine.filter((session) => session.title.toLowerCase().includes(query));
  }, [taskProject, searching, query, searchSessions, sessionsByProject]);

  /**
   * 画一条会话行——**项目常规列表与底部「已归档」区共用**（两处只有 `archived` 不同，共用
   * 一套模板免得日后各自漂移）。归档行多一个 `context`（所属项目名）：底部那个区是**跨项目**
   * 的，不写项目名就分不清不同项目里的同名会话；常规列表按项目分组，不必写。
   */
  const renderSessionRow = (session: SessionInfo, archived: boolean): React.ReactNode => (
    <SessionRow
      key={session.id}
      session={session}
      archived={archived}
      context={
        archived
          ? (() => {
              const owner = projects.find((item) => item.id === session.projectId);
              // 默认空间的会话没有目录名可说：按「工作位置」的称呼写「默认空间」（FR-05）
              if (!owner) return "未知位置";
              return owner.kind === "task" ? "默认空间" : owner.name;
            })()
          : undefined
      }
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
        // 会话归哪个项目由它自己的 `projectId` 决定（切项目那一下要把它一并选中，见 conversationProject）
        const owner = projects.find((item) => item.id === session.projectId);
        if (owner && owner.id !== activeProject?.id) setActiveProject(owner);
        // 在设置 / 改动页点会话行也必须回到对话视图
        setMainView("chat");
        setActiveSession(session);
      }}
      onTogglePin={() => togglePin(session.id)}
      onToggleArchive={() => void setSessionArchived(session, !archived)}
      onDelete={() => void deleteSession(session)}
    />
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
              // 「清空重来」会把任务工作区连同库一起清掉：幂等地再保证一次
              const taskWorkspace = await window.colt
                .invoke("project.ensureTask", undefined)
                .catch(() => null);
              const merged =
                taskWorkspace && !projectList.some((item) => item.id === taskWorkspace.id)
                  ? [...projectList, taskWorkspace]
                  : projectList;
              setProjects(merged);
              setActiveProject(merged.find((item) => item.kind !== "task") ?? null);
              setProviders(providerList);
              setModelServiceReady(hasUsableProvider(providerList));
              // 「清空重来」会把已归档会话一并清掉（沿用历史则不变）：跨项目归档列表跟着刷新
              void refreshArchived();
              if (choice === "fresh") setActiveSession(null);
            })();
          }}
        />
      )}
      <header className="flex h-[var(--h-topbar)] shrink-0 items-center justify-between border-b border-line bg-surface-raised px-3.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold tracking-[.5px] text-text-primary">
            Colt
          </span>
        </div>
        <div className="flex items-center gap-2">
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
        <aside
          data-sidebar
          className="flex w-[240px] shrink-0 flex-col border-r border-line bg-surface-raised"
        >
          {/* 全局「新建会话」，常驻在侧栏上方。落点**跟随当前上下文**（FR-01）：当前会话
              属于某工作目录 → 建到该目录；当前在默认空间 / 没有会话 → 建到默认空间。
              按钮上直接写出将要落到的目标，用户不用猜。想精确指定时用目录行的「+」
              或默认空间分区头的「新建」。ensureTask 失败（IO 错误）时如实置灰，
              不做成点了没反应。 */}
          <div className="shrink-0 space-y-2 px-3 pt-3">
            <button
              type="button"
              onClick={() => {
                if (!newSessionTarget) return;
                // 左栏高亮跟随「当前会话所属项目」——默认空间也是项目，目标为它时同样要同步，
                // 否则新会话已经落在默认空间、左栏却还亮着原来的工作目录
                if (newSessionTarget.id !== activeProject?.id) {
                  setActiveProject(newSessionTarget);
                }
                setMainView("chat");
                void newSession(newSessionTarget.id);
              }}
              disabled={!newSessionTarget}
              data-sidebar-new-session
              title={
                newSessionTarget
                  ? `新建会话 · ${newSessionTarget.kind === "task" ? "默认空间" : newSessionTarget.name}`
                  : "正在准备默认空间…"
              }
              className="flex w-full items-center justify-center gap-1.5 rounded-sm border border-line px-2 py-1.5 text-xs text-text-secondary transition hover:border-line-strong hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Plus {...ICON.sm} />
              <span className="truncate">
                新建会话
                {newSessionTarget && (
                  <span className="text-text-muted">
                    {" · "}
                    {newSessionTarget.kind === "task" ? "默认空间" : newSessionTarget.name}
                  </span>
                )}
              </span>
            </button>
            {/* 侧栏搜索：过滤**这一份列表**（会话标题 / 项目名与路径），不是搜会话正文——
                那是 ④ 会话头那枚「搜索」的事，两回事。命中后侧栏切成过滤视图，见 sidebarRows。 */}
            <div className="relative">
              <Search
                {...ICON.xs}
                className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-text-muted"
              />
              <input
                type="text"
                value={sidebarQuery}
                onChange={(event) => setSidebarQuery(event.target.value)}
                disabled={projects.length === 0}
                data-sidebar-search
                placeholder="搜索会话 / 项目"
                aria-label="搜索会话或项目"
                className="w-full rounded-sm border border-line bg-transparent py-1.5 pl-6 pr-7 text-xs text-text-primary outline-none transition placeholder:text-text-muted focus:border-line-strong disabled:cursor-not-allowed disabled:opacity-40"
              />
              {sidebarQuery !== "" && (
                <button
                  type="button"
                  onClick={() => setSidebarQuery("")}
                  title="清空搜索"
                  aria-label="清空搜索"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-xs p-0.5 text-text-muted transition hover:bg-surface-overlay hover:text-text-primary"
                >
                  <X {...ICON.xs} />
                </button>
              )}
            </div>
          </div>
          {/*
            「默认空间」栏：与「工作目录」栏平级。不指定工作位置新建的会话全落这里——
            默认空间是**一条真实的项目行**（会话必须落在真实目录上），只是它不出现在
            「工作目录」列表里、也没有移除入口（它承担所有未指定目录会话的落点，不能留空）。
            会话平铺、不分组、不显示路径，列表自身限高可滚，不把下方目录区挤没。
          */}
          {taskProject && (
            <SidebarSection
              title="默认空间"
              fill={false}
              actions={[
                {
                  label: "产物",
                  icon: <FolderOpen {...ICON.xs} />,
                  title: "默认空间的跨会话产物清单（含已删除会话）",
                  onClick: () => setMainView("artifacts"),
                },
                {
                  label: "新建",
                  icon: <Plus {...ICON.xs} />,
                  title: "在默认空间新建会话",
                  onClick: () => {
                    // 与顶部按钮一致：高亮跟随新会话所属项目（这里就是默认空间）
                    if (taskProject.id !== activeProject?.id) setActiveProject(taskProject);
                    setMainView("chat");
                    void newSession(taskProject.id);
                  },
                },
              ]}
            >
              {searching && searchSessions === null ? (
                <div className="px-2 py-1.5 text-xs text-text-muted">搜索中…</div>
              ) : taskRows == null ? (
                <div className="px-2 py-1.5 text-xs text-text-muted">加载中…</div>
              ) : taskRows.length === 0 ? (
                searching ? (
                  <div className="px-2 py-1.5 text-xs text-text-muted">没有匹配的默认空间会话</div>
                ) : (
                  <Empty>
                    不指定目录的会话会出现在这里，每条都有自己的产物目录
                  </Empty>
                )
              ) : (
                taskRows.map((session) => renderSessionRow(session, false))
              )}
            </SidebarSection>
          )}
          <SidebarSection
            title="工作目录"
            actions={[
              {
                label: "打开",
                icon: <FolderOpen {...ICON.xs} />,
                title: "打开一个工作目录",
                onClick: () => void pickProject(),
              },
            ]}
          >
            {spaceProjects.length === 0 ? (
              <Empty>还没有工作目录，点「打开」选择一个文件夹</Empty>
            ) : searching && searchSessions === null ? (
              <div className="px-2 py-1.5 text-xs text-text-muted">搜索中…</div>
            ) : searching && sidebarRows.length === 0 ? (
              <div className="px-2 py-1.5 text-xs text-text-muted">
                没有匹配「{sidebarQuery.trim()}」的会话或项目
              </div>
            ) : (
              sidebarRows.map(({ project, sessions, expanded: rowExpanded }) => {
                // 搜索态一律展开，但允许逐行手动收起（见 searchCollapsed）——不写 expandedProjects。
                const expanded = searching ? !searchCollapsed.has(project.id) : rowExpanded;
                // `undefined` 与空数组必须分开：前者是**还没拉到**，后者是「确实没有会话」。
                // 这份列表**只含常规会话**（已归档的由 `loadProjectSessions` 滤掉，去了底部那个区）。
                const list = sessions ?? [];
                return (
                  <div key={project.id} className="mb-0.5">
                    <ProjectRow
                      project={project}
                      active={project.id === activeProject?.id}
                      expanded={expanded}
                      busy={list.some((session) => runningSessions.has(session.id))}
                      unavailable={unavailableProjects.has(project.id)}
                      onToggle={() => {
                        // 搜索态：收起只作用于**本次搜索**——不写 expandedProjects（用户的展开态
                        // 不能被搜索污染），也不必重拉（结果集本就是从全量会话算出来的）。
                        if (searching) {
                          setSearchCollapsed((set) => {
                            const next = new Set(set);
                            if (next.has(project.id)) next.delete(project.id);
                            else next.add(project.id);
                            return next;
                          });
                          return;
                        }
                        setExpandedProjects((set) => {
                          const next = new Set(set);
                          if (next.has(project.id)) next.delete(project.id);
                          else next.add(project.id);
                          return next;
                        });
                        // 展开即拉取：会话列表是**按项目懒加载**的，此前只有「把它选成当前项目」
                        // 才会去拉（切项目那个 effect）——于是展开一个没选中的项目只会照缓存画，
                        // 缓存为空就显示「还没有会话」，其实库里全是会话。只在「本次是展开」时拉，
                        // 收起不动缓存，下次展开直接画。
                        if (!expandedProjects.has(project.id)) void loadProjectSessions(project.id);
                      }}
                      onActivate={() => setActiveProject(project)}
                      onNewSession={() => {
                        if (project.id !== activeProject?.id) setActiveProject(project);
                        // 无论当前在哪个视图（设置 / 改动），新建会话都要回到对话视图：
                        // 否则主区停在原页面、会话在后台静默创建——看起来就是「点了没反应」。
                        setMainView("chat");
                        void newSession(project.id);
                      }}
                      onRemove={() => void removeProject(project)}
                    />
                    {expanded && (
                      <div className="mt-0.5 pl-3">
                        <div className="truncate px-2 py-0.5 font-mono text-2xs text-text-muted">
                          {project.rootPath}
                        </div>
                        {sessions === undefined ? (
                          <div className="px-2 py-1.5 text-xs text-text-muted">加载中…</div>
                        ) : list.length === 0 ? (
                          <div className="px-2 py-1.5 text-xs text-text-muted">还没有会话</div>
                        ) : (
                          list.map((session) => renderSessionRow(session, false))
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </SidebarSection>
          {/*
            「已移除」区（FR-07）：从列表移除的工作目录收在这里，默认收起、标题带数量。
            展开只列目录名与「恢复」——登记与会话都还在，恢复后其下会话一起回来。
            没有已移除目录时整个分区不显示。
          */}
          {removedProjects.length > 0 && (
            <div className="flex min-h-0 shrink-0 flex-col border-t border-line">
              <button
                type="button"
                data-removed-toggle
                aria-expanded={removedOpen}
                onClick={() => setRemovedOpen((value) => !value)}
                className="flex shrink-0 items-center gap-1.5 px-3.5 py-2 text-left transition hover:bg-surface-overlay/60"
              >
                <ChevronRight
                  {...ICON.xs}
                  className={cn(
                    "shrink-0 text-text-muted transition-transform",
                    removedOpen && "rotate-90",
                  )}
                />
                <span className="truncate text-xs font-semibold uppercase tracking-[.5px] text-text-muted">
                  已移除
                </span>
                <span
                  data-removed-count
                  className="ml-auto shrink-0 text-2xs tabular-nums text-text-muted"
                >
                  {removedProjects.length}
                </span>
              </button>
              {removedOpen && (
                <div className="max-h-[30vh] min-h-0 overflow-y-auto px-2 pb-2">
                  <div className="px-1.5 pb-1 text-2xs text-text-muted">
                    恢复后其下会话一起回来
                  </div>
                  {removedProjects.map((project) => (
                    <div
                      key={project.id}
                      data-removed-row={project.id}
                      className="flex items-center gap-1.5 rounded-sm py-1 pl-1.5 pr-1.5 hover:bg-surface-overlay/60"
                    >
                      <span className="min-w-0 flex-1 truncate text-sm text-text-secondary">
                        {project.name}
                      </span>
                      <button
                        type="button"
                        onClick={() => void restoreProject(project)}
                        data-removed-restore={project.id}
                        className="shrink-0 rounded-xs px-1.5 py-0.5 text-2xs text-text-muted transition hover:bg-line-soft hover:text-text-primary"
                      >
                        恢复
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {/*
            「已归档」区：**钉在侧栏底部**（`shrink-0`，在默认空间 / 工作目录 / 已移除之后），
            跨位置汇总——归档的从上面的列表里收走、全落这里，默认收起。
            只有确实有归档会话时才出现（没有就不占地方）。展开后限高可滚，别把上面的栏挤没。
            收起状态下的条数也要如实，故 `archivedSessions` 在挂载时就拉好（见 refreshArchived）。
          */}
          {archivedSessions.length > 0 && (
            <div className="flex min-h-0 shrink-0 flex-col border-t border-line">
              <button
                type="button"
                data-archived-toggle
                aria-expanded={archivedOpen}
                onClick={() => setArchivedOpen((value) => !value)}
                className="flex shrink-0 items-center gap-1.5 px-3.5 py-2 text-left transition hover:bg-surface-overlay/60"
              >
                <ChevronRight
                  {...ICON.xs}
                  className={cn(
                    "shrink-0 text-text-muted transition-transform",
                    archivedOpen && "rotate-90",
                  )}
                />
                <span className="truncate text-xs font-semibold uppercase tracking-[.5px] text-text-muted">
                  已归档
                </span>
                <span className="ml-auto shrink-0 text-2xs tabular-nums text-text-muted">
                  {archivedSessions.length}
                </span>
              </button>
              {archivedOpen && (
                <div className="max-h-[40vh] min-h-0 overflow-y-auto px-2 pb-2">
                  {archivedSessions.map((session) => renderSessionRow(session, true))}
                </div>
              )}
            </div>
          )}
        </aside>

        <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {error && (
            <ErrorNotice
              message={error}
              onDismiss={() => setError(null)}
              className="m-3.5 shrink-0"
            />
          )}

          {modelServiceReady === false && (
            <div className="m-3.5 shrink-0 rounded-md border border-line bg-warning-soft px-3.5 py-3 text-sm text-warning-fg">
              尚未配置任何模型服务的 API Key，无法开始对话。请在设置中填写密钥（内置
              DeepSeek 或自建的 OpenAI 兼容服务均可）。
            </div>
          )}

          {/* 环境体检的问题（缺 bash / node:sqlite 不可用）原先只在 `env.problems` 里，界面
              从来没人读——顶部那行「未找到 bash」既没原因也没下一步。这里统一摊开：
              `env === null` 表示还在探测，不能报（否则每次启动先闪一帧假红）。 */}
          {env !== null && env.problems.length > 0 && (
            <div
              data-env-problems=""
              className="m-3.5 shrink-0 rounded-md border border-warning/40 bg-warning-soft px-3.5 py-3 text-xs leading-relaxed text-warning-fg"
            >
              {env.problems.map((problem) => (
                <p key={problem}>{problem}</p>
              ))}
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
            ) : mainView === "artifacts" ? (
              // 默认空间产物清单：不依赖当前会话 / 项目——它是整个容器的视图
              <DefaultSpaceArtifacts onClose={() => setMainView("chat")} />
            ) : mainView === "changes" && activeProject ? (
              <ProjectChanges key={activeProject.id} projectId={activeProject.id} />
            ) : activeSession && conversationProject ? (
              <Conversation
                key={activeSession.id}
                sessionId={activeSession.id}
                // 会话有自己的目录（默认空间会话的产物目录）就显示它；null 回落项目根。
                // 草稿 cwd 恒为 null——目录要等首条消息落库才建，草稿态先按项目根走。
                cwd={activeSession.cwd ?? conversationProject.rootPath}
                locationKind={conversationProject.kind === "task" ? "default" : "workspace"}
                locationName={conversationProject.name}
                locationUnavailable={
                  // 「已移除」也算不可用：目录可能还在盘上，但这条会话**不能运行**
                  // （主进程会拒绝），横幅要如实提前告知（FR-07 / FR-08）
                  conversationProject.removedAt !== null ||
                  unavailableProjects.has(conversationProject.id) ||
                  unavailableSessions.has(activeSession.id)
                }
                onRebuildArtifactDir={
                  conversationProject.kind === "task"
                    ? () => void rebuildArtifactDir(activeSession.id)
                    : undefined
                }
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
                onSessionForked={handleSessionForked}
                onContinueAtNewLocation={() => {
                  setContinueFor(activeSession);
                  setContinuingTo(null);
                }}
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
      {continueFor && (
        <ContinueDialog
          source={continueFor}
          currentProjectId={continueFor.projectId}
          targets={[taskProject, ...spaceProjects].filter(
            (item): item is Project => item !== null,
          )}
          unavailableIds={unavailableProjects}
          selectedId={continuingTo}
          busy={continuing}
          onSelect={setContinuingTo}
          onCancel={() => {
            if (continuing) return;
            setContinueFor(null);
            setContinuingTo(null);
          }}
          onConfirm={(target) => void continueAtNewLocation(continueFor, target)}
        />
      )}
    </div>
  );
}

/**
 * 「在新位置继续…」的目标选择框（FR-03）。
 *
 * 只列**已登记**的工作目录与默认空间：目标必须是一个真实位置，选择与当前相同的位置时
 * 确认按钮置灰（PRD：不产生任何变化）。复制期间显示不确定进度（「正在复制对话…」），
 * 不承诺百分比，也不阻塞其他会话——它只是这一条会话的复制。
 */
function ContinueDialog({
  source,
  currentProjectId,
  targets,
  unavailableIds,
  selectedId,
  busy,
  onSelect,
  onCancel,
  onConfirm,
}: {
  source: SessionInfo;
  currentProjectId: string;
  targets: Project[];
  /** 当前查到的不可用工作目录（FR-04）：不可作为复制目标，按钮上直接说明 */
  unavailableIds: ReadonlySet<string>;
  selectedId: string | null;
  busy: boolean;
  onSelect: (projectId: string) => void;
  onCancel: () => void;
  onConfirm: (target: Project) => void;
}): React.JSX.Element {
  const selected = targets.find((item) => item.id === selectedId) ?? null;
  const sameLocation = selected !== null && selected.id === currentProjectId;
  const selectedUnavailable =
    selected !== null && selected.kind !== "task" && unavailableIds.has(selected.id);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-6">
      <div
        role="dialog"
        aria-label="在新位置继续"
        data-continue-dialog
        className="flex max-h-[80vh] w-full max-w-[480px] flex-col overflow-hidden rounded-md border border-line bg-surface-raised shadow-lg"
      >
        <div className="shrink-0 border-b border-line px-4 py-3">
          <h3 className="m-0 text-sm font-semibold text-text-primary">在新位置继续</h3>
          <p className="mt-1 text-xs leading-relaxed text-text-secondary">
            「{source.title}」会复制成一条新会话，对话与改动记录一起带过去；原会话保持原样。
            文件不会复制，旧工具卡仍可打开原文件。复制期间原会话暂时只读，完成后可以继续。
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {targets.map((target) => {
            const isCurrent = target.id === currentProjectId;
            const isDefault = target.kind === "task";
            const unavailable = !isDefault && unavailableIds.has(target.id);
            return (
              <button
                key={target.id}
                type="button"
                disabled={isCurrent || unavailable || busy}
                onClick={() => onSelect(target.id)}
                data-continue-target={target.id}
                data-continue-unavailable={unavailable ? "" : undefined}
                className={cn(
                  "flex w-full items-center gap-2 rounded-sm px-2.5 py-2 text-left text-sm transition",
                  selectedId === target.id ? "bg-surface-overlay" : "hover:bg-surface-overlay/60",
                  (isCurrent || unavailable) && "cursor-not-allowed opacity-40",
                )}
              >
                <span className="min-w-0 flex-1 truncate text-text-primary">
                  {isDefault ? "默认空间" : target.name}
                </span>
                {isCurrent && <span className="shrink-0 text-2xs text-text-muted">当前位置</span>}
                {unavailable && (
                  <span className="shrink-0 text-2xs text-warning-fg">位置不可用</span>
                )}
                {isDefault && !isCurrent && (
                  <span className="shrink-0 text-2xs text-text-muted">分配独立产物目录</span>
                )}
              </button>
            );
          })}
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-3">
          {busy && <span className="mr-auto text-xs text-text-muted">正在复制对话…</span>}
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-sm border border-line px-3 py-1.5 text-xs text-text-secondary transition hover:border-line-strong hover:text-text-primary disabled:opacity-40"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => selected && onConfirm(selected)}
            disabled={!selected || sameLocation || selectedUnavailable || busy}
            data-continue-confirm
            title={
              sameLocation
                ? "目标与当前位置相同，不会产生变化"
                : selectedUnavailable
                  ? "目标目录当前不可用"
                  : undefined
            }
            className="rounded-sm border border-line px-3 py-1.5 text-xs text-text-primary transition hover:border-line-strong disabled:cursor-not-allowed disabled:opacity-40"
          >
            继续
          </button>
        </div>
      </div>
    </div>
  );
}

function SidebarSection({
  title,
  actions,
  collapsible = true,
  fill = true,
  children,
}: {
  title: string;
  /** 分区头右侧的动作（可多个：默认空间既有「产物」也有「＋ 新建」） */
  actions?: { label: string; icon: React.ReactNode; onClick: () => void; title?: string }[];
  collapsible?: boolean;
  /**
   * 是否吃满剩余高度（flex-1）。「工作目录」栏吃满；「默认空间」栏自适应内容、限高可滚
   * （max-h-[40vh]）——默认空间的会话通常不多，不该平白占掉半个侧栏把目录区挤没。
   */
  fill?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className={cn("flex min-h-0 flex-col", fill ? "flex-1" : "shrink-0")}>
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
        {actions?.map((action) => (
          <button
            key={action.label}
            type="button"
            onClick={action.onClick}
            title={action.title}
            data-section-action={action.label}
            className="flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-1 text-xs text-text-secondary opacity-0 transition group-hover:opacity-100 hover:bg-surface-overlay hover:text-text-primary focus:opacity-100"
          >
            {action.icon}
            {action.label}
          </button>
        ))}
      </div>
      {!collapsed && (
        <div
          className={cn(
            "min-h-0 overflow-y-auto px-2 pb-2",
            fill ? "flex-1" : "max-h-[40vh]",
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/** 已运行时长：mm:ss */
function formatElapsed(startedAt: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - startedAt) / 1000));
  return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
}

/** 工作目录行：折叠三角 + 目录名 + 新建会话 + 从列表移除 */
function ProjectRow({
  project,
  active,
  expanded,
  busy,
  unavailable,
  onToggle,
  onActivate,
  onNewSession,
  onRemove,
}: {
  project: Project;
  active: boolean;
  expanded: boolean;
  /** 该目录下有会话正在运行（含等人回话）——此时不允许移除，与主进程的拒绝一致 */
  busy: boolean;
  /** 位置不可用（FR-04）：仍可打开查看历史，但不把新会话建进去；标记要一直看得见 */
  unavailable: boolean;
  onToggle: () => void;
  onActivate: () => void;
  onNewSession: () => void;
  onRemove: () => void;
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
      <span
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          unavailable ? "bg-danger" : "bg-text-muted",
        )}
      />
      <button type="button" onClick={onActivate} className="min-w-0 flex-1 text-left">
        <div className="truncate text-sm text-text-primary">{project.name}</div>
      </button>
      {unavailable && (
        <span
          data-project-unavailable
          title="目录不存在或暂时无法访问：会话可查看历史，但不能发送"
          className="shrink-0 rounded-xs bg-warning-soft px-1.5 py-0.5 text-2xs text-warning-fg"
        >
          位置不可用
        </span>
      )}
      <button
        type="button"
        onClick={onNewSession}
        disabled={unavailable}
        title={unavailable ? "位置不可用：请重新定位或在别处新建" : "新建会话"}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-xs text-text-muted opacity-0 transition group-hover:opacity-100 hover:bg-line-soft hover:text-text-primary focus:opacity-100 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
      >
        <Plus {...ICON.xs} />
      </button>
      <button
        type="button"
        onClick={onRemove}
        disabled={busy}
        data-project-remove
        title={busy ? "有会话正在运行，暂不能移除目录" : "从列表移除（不影响磁盘上的文件，可恢复）"}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-xs text-text-muted opacity-0 transition group-hover:opacity-100 hover:bg-line-soft hover:text-text-primary focus:opacity-100 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-text-muted"
      >
        <X {...ICON.xs} />
      </button>
    </div>
  );
}

/** 会话行：状态点 + 标题 / 副标题（运行中带计时），悬停显示复制/删除 */
function SessionRow({
  session,
  active,
  archived,
  context,
  startedAt,
  offlineState,
  waiting,
  pinned,
  now,
  onClick,
  onTogglePin,
  onToggleArchive,
  onDelete,
}: {
  session: SessionInfo;
  active: boolean;
  /** 归档态：标题变暗、不画图钉、悬停出「恢复」。数据仍在，只是收在底部「已归档」区里 */
  archived: boolean;
  /**
   * 前置上下文（目前只有归档行用：**所属项目名**）——底部「已归档」区是**跨项目**的，
   * 不写项目名会分不清不同项目里的同名会话；常规列表按项目分组，传 `undefined`。
   */
  context?: string;
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
  /** 归档 / 恢复本行（`archived` 决定方向，见 setSessionArchived） */
  onToggleArchive: () => void;
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
              active ? "text-text-primary" : archived ? "text-text-muted" : "text-text-secondary",
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
            {context && <span className="text-text-muted">{context} · </span>}
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
      {/* 图钉只在常规行出现：归档时主进程已解掉图钉（见 session.setArchived），
          在归档行上画它等于展示一个已被清掉的状态 */}
      {!archived && (
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
      )}
      {/* 归档 / 恢复：可逆、不删任何数据（与删除会话的分界）。**归档运行中的会话**会被
          主进程拒绝（它会从列表消失、却在后台继续跑），故与删除一致地置灰并说明原因；
          **恢复**不受限——把一条归档会话捞回来是无害的。 */}
      <button
        type="button"
        onClick={onToggleArchive}
        disabled={!archived && running}
        title={
          !archived && running
            ? "运行中的会话不可归档"
            : archived
              ? "恢复：移回会话列表"
              : "归档：从列表收起（数据保留）"
        }
        aria-label={archived ? "恢复会话" : "归档会话"}
        data-session-archive={archived ? "restore" : "archive"}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-xs text-text-muted opacity-0 transition group-hover/session:opacity-100 hover:bg-line-soft hover:text-text-primary focus:opacity-100 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-text-muted"
      >
        {archived ? <ArchiveRestore {...ICON.xs} /> : <Archive {...ICON.xs} />}
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
