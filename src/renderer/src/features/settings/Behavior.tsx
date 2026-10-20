// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 「行为」三屏：审批 / 写后诊断 / 上下文压缩。
 *
 * 三者都是**全局**设置、都是单一取值，所以整屏就是若干「行」，没有资源卡。
 * 设计依据 `docs/ui-settings-redesign-2026-10.md` §6.2–6.4。
 *
 * 统一生效方式（同稿 §八 P2）：**没有「保存」按钮**。开关即时下发、数值失焦提交、
 * 白名单增删即落盘。这是为了让同一页只有一套心智——现状五种（即时 / 失焦 / 卡片内保存 /
 * textarea + 恒显示保存 / 乐观更新），用户无法建立预期。
 */
import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_COMPACTION_CONFIG,
  COMPACTION_TOKENS_MAX,
  COMPACTION_TOKENS_MIN,
  describeCompaction,
  type CompactionConfig,
} from "@shared/compaction-config";
import { Details, PanelHead, Row, RowGroup, Switch, TokenInput } from "./parts";

/**
 * 审批：分析器自动放行的命令白名单。
 *
 * **没有独立的开关**：白名单为空就等于关闭自动放行（`protocol.ts` 的
 * `approval.analyzeConfig.set` 注释写明「传空列表即关闭分析器自动放行」）。所以这里
 * 不造一个开关——那会让「关掉」与「清空列表」变成两份状态，谁先谁后说不清。
 */
export function ApprovalPanel({
  onSaved,
  onError,
}: {
  onSaved: (message: string) => void;
  onError: (error: unknown) => void;
}): React.JSX.Element {
  const [commands, setCommands] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const { commands: stored } = await window.colt.invoke(
          "approval.analyzeConfig.get",
          undefined,
        );
        setCommands(stored);
      } catch (e) {
        onError(e);
      } finally {
        setLoading(false);
      }
    })();
  }, [onError]);

  const commit = useCallback(
    async (next: string[]): Promise<void> => {
      try {
        // 回值才是生效值（主进程会过滤 / 归一化），不能拿本地草稿当结果
        const saved = await window.colt.invoke("approval.analyzeConfig.set", { commands: next });
        setCommands(saved.commands);
        onSaved(saved.commands.length === 0 ? "白名单已清空，自动放行已关闭" : "白名单已更新");
      } catch (e) {
        onError(e);
      }
    },
    [onSaved, onError],
  );

  return (
    <div>
      <PanelHead
        title="审批"
        scope="全局"
        lede="自动审批模式下：只读命令直接放行；首词在这张清单里的命令交给模型复核后自动执行；其余操作一律弹窗确认。"
      />
      <div className="mt-3">
        <RowGroup>
          <Row
            label="可自动放行的命令"
            hint={
              loading
                ? "读取中…"
                : commands.length === 0
                  ? "留空 = 关闭自动放行，全部转人工。回车或空格添加一项。"
                  : "回车或空格添加一项；匹配的是首词。"
            }
          >
            <span className="text-2xs text-text-muted">{commands.length} 项</span>
          </Row>
        </RowGroup>
        <div className="mt-2">
          <TokenInput
            value={commands}
            disabled={loading}
            ariaLabel="可自动放行的命令"
            placeholder="npm"
            onChange={setCommands}
            onCommit={(next) => void commit(next)}
          />
        </div>
      </div>
      <p className="mt-2 max-w-[600px] text-2xs leading-relaxed text-text-muted">
        这里只按命令的<strong>首词</strong>匹配：填{" "}
        <span className="font-mono">git</span> 会放行它的所有子命令，填{" "}
        <span className="font-mono">git push</span> 则永远不会命中。
      </p>
    </div>
  );
}

/**
 * 写后诊断开关（`docs/archive/DESIGN-afterwrite.md` D5，全局设置）。
 *
 * 助手每次写完代码文件会自动跑项目检查（eslint / tsc / ruff / go vet / cargo check），
 * 结论直接跟在写入结果里。检查慢或输出吵的项目可以整体关掉。
 */
export function DiagnosePanel({
  onSaved,
  onError,
}: {
  onSaved: (message: string) => void;
  onError: (error: unknown) => void;
}): React.JSX.Element {
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const { enabled: current } = await window.colt.invoke("diagnose.config.get", undefined);
        setEnabled(current);
      } catch (e) {
        onError(e);
      } finally {
        setLoading(false);
      }
    })();
  }, [onError]);

  const toggle = async (): Promise<void> => {
    const next = !enabled;
    setEnabled(next); // 乐观更新；失败回滚
    try {
      const saved = await window.colt.invoke("diagnose.config.set", { enabled: next });
      setEnabled(saved.enabled);
      onSaved(saved.enabled ? "写后诊断已开启" : "写后诊断已关闭");
    } catch (e) {
      setEnabled(enabled);
      onError(e);
    }
  };

  return (
    <div>
      <PanelHead
        title="写后诊断"
        scope="全局"
        lede="每写完一个代码文件，自动运行该项目对应的检查，结论直接跟在写入结果里。"
      />
      <div className="mt-3">
        <RowGroup>
          <Row
            label="写完文件后自动运行项目检查"
            hint="默认关闭。开启后会在后台运行项目检查，不阻塞回复。"
          >
            <Switch
              checked={enabled}
              disabled={loading}
              label="写完文件后自动运行项目检查"
              onToggle={() => void toggle()}
            />
          </Row>
        </RowGroup>
        <div className="mt-2">
          <Details summary="它会跑什么">
            <div className="flex flex-col gap-1">
              <span className="font-mono text-text-secondary">.ts / .tsx → tsc + eslint</span>
              <span className="font-mono text-text-secondary">.go → go vet</span>
              <span className="font-mono text-text-secondary">.rs → cargo check</span>
              <span className="mt-1">
                只在项目里存在对应配置时运行；跑不起来就跳过，不会报成错误。
              </span>
            </div>
          </Details>
        </div>
      </div>
    </div>
  );
}

/**
 * 电脑控制开关（实验能力，全局）。
 *
 * 默认关。默认不注册 `computer_screenshot` / `computer_action`——它们仅 Windows 实现、
 * 每个动作 spawn 一次 PowerShell，走 OS 级鼠标键盘注入，而浏览器面板的「接管」
 * 只拦 `browser_act`、拦不住 OS 级点击。
 *
 * **生效时机与写后诊断不同**：工具清单在会话创建时确定，故这里改完要**重新打开会话**才生效。
 */
export function ComputerPanel({
  onSaved,
  onError,
}: {
  onSaved: (message: string) => void;
  onError: (error: unknown) => void;
}): React.JSX.Element {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const { enabled: current } = await window.colt.invoke("computer.config.get", undefined);
        setEnabled(current);
      } catch (e) {
        onError(e);
      } finally {
        setLoading(false);
      }
    })();
  }, [onError]);

  const toggle = async (): Promise<void> => {
    const next = !enabled;
    setEnabled(next); // 乐观更新；失败回滚
    try {
      const saved = await window.colt.invoke("computer.config.set", { enabled: next });
      setEnabled(saved.enabled);
      onSaved(saved.enabled ? "电脑控制已开启（重新打开会话后生效）" : "电脑控制已关闭（重新打开会话后生效）");
    } catch (e) {
      setEnabled(enabled);
      onError(e);
    }
  };

  return (
    <div>
      <PanelHead
        title="电脑控制"
        scope="全局"
        lede="让助手截取整个屏幕、用鼠标键盘操作桌面应用。实验能力，默认关闭。"
      />
      <div className="mt-3">
        <RowGroup>
          <Row
            label="启用电脑控制"
            hint="默认关闭。仅 Windows；开启后需重新打开会话才生效。"
          >
            <Switch
              checked={enabled}
              disabled={loading}
              label="启用电脑控制"
              onToggle={() => void toggle()}
            />
          </Row>
        </RowGroup>
        <div className="mt-2">
          <Details summary="它会上报哪些工具">
            <div className="flex flex-col gap-1">
              <span className="font-mono text-text-secondary">computer_screenshot → 截取整屏（含隐私，需确认）</span>
              <span className="font-mono text-text-secondary">computer_action → 点击 / 输入 / 按键（最高风险，每次确认）</span>
              <span className="mt-1">
                关闭时这两个工具不注册：模型看不到它们，也就不存在「点了没反应」的入口。
              </span>
            </div>
          </Details>
        </div>
      </div>
    </div>
  );
}

/**
 * 自动压缩（上下文管理）的设置，全局。
 *
 * 修的是「**看不见也调不了**」：自动压缩一直开着（吃内核默认值），但应用层对此零感知——
 * 阈值不可见、不可调，界面只能在压缩触发时靠 `runningOperation` 猜。这里把当前生效值
 * 摆出来，并说明它意味着什么。
 *
 * 「跟随默认」这个状态要**单独说**：用户想知道的是「这是我设的、还是内核默认」，
 * 光报三个数字答不了这个问题。改完即时下发（不必重启会话，也不等下次压缩）。
 */
export function CompactionPanel({
  onSaved,
  onError,
}: {
  onSaved: (message: string) => void;
  onError: (error: unknown) => void;
}): React.JSX.Element {
  const [config, setConfig] = useState<CompactionConfig>(DEFAULT_COMPACTION_CONFIG);
  const [isDefault, setIsDefault] = useState(true);
  const [loading, setLoading] = useState(true);
  // 两个阈值用**文本**存草稿：直接绑数字的话，输入框清空时会被 parse 成 NaN，
  // 用户没法把「16384」改成「8000」（删到一半就跳回去了）。
  const [draft, setDraft] = useState({ reserveTokens: "", keepRecentTokens: "" });

  useEffect(() => {
    void (async () => {
      try {
        const saved = await window.colt.invoke("compaction.config.get", undefined);
        setConfig(saved.config);
        setIsDefault(saved.isDefault);
        setDraft({
          reserveTokens: String(saved.config.reserveTokens),
          keepRecentTokens: String(saved.config.keepRecentTokens),
        });
      } catch (e) {
        onError(e);
      } finally {
        setLoading(false);
      }
    })();
  }, [onError]);

  /**
   * 把两个阈值输入框的内容同步回**服务端确认的生效值**。
   *
   * 输入框与「生效值」是两份状态，不主动对齐就会出现「框里写着 999999，下面那行说明
   * 还是 16384」这种自相矛盾的画面——而这份界面存在的全部意义就是让生效值可见。
   * 所以保存成功后被主进程钳制过的值要回填，**保存失败时也要回填**（失败时更是不能留着
   * 用户那份没生效的文本）。
   */
  const syncDraft = (from: CompactionConfig): void => {
    setDraft({
      reserveTokens: String(from.reserveTokens),
      keepRecentTokens: String(from.keepRecentTokens),
    });
  };

  const save = async (next: CompactionConfig): Promise<void> => {
    try {
      // 回值才是**真实生效值**（主进程会钳制越界输入），不能拿本地草稿当结果
      const saved = await window.colt.invoke("compaction.config.set", { config: next });
      setConfig(saved.config);
      setIsDefault(saved.isDefault);
      syncDraft(saved.config);
      onSaved(describeCompaction(saved.config));
    } catch (e) {
      // 失败 → 输入框回到**仍然生效**的那份值，别让用户以为改成功了
      syncDraft(config);
      onError(e);
    }
  };

  /** 阈值失焦时提交：与开关一样走同一条保存路径，输入非法时由主进程钳制后回填 */
  const commitTokens = (): void => {
    const parsedReserve = Number.parseInt(draft.reserveTokens, 10);
    const parsedKeep = Number.parseInt(draft.keepRecentTokens, 10);
    void save({
      enabled: config.enabled,
      reserveTokens: Number.isFinite(parsedReserve) ? parsedReserve : config.reserveTokens,
      keepRecentTokens: Number.isFinite(parsedKeep) ? parsedKeep : config.keepRecentTokens,
      backgroundTokens: config.backgroundTokens,
    });
  };

  const tokensInput = (
    key: "reserveTokens" | "keepRecentTokens"
  ): React.JSX.Element => (
    <input
      type="text"
      inputMode="numeric"
      value={draft[key]}
      disabled={loading}
      onChange={(event) => setDraft((previous) => ({ ...previous, [key]: event.target.value }))}
      onBlur={commitTokens}
      className="w-[84px] rounded-sm border border-line bg-surface-input px-2 py-1 text-right font-mono text-xs text-text-primary outline-none transition focus:border-accent"
    />
  );

  return (
    <div>
      <PanelHead
        title="上下文压缩"
        scope="全局"
        lede="对话变长时，把较早的内容摘要成一段再发给模型——发给模型的上下文只保留最近的原话，界面里的历史仍然完整。摘要保大意、不保细节，重要结论建议写进记忆文件。"
      />
      <div className="mt-3">
        <RowGroup>
          <Row
            label="上下文攒满时自动压缩"
            hint="手动 /compact 不受这个开关约束。"
          >
            <Switch
              checked={config.enabled}
              disabled={loading}
              label="上下文攒满时自动压缩"
              onToggle={() => void save({ ...config, enabled: !config.enabled })}
            />
          </Row>
          {config.enabled && (
            <>
              <Row
                label="压缩后保留最近"
                hint="保留这么多 token 的原话，更早的压成摘要。越大越不容易丢细节，也越快再次触发。"
              >
                {tokensInput("keepRecentTokens")}
                <span className="text-2xs text-text-muted">token</span>
              </Row>
              <Row label="为摘要预留" hint="留给摘要请求本身的预算（提示词 + 输出）。">
                {tokensInput("reserveTokens")}
                <span className="text-2xs text-text-muted">token</span>
              </Row>
            </>
          )}
        </RowGroup>
        <div className="mt-2 flex items-start justify-between gap-3">
          {/* 生效值单列：它报的是**服务端钳制后的真实值**，与「我填了什么」是两件事 */}
          <p className="text-2xs leading-[1.55] text-text-muted">
            {describeCompaction(config)}
            <span className="ml-1">
              {isDefault ? "· 跟随默认" : "· 已自定义"}
            </span>
          </p>
          {!isDefault && (
            <button
              type="button"
              onClick={() =>
                void save({
                  enabled: DEFAULT_COMPACTION_CONFIG.enabled,
                  reserveTokens: DEFAULT_COMPACTION_CONFIG.reserveTokens,
                  keepRecentTokens: DEFAULT_COMPACTION_CONFIG.keepRecentTokens,
                  backgroundTokens: DEFAULT_COMPACTION_CONFIG.backgroundTokens,
                })
              }
              className="shrink-0 rounded-sm border border-line px-2 py-0.5 text-2xs text-text-muted transition hover:text-text-primary"
            >
              恢复默认
            </button>
          )}
        </div>
        <p className="mt-1 text-2xs text-text-muted">
          合法区间 {COMPACTION_TOKENS_MIN} – {COMPACTION_TOKENS_MAX}：超出范围会自动改成最接近的合法值。
        </p>
      </div>
    </div>
  );
}
