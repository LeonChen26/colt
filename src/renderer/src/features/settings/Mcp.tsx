// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * MCP 一屏两段：**已接入**（现在能用什么）/ **可安装**（还能加什么）。
 *
 * 为什么是一屏而不是两屏（初稿曾拆成「可选安装」+「MCP 服务」两项导航）：
 * CodeWiki 既在目录里可装、装完又是一个 MCP server。分屏之后它装完就搬到隔壁屏，
 * 用户的第一句话必然是「我装了它去哪了」，而两屏都要为这句话加跳转链接。
 * 用户在问「codewiki 算可选安装还是 mcp」的时候，就已经在说：这两件事在他脑子里是
 * **一件事**。界面不该先制造一个用户不会做的区分，再用两个链接去补。
 *
 * 两段的分工不是「谁的配置」，是「已有什么」和「还能加什么」：
 * - 已接入：条目来自配置文件合并（项目级 + 用户级），主进程只读 + 报运行态；
 * - 可安装：条目来自 `MCP_CATALOG` 常量，Colt 负责探测 / 装 / 卸 / 钉版本。
 *
 * 由此定下两条：**一张卡不是两张**（装完是把它从下段移到上段，不是两边各留一份）；
 * **前置检查不再常驻**（未装时只给 host 三项门禁芯片，装坏了才在已接入那行展开全部五项）。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type {
  McpCatalogView,
  McpInstallStep,
  McpPresetState,
  McpProbeItem,
  McpServerView,
  Project,
} from "@shared/protocol";
import { cn } from "@/lib/utils";
import { Chip, Details, Notice, PanelHead, SectionLabel } from "./parts";

/**
 * 目录探测要 spawn 5 条命令（`python --version` × 3 候选 + `git --version` + 两次 import 探版本），
 * 冷启在两秒以上。设置页是条件渲染的（切走就卸载），所以这里做**模块级**缓存——
 * 它跨挂载保留，正好等于「本次应用运行内只探一次」。安装 / 卸载成功后清空。
 *
 * 不做定时过期：探测结论只有在「用户自己动了机器」时才会变，而那一刻他一定会点「刷新」。
 */
let catalogCache: McpCatalogView | null = null;

/**
 * 安装 / 卸载的**跨挂载**状态。
 *
 * 为什么不能留在组件里：`mcp.installProgress` 由主进程逐条推送，而接收方是 `McpPanel`
 * 的 `useEffect`。切到「技能」再切回来，组件卸载重挂，`steps` 与 `busy` 一起清零——
 * 用户看到「安装按钮又变回安装」，而 pip 其实还在跑（几十秒到几分钟）。
 *
 * 放在模块级：跨挂载保留，不用改 IPC 形状。应用重启后进度会丢——但那次安装本来就随着
 * 进程没了，这个代价是诚实的。彻底方案是把它提到主进程（`mcp.installState` 查询通道），
 * 好处是渲染层崩了重载也能续上；没做的理由是它要改通道形状，而 store 已经堵住了
 * 用户实际会遇到的场景。
 */
interface InstallState {
  /** 每个 preset 的步骤流水 */
  steps: ReadonlyMap<string, McpInstallStep[]>;
  /** 正在跑的那个 preset id（同一时刻只跑一件：两条流水线会抢同一个 venv 目录） */
  busy: string | null;
  /** 读取目录 / 运行态时的错误（每次 `load` 会重写它） */
  error: string | null;
  /**
   * 安装 / 卸载的收口结论。与 `error` **分开**：`load` 每次挂载都会清 `error`，
   * 而这条必须活过「切屏再回来」——否则用户回到这一屏，失败原因已经被刷没了。
   */
  installError: string | null;
  /** 每次落定 +1：组件据此重新拉目录与运行态 */
  revision: number;
}

const EMPTY_STEPS: McpInstallStep[] = [];

let installState: InstallState = {
  steps: new Map(),
  busy: null,
  error: null,
  installError: null,
  revision: 0,
};
const installListeners = new Set<() => void>();
let installWired = false;

function emitInstall(patch: Partial<InstallState>): void {
  installState = { ...installState, ...patch };
  for (const listener of installListeners) listener();
}

function getInstallState(): InstallState {
  return installState;
}

function subscribeInstall(listener: () => void): () => void {
  installListeners.add(listener);
  // 事件监听只注册一次：它读的是模块级 state，与哪个组件挂着无关
  if (!installWired) {
    installWired = true;
    window.colt.on("mcp.installProgress", (payload) => {
      const list = installState.steps.get(payload.presetId) ?? [];
      const index = list.findIndex((step) => step.id === payload.step.id);
      const next = [...list];
      if (index === -1) next.push(payload.step);
      else next[index] = payload.step;
      const steps = new Map(installState.steps);
      steps.set(payload.presetId, next);
      emitInstall({ steps });
    });
  }
  return () => {
    installListeners.delete(listener);
  };
}

/** 读取 / 安装的错误都走这里：切屏再回来，那条失败原因还在 */
function reportError(error: string | null): void {
  emitInstall({ error });
}

function setSteps(presetId: string, steps: McpInstallStep[]): void {
  const map = new Map(installState.steps);
  map.set(presetId, steps);
  emitInstall({ steps: map });
}

/** 装 / 卸之后：目录与运行态都得重来一遍（`installed` 与 `servers` 是两个数据源） */
async function reloadAfterMutation(projectId: string | undefined): Promise<void> {
  catalogCache = null;
  try {
    if (projectId !== undefined) {
      await window.colt.invoke("mcp.reload", { projectId });
    }
  } catch (e) {
    // 重载失败只报告，不能挡住下面的复位：`busy` 留在模块级 store 里，
    // 不复位就等于安装按钮永久卡在「处理中…」且不可重试。
    emitInstall({ error: e instanceof Error ? e.message : String(e) });
  } finally {
    emitInstall({ busy: null, revision: installState.revision + 1 });
  }
}

async function runInstall(
  preset: McpPresetState,
  projectId: string | undefined,
): Promise<void> {
  const { confirmed } = await window.colt.invoke("dialog.confirm", {
    message: `安装「${preset.name}」？`,
    detail:
      `会在 ${preset.configPath} 里加一条 ${preset.name} 声明（用户级，对全部项目生效），` +
      `并在 Colt 的数据目录建一个独立的 Python 运行时来装它。` +
      `\n\n首次下载约百 MB、分钟级起步；需要 git 与 npm 在 PATH 上。` +
      `不装不影响现有功能，随时可以卸载。`,
    confirmLabel: "安装",
  });
  if (!confirmed) return;
  emitInstall({ busy: preset.id, installError: null });
  setSteps(preset.id, []);
  try {
    const result = await window.colt.invoke("mcp.install", { id: preset.id });
    setSteps(preset.id, result.steps);
    emitInstall({ installError: result.ok ? null : result.error });
  } catch (e) {
    emitInstall({ error: e instanceof Error ? e.message : String(e) });
  } finally {
    await reloadAfterMutation(projectId);
  }
}

async function runUninstall(
  preset: McpPresetState,
  purgeRuntime: boolean,
  projectId: string | undefined,
): Promise<void> {
  const { confirmed } = await window.colt.invoke("dialog.confirm", {
    message: `卸载「${preset.name}」？`,
    detail: purgeRuntime
      ? `会从 ${preset.configPath} 里删掉这一条，并把运行时目录一起清掉（下次装要重新下载）。`
      : `只从 ${preset.configPath} 里删掉这一条，运行时留着——再装是秒级。`,
    confirmLabel: "卸载",
  });
  if (!confirmed) return;
  emitInstall({ busy: preset.id, installError: null });
  setSteps(preset.id, []);
  try {
    const result = await window.colt.invoke("mcp.uninstall", {
      id: preset.id,
      removeRuntime: purgeRuntime,
    });
    setSteps(preset.id, result.steps);
    emitInstall({ installError: result.ok ? null : result.error });
  } catch (e) {
    emitInstall({ error: e instanceof Error ? e.message : String(e) });
  } finally {
    await reloadAfterMutation(projectId);
  }
}

const STATUS_STYLE: Record<
  McpServerView["status"],
  { label: string; className: string; dot: string }
> = {
  connected: { label: "已连接", className: "text-success-fg", dot: "bg-success" },
  error: { label: "连接失败", className: "text-danger", dot: "bg-danger" },
  idle: { label: "未启动", className: "text-text-muted", dot: "bg-text-muted" },
};

const BTN =
  "rounded-sm border border-line px-2 py-0.5 text-2xs text-text-secondary transition hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40";

/**
 * 「有安装 / 卸载正在跑吗」——给外壳的导航项用。
 *
 * 为什么外壳要这个：安装是分钟级的，用户完全可能点完就去别的屏干活。没有这个指示，
 * 他既看不见进度、也不会知道装完了没（只有切回 MCP 屏才能发现）。
 * 返回布尔而不是 id：导航只需要「亮不亮」，不需要知道在装哪一项。
 */
export function useMcpInstallBusy(): boolean {
  return useSyncExternalStore(subscribeInstall, () => installState.busy !== null);
}

export function McpPanel({ project }: { project: Project | null }): React.JSX.Element {
  const [catalog, setCatalog] = useState<McpCatalogView | null>(catalogCache);
  const [servers, setServers] = useState<McpServerView[]>([]);
  const [live, setLive] = useState(false);
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  /** 只有「已接入」段用它。探测慢不该把读配置也压成「读取中」——见 `load` 的注释 */
  const [serversLoading, setServersLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  /** 安装 / 卸载 / 读取的错误来自 store：切屏再回来，那条失败原因还在 */
  const { steps: stepsByPreset, busy, error, installError, revision } = useSyncExternalStore(
    subscribeInstall,
    getInstallState,
  );
  const stepsFor = (presetId: string): McpInstallStep[] =>
    stepsByPreset.get(presetId) ?? EMPTY_STEPS;
  const projectId = project?.id;

  const load = useCallback(
    async (forceCatalog: boolean): Promise<void> => {
      /**
       * 两件事**分开**加载：读配置是毫秒级，探测本机环境是秒级（spawn 五条命令）。
       * 合成一个 loading 的后果是实的——切到这一屏，「已接入」明明早就读到了，
       * 却陪着探测一起显示成「读取中」。
       */
      setServersLoading(true);
      reportError(null);
      const statusTask =
        projectId === undefined
          ? Promise.resolve()
          : window.colt.invoke("mcp.status", { projectId }).then(
              (status) => {
                setServers(status.servers);
                setLive(status.live);
                setDiagnostics(status.diagnostics);
              },
              (e: unknown) => reportError(e instanceof Error ? e.message : String(e)),
            );
      const catalogTask = (
        forceCatalog || catalogCache === null
          ? window.colt.invoke("mcp.catalog", undefined)
          : Promise.resolve(catalogCache)
      ).then(
        (view) => {
          catalogCache = view;
          setCatalog(view);
        },
        (e: unknown) => reportError(e instanceof Error ? e.message : String(e)),
      );
      await Promise.all([statusTask.finally(() => setServersLoading(false)), catalogTask]);
    },
    [projectId],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  /** 刷新 = 重跑探测 + 让会话重连（两件事一次点完；分开成两个按钮只会让人猜该点哪个） */
  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    try {
      if (projectId !== undefined) {
        const status = await window.colt.invoke("mcp.reload", { projectId });
        setServers(status.servers);
        setLive(status.live);
        setDiagnostics(status.diagnostics);
      }
      await load(true);
    } catch (e) {
      reportError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  };

  /** 安装 / 卸载落定后重拉一次：`installed` 与 `servers` 是两个数据源，缺一边就会说半句话 */
  // 初值取当前 revision：挂载时不该为「上一次安装」再补一次加载（那是别的屏里发生的）
  const seenRevision = useRef(revision);
  useEffect(() => {
    if (revision === seenRevision.current) return;
    seenRevision.current = revision;
    void load(true);
  }, [revision, load]);

  const presets = catalog?.presets ?? [];
  const byServerName = new Map(presets.map((preset) => [preset.serverName, preset]));
  /**
   * 已接入段 = 配置里的声明 + 「声明了但这一刻读不到」的已装条目。
   *
   * 后者不是冗余：`installed` 看的是用户级配置，`servers` 看的是当前项目能不能读到它
   * （没打开项目时是空的）。少了这半句，用户装完东西、还没打开项目，上段一片空白，
   * 会以为安装没成功。
   *
   * ⚠️ 关联 preset 必须看 `origin === "catalog"`，不能只看名字：用户完全可能手写一条
   * 自己的 codewiki（不同参数、不同 venv）。按名字关联会给它一个卸载按钮（删的是用户的
   * 配置）和一句「由内置目录管理」（说的是假话）。
   */
  const attached = [
    ...servers.map((server) => ({
      server,
      preset: server.origin === "catalog" ? byServerName.get(server.name) : undefined,
    })),
    ...presets
      .filter((preset) => preset.installed && !servers.some((s) => s.name === preset.serverName))
      .map((preset) => ({ server: null, preset })),
  ];
  const installable = presets.filter((preset) => !preset.installed);

  return (
    <div>
      <PanelHead
        title="MCP"
        scope="本项目 + 用户级继承"
        scopeTone="project"
        lede="上半是本项目现在能用哪些 server（项目级合并用户级，同名时项目级覆盖），下半是内置目录里还能装什么。装的是用户级配置，装一次所有项目都能用。"
        action={
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing}
            className={BTN}
          >
            {refreshing ? "刷新中…" : "刷新"}
          </button>
        }
      />

      {(installError ?? error) !== null && (
        <div className="mt-2">
          <Notice tone="danger">{installError ?? error}</Notice>
        </div>
      )}
      {catalog?.configError != null && (
        <div className="mt-2">
          <Notice tone="warning">
            用户级配置读不了，下面的「未安装」不可信：{catalog.configError}
          </Notice>
        </div>
      )}
      {diagnostics.length > 0 && (
        <div className="mt-2">
          <Notice tone="danger">
            <span>MCP 配置有 {diagnostics.length} 处问题——坏掉的条目不会出现在下面：</span>
            {diagnostics.map((item) => (
              <span key={item} className="mt-0.5 block font-mono">
                {item}
              </span>
            ))}
          </Notice>
        </div>
      )}

      <div className="mt-4">
        <SectionLabel>已接入 · {serversLoading && attached.length === 0 ? "…" : attached.length}</SectionLabel>
        <div className="mt-1.5 flex flex-col gap-1.5">
          {project === null && attached.length === 0 ? (
            <Notice>先打开一个项目，才能看到本项目声明的 server。下面这些可以直接装。</Notice>
          ) : serversLoading && attached.length === 0 ? (
            <Notice>读取中…</Notice>
          ) : attached.length === 0 ? (
            <Notice>本项目还没有接入任何 MCP server，下面这些可以直接装。</Notice>
          ) : (
            <>
              {!live && attached.length > 0 && (
                <Notice>
                  会话未打开，以下是配置文件里的声明；打开会话后这里会显示真实连接状态。
                  「未启动」不等于「配错了」。
                </Notice>
              )}
              {attached.map(({ server, preset }) =>
                server !== null ? (
                  <ServerRow
                    key={server.name}
                    server={server}
                    preset={preset}
                    busy={busy === preset?.id}
                    steps={preset === undefined ? EMPTY_STEPS : stepsFor(preset.id)}
                    onReinstall={
                      preset === undefined ? undefined : () => void runInstall(preset, projectId)
                    }
                    onUninstall={
                      preset === undefined
                        ? undefined
                        : (purge) => void runUninstall(preset, purge, projectId)
                    }
                  />
                ) : (
                  preset !== undefined && (
                    <ServerRow
                      key={preset.serverName}
                      server={null}
                      preset={preset}
                      busy={busy === preset.id}
                      steps={stepsFor(preset.id)}
                      onReinstall={() => void runInstall(preset, projectId)}
                      onUninstall={(purge) => void runUninstall(preset, purge, projectId)}
                    />
                  )
                ),
              )}
            </>
          )}
        </div>
      </div>

      <div className="mt-5">
        <SectionLabel>
          可安装 · {catalog === null ? "…" : installable.length}
        </SectionLabel>
        <div className="mt-1.5 flex flex-col gap-1.5">
          {catalog === null ? (
            <Notice>
              {error === null
                ? "正在检查本机环境（Python / git 与已装的包），约 2–5 秒…"
                : "目录读不到（见上）。"}
            </Notice>
          ) : installable.length === 0 ? (
            <Notice>目录里的 {presets.length} 项都已经装上了。</Notice>
          ) : (
            installable.map((preset) => (
              <PresetRow
                key={preset.id}
                preset={preset}
                busy={busy === preset.id}
                disabled={busy !== null && busy !== preset.id}
                steps={stepsFor(preset.id)}
                declaredInProject={servers.some((s) => s.name === preset.serverName)}
                onInstall={() => void runInstall(preset, projectId)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/** 已接入段的一行。`origin=catalog` 的那条才有重装 / 卸载，手写条目只能去改 json */
function ServerRow({
  server,
  preset,
  busy,
  steps,
  onReinstall,
  onUninstall,
}: {
  server: McpServerView | null;
  preset: McpPresetState | undefined;
  busy: boolean;
  steps: McpInstallStep[];
  onReinstall?: () => void;
  onUninstall?: (purgeRuntime: boolean) => void;
}): React.JSX.Element {
  // 「连运行时一起清」是**这一条**的卸载选项，所以 state 放在行内。
  // 页级 state 会让一台 server 的勾选影响另一台的卸载确认（跨卡串味）。
  const [purge, setPurge] = useState(false);
  const [showProbe, setShowProbe] = useState(false);

  const name = server?.name ?? preset?.serverName ?? "";
  const status = server === null ? null : STATUS_STYLE[server.status];
  // 声明在、运行时没了：这条不能显示成「已安装」，否则配置指着一条不存在的路径
  const runtimeMissing = preset !== undefined && preset.installed && !preset.runtime;
  // 装坏了（运行时缺失 / 探测红）才展开前置检查：平时它是一项**诊断**，不是常驻清单
  const broken = runtimeMissing || (preset !== undefined && preset.probe.ready === false && server?.status === "error");

  return (
    <div
      data-mcp-server={name}
      data-mcp-preset={preset?.id}
      className="rounded-md border border-line bg-surface-raised px-3 py-2.5"
    >
      <div className="flex items-center gap-2">
        <span className="truncate text-xs font-medium text-text-primary">{name}</span>
        {server !== null && <Chip mono>{server.transport}</Chip>}
        <OriginChip server={server} preset={preset} />
        {status !== null && (
          <span className={cn("ml-auto flex shrink-0 items-center gap-1.5 text-2xs", status.className)}>
            <span className={cn("h-[7px] w-[7px] rounded-full", status.dot)} />
            {status.label}
          </span>
        )}
        {runtimeMissing && (
          <span className="ml-auto flex shrink-0 items-center gap-1.5 text-2xs text-danger">
            <span className="h-[7px] w-[7px] rounded-full bg-danger" />
            运行时缺失
          </span>
        )}
      </div>

      {server !== null ? (
        <div className="mt-0.5 truncate font-mono text-2xs text-text-muted" title={server.target}>
          {server.target}
        </div>
      ) : (
        <div className="mt-0.5 text-2xs text-text-muted">
          声明已在 {preset?.configPath} 里，但当前读不到它的连接状态。
        </div>
      )}

      {server?.error !== undefined && (
        <div className="mt-1 text-2xs text-danger">{server.error}</div>
      )}

      {server !== null && server.tools.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {server.tools.slice(0, 4).map((tool) => (
            <Chip key={tool} mono>
              {tool}
            </Chip>
          ))}
          {server.tools.length > 4 && (
            <span className="text-2xs text-text-muted">+{server.tools.length - 4}</span>
          )}
        </div>
      )}

      {broken && preset !== undefined && (
        <div className="mt-1.5">
          <button
            type="button"
            onClick={() => setShowProbe((value) => !value)}
            className="text-2xs text-text-muted transition hover:text-text-primary"
          >
            {showProbe ? "收起检查明细" : `检查明细（${preset.probe.items.length} 项）`}
          </button>
          {showProbe && <ProbeList preset={preset} />}
        </div>
      )}

      {preset !== undefined && onUninstall !== undefined && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-line-soft pt-2">
          <button type="button" disabled={busy} onClick={onReinstall} className={BTN}>
            {busy ? "处理中…" : "重新安装"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onUninstall(purge)}
            className={cn(
              BTN,
              "hover:border-danger/40 hover:bg-danger-soft hover:text-danger-fg",
            )}
          >
            卸载
          </button>
          <label className="ml-auto flex items-center gap-1.5 text-2xs text-text-muted">
            <input
              type="checkbox"
              checked={purge}
              onChange={(event) => setPurge(event.target.checked)}
              className="h-3 w-3"
            />
            同时删除独立 Python 环境（下次安装需重新下载）
          </label>
        </div>
      )}

      {preset !== undefined && preset.installed && (
        <div className="mt-1 text-2xs text-text-muted">{preset.runtimeNote}</div>
      )}

      <StepList presetId={preset?.id} steps={steps} />
      {preset !== undefined && <ManualCommands preset={preset} />}
    </div>
  );
}

/** 可安装段的一行。只给 host 门禁（能不能装），payload 四项折叠在「检查明细」里 */
function PresetRow({
  preset,
  busy,
  disabled,
  steps,
  declaredInProject,
  onInstall,
}: {
  preset: McpPresetState;
  busy: boolean;
  disabled: boolean;
  steps: McpInstallStep[];
  declaredInProject: boolean;
  onInstall: () => void;
}): React.JSX.Element {
  const host = preset.probe.items.filter((item) => item.kind === "host");
  /** 能不能装只跟**宿主机条件**有关；payload 那两项此刻必然是「未安装」，摆出来是废话 */
  const canInstall = host.every((item) => item.ok);
  const blocking = host.find((item) => !item.ok);

  return (
    <div
      data-mcp-preset={preset.id}
      className="rounded-md border border-line bg-surface-raised px-3 py-2.5"
    >
      <div className="flex items-center gap-2">
        <span className="truncate text-xs font-medium text-text-primary">{preset.name}</span>
      </div>
      <div className="mt-0.5 text-2xs leading-relaxed text-text-muted">{preset.tagline}</div>

      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {host.map((item) => (
          <span
            key={item.id}
            title={item.detail}
            className={cn(
              "shrink-0 rounded-xs border px-1.5 py-0.5 text-2xs",
              item.ok
                ? "border-success/30 text-success-fg"
                : "border-warning/40 text-warning-fg",
            )}
          >
            {item.ok ? "✓" : "✗"} {item.label}
            {item.ok && item.version !== null ? ` ${item.version}` : ""}
          </span>
        ))}
        {!canInstall && blocking?.hint != null && (
          <span className="font-mono text-2xs text-text-muted">{blocking.hint}</span>
        )}
      </div>

      {declaredInProject && (
        <div className="mt-1.5 text-2xs text-text-muted">
          本项目已自行声明一条同名的 server——那不是这里装的，装不装是另一回事。
        </div>
      )}

      <div className="mt-2 flex items-center gap-2 border-t border-line-soft pt-2">
        <ProbeDetails preset={preset} />
        <button
          type="button"
          onClick={onInstall}
          disabled={busy || disabled || !canInstall}
          title={canInstall ? undefined : `${blocking?.label ?? "前置条件"}不满足，按上面的提示处理`}
          className="ml-auto shrink-0 rounded-sm bg-accent px-2.5 py-1 text-2xs text-accent-fg transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "处理中…" : "安装"}
        </button>
      </div>

      <StepList presetId={preset.id} steps={steps} />
      <ManualCommands preset={preset} />
    </div>
  );
}

/** 来源标签：项目级 / 用户级 / 内置目录；同名覆盖时把「覆盖」两个字露出来 */
function OriginChip({
  server,
  preset,
}: {
  server: McpServerView | null;
  preset: McpPresetState | undefined;
}): React.JSX.Element | null {
  if (preset !== undefined || server?.origin === "catalog") {
    return <Chip>内置目录</Chip>;
  }
  if (server?.scope === "project-overrides") {
    return <Chip title="两级都有同名声明，项目级赢了——改用户级那份不会生效">项目级 · 覆盖了用户级</Chip>;
  }
  if (server?.scope === "project") return <Chip>项目级</Chip>;
  if (server?.scope === "user") return <Chip>用户级</Chip>;
  return null;
}

/** 前置检查：逐项给结论。缺件时把「下一步敲什么」直接摆出来，不要求用户自己去查文档 */
function ProbeList({ preset }: { preset: McpPresetState }): React.JSX.Element {
  return (
    <div className="mt-1 flex flex-col gap-1">
      {preset.probe.items.map((item: McpProbeItem) => (
        <div
          key={item.id}
          data-mcp-probe={item.id}
          data-mcp-probe-ok={item.ok ? "1" : "0"}
          className="flex items-start gap-1.5 text-2xs"
        >
          <span
            className={cn(
              "mt-[5px] h-[6px] w-[6px] shrink-0 rounded-full",
              item.ok ? "bg-success" : "bg-warning",
            )}
          />
          <span className="w-16 shrink-0 text-text-secondary">{item.label}</span>
          <span
            className={cn("min-w-0 flex-1 break-words", item.ok ? "text-text-muted" : "text-warning-fg")}
          >
            {item.detail}
            {item.hint !== null && (
              <span className="mt-0.5 block font-mono text-text-muted">{item.hint}</span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

/** 未装时的「检查明细」：四项全给，但收在折叠里 —— 收起态卡片只留 host 两枚门禁芯片 */
function ProbeDetails({ preset }: { preset: McpPresetState }): React.JSX.Element {
  return (
    <Details summary="检查明细">
      <ProbeList preset={preset} />
      <div className="mt-1.5 text-text-muted">
        钉住：{preset.pins.map((pin) => `${pin.label} ${pin.requirement}`).join(" · ")}
      </div>
    </Details>
  );
}

function ManualCommands({ preset }: { preset: McpPresetState }): React.JSX.Element {
  return (
    <Details data-mcp-manual={preset.id} summary="不用一键安装？（手动命令）" className="mt-1.5">
      <div className="flex flex-col gap-1">
        {preset.manualCommands.map((command) => (
          <code key={command} className="break-all font-mono text-text-secondary">
            {command}
          </code>
        ))}
      </div>
    </Details>
  );
}

/** 安装流水：逐步显示，免得一次几十秒的安装在界面上没有下文 */
function StepList({
  presetId,
  steps,
}: {
  presetId: string | undefined;
  steps: McpInstallStep[];
}): React.JSX.Element | null {
  if (presetId === undefined || steps.length === 0) return null;
  return (
    <div
      data-mcp-steps={presetId}
      className="mt-1.5 flex flex-col gap-1 rounded-sm border border-line-soft bg-surface-overlay px-2.5 py-2"
    >
      {steps.map((step) => (
        <div key={step.id} className="flex items-start gap-1.5 text-2xs">
          <span
            className={cn(
              "mt-[2px] w-10 shrink-0",
              step.state === "ok"
                ? "text-success-fg"
                : step.state === "failed"
                  ? "text-danger"
                  : step.state === "skipped"
                    ? "text-text-muted"
                    : "text-text-secondary",
            )}
          >
            {step.state === "ok"
              ? "完成"
              : step.state === "failed"
                ? "失败"
                : step.state === "skipped"
                  ? "跳过"
                  : "进行中"}
          </span>
          <span className="min-w-0 flex-1 break-words text-text-secondary">
            {step.label}
            {step.detail !== null && (
              <span className="mt-0.5 block whitespace-pre-wrap font-mono text-text-muted">
                {step.detail}
              </span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
