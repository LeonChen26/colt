// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 写后诊断的编排入口（docs/archive/DESIGN-afterwrite.md）——`entry.ts` 只 import 这一个门面。
 *
 * 职责：after_tool 里识别「写成功的 write/edit」→ 生成诊断计划 → fast 同步执行并把
 * 结论**追加进当次工具结果**（模型当轮就能修）→ slow 交给防抖器，批结果经
 * `onSlowResult`（entry 的 ephemeral notice 队列）注入下一请求。
 *
 * 安全边界（D2，用户已拍板「免审批、窄通道」）：命令全部来自检查器表，
 * 模型唯一输入是 path（刚被审批闸门放行的写入用过）；审批闸门看不见 after_tool
 * 内部行为，这条通道的正当性论证在 `docs/SECURITY.md` §写后诊断。
 */
import { isAbsolute, resolve } from "node:path";
import type { Context } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  planDiagnose,
  slowMarkerFor,
  type DiagnoseCheck,
} from "./diagnose-config";
import {
  SlowDiagnoseDebouncer,
  execCheck,
  markerProbe,
  type DiagnoseOutcome,
  type ExecFn,
} from "./diagnose-run";
import { formatDiagnoseSection, formatSlowNotice } from "./diagnose-format";

/** after_tool 事件里本模块消费的字段（内核事件的结构化收窄） */
export interface AfterToolSlice {
  readonly toolName: string;
  readonly isError: boolean;
  readonly args: Record<string, unknown>;
  readonly content: readonly (TextContent | ImageContent)[];
}

export interface DiagnoseController {
  /** 设置开关（D5）：关掉即停表并丢弃待跑批次；再打开自动恢复（调度随写入重建） */
  setEnabled(enabled: boolean): void;
  /** after_tool 处理器；返回 undefined 表示不干预工具结果 */
  handleAfterTool(
    event: AfterToolSlice,
  ): Promise<{ content: (TextContent | ImageContent)[] } | undefined>;
  dispose(): void;
}

export function createDiagnoseController(options: {
  cwd: string;
  exec: ExecFn;
  context: Context;
  /** slow 批次有值得说的事（有问题 / 跳过）时回调；干净批次不打扰 */
  onSlowResult: (notice: string) => void;
  /** 前置标记探测（相对项目根）；缺省用真盘 existsSync——测试注入假探测 */
  probe?: (marker: string) => boolean;
  /** 慢检查防抖间隔；生产用默认（diagnose-config 的 SLOW_DEBOUNCE_MS），测试注入小值 */
  debounceMs?: number;
}): DiagnoseController {
  const { cwd, exec, context, onSlowResult } = options;
  let enabled = true;

  const probe = options.probe ?? markerProbe(cwd);
  const existsProbeFor = (check: DiagnoseCheck) => () =>
    slowMarkerFor(check).every((marker) => probe(marker));

  // slow 批次的结果收集：防抖器按批回调，这里按批累积、批尾统一上报
  let batchOutcomes: DiagnoseOutcome[] = [];
  const debouncer = new SlowDiagnoseDebouncer(
    async (batch) => {
      batchOutcomes = [];
      for (const { check, existsProbe } of batch) {
        // 执行时刻再探一次标记：窗口内项目形态可能已变
        if (!existsProbe()) continue;
        batchOutcomes.push(await execCheck(exec, cwd, context, check, check.command));
      }
      const notice = formatSlowNotice(batchOutcomes);
      // 没问题不打扰：slow 的价值是「出事了告诉你」，全绿保持安静
      if (notice !== "") onSlowResult(notice);
    },
    options.debounceMs,
  );

  return {
    setEnabled(value: boolean): void {
      enabled = value;
      if (!value) debouncer.dispose();
    },

    async handleAfterTool(
      event,
    ): Promise<{ content: (TextContent | ImageContent)[] } | undefined> {
      if (!enabled) return undefined;
      if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
      // 写失败（审批被拒 / 越界 / 内核报错）不诊断：没有成功落盘的内容可查，
      // 往失败结果上追加诊断只会混淆「写失败」与「写出来的东西有问题」（D1）
      if (event.isError) return undefined;
      const rawPath = event.args.path;
      if (typeof rawPath !== "string" || rawPath.length === 0) return undefined;
      // 与 lib/baseline.ts 同一条路径归一口径（入参实测常为绝对路径）
      const absolutePath = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);

      const plan = planDiagnose(absolutePath, probe);
      if (plan.fast.length === 0 && plan.slow.length === 0) return undefined;

      // fast：同步执行，结论追加进当次结果
      const fastOutcomes: DiagnoseOutcome[] = [];
      for (const { check, command } of plan.fast) {
        fastOutcomes.push(await execCheck(exec, cwd, context, check, command));
      }
      const section = formatDiagnoseSection(fastOutcomes);

      // slow：进防抖窗口（标签去重），窗口静默后作为一批跑
      for (const check of plan.slow) {
        debouncer.schedule(check, existsProbeFor(check));
      }

      if (section === "") return undefined;
      const appended: TextContent = { type: "text", text: section };
      return { content: [...event.content, appended] };
    },

    dispose(): void {
      debouncer.dispose();
    },
  };
}
