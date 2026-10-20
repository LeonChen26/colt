// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 技能（Agent Skills，agentskills.io 标准）：本会话装载到的技能清单。
 *
 * `live` 是关键区分：会话开着时展示的是 worker 报的**真实清单**；没开着就只能看到引导——
 * 绝不能说成「一个技能都没装」，那是反话（同 `McpServerView` 的注记）。
 *
 * 技能是**跨会话**的配置（项目级随仓库分发、用户级全局生效），故归设置页，与 MCP 一致。
 * 每个技能**如实标出处**：项目级会随仓库分发、进系统提示词、影响模型行为——用户有权知道来源。
 */
import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Sparkles } from "lucide-react";
import { ICON } from "@/lib/icon";
import type { Project, SkillsStatus } from "@shared/protocol";
import type { ViewSkillDetail } from "@shared/worker-protocol";
import { contentStats } from "../../lib/format";
import { cn } from "@/lib/utils";
import { errorSummary } from "../../lib/error-text";
import { Chip, Notice, PanelHead, Switch } from "./parts";

const BTN =
  "rounded-sm border border-line px-2 py-0.5 text-2xs text-text-secondary transition hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40";

export function SkillsPanel({
  project,
  onSaved,
}: {
  project: Project | null;
  /** 成功后的统一提示（设置页顶层那条 2.5s 提示条）：开/关技能原本是静默的，
   *  用户点完开关只看到样式变了，分不清「真的写盘了」还是「只是 UI 翻了一下」 */
  onSaved?: (text: string) => void;
}): React.JSX.Element {
  const [status, setStatus] = useState<SkillsStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [rescanning, setRescanning] = useState(false);
  /**
   * 正在切换的那个技能名：只用来把开关锁一下，防连点。
   *
   * 为什么按**名字**而不是一个全局 `boolean`：`skills.setDisabled` 要做「写盘 + 重新装载」，
   * 慢的一步在 worker；期间整份现状都还没回来，用全局 busy 会把所有开关一起灰掉。
   */
  const [busyName, setBusyName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * **动作级**失败（重新扫描 / 开关 / 在文件管理器中显示）。
   *
   * 为什么与 `error` 分开：`error` 那一格在渲染里会**顶掉整份清单**（那是「现状不可信」的语义）。
   * 而这三件事失败并不代表现状不可信——尤其「在文件管理器中显示」遇到「文件已不在」是**预期会
   * 发生**的，用它去替换整块列表，用户就再也看不到技能、只能靠重扫捞回来。所以动作失败单独一格，
   * 渲染在清单**上方**。
   */
  const [actionError, setActionError] = useState<string | null>(null);
  const projectId = project?.id;

  const load = useCallback(async () => {
    if (projectId === undefined) {
      setStatus(null);
      setActionError(null);
      return;
    }
    setLoading(true);
    try {
      setStatus(await window.colt.invoke("skills.status", { projectId }));
      setError(null);
      setActionError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const rescan = async (): Promise<void> => {
    if (projectId === undefined) return;
    setRescanning(true);
    try {
      setStatus(await window.colt.invoke("skills.rescan", { projectId }));
      setError(null);
      setActionError(null);
      onSaved?.("已重新扫描技能");
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setRescanning(false);
    }
  };

  const skills = status?.skills ?? [];
  const projectSkills = skills.filter((skill) => skill.source === "project").length;

  /**
   * 禁用 / 启用某个技能。落盘在 worker（`.colt/skills.json`），这里只把返回的新现状换上——
   * 状态**以 worker 回的那份为准**，不本地猜：那份才是模型真正会收到的东西。
   */
  const setDisabled = async (name: string, disabled: boolean): Promise<void> => {
    if (projectId === undefined) return;
    setBusyName(name);
    try {
      setStatus(await window.colt.invoke("skills.setDisabled", { projectId, name, disabled }));
      setError(null);
      setActionError(null);
      onSaved?.(`已${disabled ? "停用" : "启用"}「${name}」`);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyName(null);
    }
  };

  /** 在文件管理器里揭开技能文件所在目录（**不做删除**：删不删由用户自己决定） */
  const reveal = async (filePath: string): Promise<void> => {
    try {
      const result = await window.colt.invoke("skills.reveal", { filePath });
      setActionError(result.ok ? null : (result.reason ?? "定位失败。"));
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div>
      <PanelHead
        title="技能"
        scope="本项目 + 用户级 / 内置"
        scopeTone="project"
        action={
          <button
            type="button"
            data-skill-rescan=""
            onClick={() => void rescan()}
            disabled={projectId === undefined || rescanning}
            className={BTN}
          >
            {rescanning ? "正在重新扫描…" : "重新扫描"}
          </button>
        }
        lede={
          <>
            在项目根的{" "}
            <span className="font-mono">{".agents/skills/<名字>/SKILL.md"}</span> 或用户级的{" "}
            <span className="font-mono">{"~/.agents/skills/<名字>/SKILL.md"}</span>{" "}
            里放技能。项目级同名覆盖用户级，内置技能排在最后；用{" "}
            <span className="font-mono">{"/skill <名字>"}</span> 调用。
          </>
        }
      />

      {status !== null && status.warnings.length > 0 && (
        <div className="mt-2">
          <Notice tone="warning">
            <span>装载告警（与「事件」页签同一记录）：</span>
            {status.warnings.map((item) => (
              <span key={item} className="mt-0.5 block">
                {item}
              </span>
            ))}
          </Notice>
        </div>
      )}

      {projectSkills > 0 && (
        <div className="mt-2">
          <Notice tone="warning">
            本项目用了 {projectSkills} 个项目级技能：它们随仓库分发、会进系统提示词、影响模型行为。
            注意来源是否可信。
          </Notice>
        </div>
      )}

      {/* 动作级失败：只加一条说明，**不动清单**（见 `actionError` 的注释） */}
      {actionError !== null && (
        <div className="mt-2">
          <Notice tone="danger">{actionError}</Notice>
        </div>
      )}

      <div className="mt-3">
        {project === null ? (
          <Notice>先打开一个项目，才能看到它装载的技能。</Notice>
        ) : error !== null ? (
          <Notice tone="danger">{errorSummary(error)}</Notice>
        ) : loading ? (
          <Notice>读取中…</Notice>
        ) : status === null ? null : !status.live ? (
          // 「没开会话」不是「没装」：分开说，否则是一句反话
          <Notice>
            打开一个会话后才能查看技能；「重新扫描」也需要活会话。
          </Notice>
        ) : skills.length === 0 ? (
          <Notice>还没有装任何技能。把技能目录放进去，再点「重新扫描」。</Notice>
        ) : (
          <div className="flex flex-col gap-1.5">
            {skills.map((skill) => (
              <SkillCard
                key={`${skill.source}:${skill.name}`}
                skill={skill}
                busy={busyName === skill.name}
                onToggle={(disabled) => void setDisabled(skill.name, disabled)}
                onReveal={() => void reveal(skill.filePath)}
              />
            ))}
          </div>
        )}
      </div>

      {/* 脚注只在真有技能时出现：空清单时讲「关掉某个技能会怎样」是在解释一个不存在的对象 */}
      {skills.length > 0 && status?.live === true && (
        <p className="mt-3 max-w-[600px] text-2xs leading-relaxed text-text-muted">
          关掉某个技能 = <strong>不再装载</strong>：不进系统提示词、模型看不见，
          <span className="font-mono">/skill</span> 也会被明确拒绝；文件仍在磁盘上，随时可以开回来
          （偏好写在项目根的 <span className="font-mono">{".colt/skills.json"}</span>；
          建议把 <span className="font-mono">.colt/</span> 加入项目的 .gitignore）。
        </p>
      )}
    </div>
  );
}

/** 来源在卡片上的写法。用 Record 而不是三元链：契约再加一档时 TS 会当场报缺 key */
const SKILL_SOURCE_LABEL: Record<ViewSkillDetail["source"], string> = {
  project: "项目级",
  user: "用户级",
  builtin: "内置",
};

function SkillCard({
  skill,
  busy,
  onToggle,
  onReveal,
}: {
  skill: ViewSkillDetail;
  busy: boolean;
  onToggle: (disabled: boolean) => void;
  onReveal: () => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  /**
   * 用户级禁用的开关**必须置灰**：禁用是**并集**，用户级列的名字在项目级删不掉——
   * 开关照点也不会有任何变化，那就是「点了没反应」。所以这里不但灰掉，还要说清去哪改。
   */
  const locked = skill.disabledByUser;
  // 正文规模：只报客观数字（多少行、多少字符），不判断内容——
  // 「超过上限会被截断」那件事由上面的装载告警负责（单一真源），这里不重复。
  const { lines, chars } = contentStats(skill.content);
  return (
    <div
      data-skill={skill.name}
      data-skill-disabled={skill.disabled ? "" : undefined}
      className={cn(
        "rounded-md border border-line bg-surface-raised px-3 py-2.5",
        skill.disabled && "opacity-60",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Sparkles {...ICON.xs} className="shrink-0 text-text-muted" />
        <span className="truncate text-xs font-medium text-text-primary">{skill.name}</span>
        {/* 出处如实标：项目级随仓库分发，值得一眼看出（P5） */}
        <Chip tone={skill.source === "project" ? "project" : "plain"}>
          {SKILL_SOURCE_LABEL[skill.source]}
        </Chip>
        {!skill.modelInvocable && <Chip>仅 /skill 手动调用</Chip>}
        <span data-skill-switch={skill.name} className="ml-auto shrink-0">
          <Switch
            checked={!skill.disabled}
            disabled={busy || locked}
            label={
              locked
                ? "这条禁用来自用户级 ~/.colt/skills.json，项目里改不了"
                : skill.disabled
                  ? "启用：重新装载这个技能"
                  : "禁用：不再装载这个技能"
            }
            onToggle={() => onToggle(!skill.disabled)}
          />
        </span>
      </div>
      <div className="mt-0.5 text-2xs text-text-secondary">{skill.description}</div>
      <div className="mt-0.5 truncate font-mono text-2xs text-text-muted" title={skill.filePath}>
        {skill.filePath}
      </div>
      {locked && (
        <p className="mt-1 text-2xs text-text-muted">
          这条禁用来自用户级 <span className="font-mono">{"~/.colt/skills.json"}</span>
          ——项目配置里删不掉它（两层是并集），要开回来请改那份。
        </p>
      )}
      <div className="mt-1.5 flex items-center gap-3">
        {/*
          查看正文（P6）：技能正文会进系统提示词、改变模型行为，用户有权看到它到底是什么。
          `content` 是**全文**（未被截断）——模型那份超限会被截断并指回文件，那件事由上面的
          告警如实说明；这里给的是文件里那样，不是模型收到的样子。
        */}
        <button
          type="button"
          data-skill-toggle={skill.name}
          onClick={() => setOpen((value) => !value)}
          className="flex items-center gap-1 text-2xs text-text-muted transition hover:text-text-primary"
        >
          <ChevronRight {...ICON.xs} className={open ? "shrink-0 rotate-90" : "shrink-0"} />
          {open ? "收起正文" : "查看正文"}
        </button>
        {/* 不做删除：技能随仓库分发，删不删是用户的决定——产品只把他送到那个文件跟前 */}
        {/*
          内置技能（`source === "builtin"`）**不给这个入口**：它在 app.asar 里，既没有可打开
          的资源管理器位置，`skills.reveal` 也只收磁盘上的 `.agents/skills/<名字>/SKILL.md`——
          点了必然失败。放一个必然失败的按钮比没有它更伤信任（`AGENTS.md` §3.6 的死控件）。
          **避免的做法是收紧校验**（放开到任意路径 = 把「显示文件」变成任意路径枚举口子，
          与 `docs/SECURITY.md` §三 冲突）；内置技能是只读产物，用户对它唯一的动作就是
          「看正文 / 禁用」，所以这里直接不放。
        */}
        {skill.source !== "builtin" && (
          <button
            type="button"
            data-skill-reveal={skill.name}
            onClick={onReveal}
            className="text-2xs text-text-muted transition hover:text-text-primary"
          >
            在文件管理器中显示
          </button>
        )}
        {/* 规模如实报（P7 剩下的那半）：此前只看得到「超没超上限」，看不到它到底多大 */}
        <span data-skill-size={skill.name} className="ml-auto shrink-0 text-2xs text-text-muted">
          正文 {lines} 行 · {chars} 字符
        </span>
      </div>
      {open && (
        <pre
          data-skill-body={skill.name}
          className="mt-1.5 max-h-72 overflow-auto rounded-sm border border-line-soft bg-surface-code px-2.5 py-2 font-mono text-2xs leading-[1.65] whitespace-pre-wrap text-text-secondary"
        >
          {skill.content}
        </pre>
      )}
    </div>
  );
}
