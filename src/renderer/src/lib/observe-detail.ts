/**
 * 观测抽屉的「条目详情」：把一条 console / network / download 记录摊成**字段表**。
 *
 * 为什么要有它：抽屉里的行是**概览**——一行一条、该截的截（网络 URL、下载路径都只能靠原生
 * tooltip 兜底）。而用户点开这一屏最常问的恰恰是「**刚才那个 401 到底是谁**」，
 * 那需要完整的方法 / URL / 状态码 / 绝对路径，一行装不下。
 *
 * 抽成纯函数的两个理由：
 *   1. 字段映射是「记录 → 展示」的翻译，最容易写错（漏字段、空值留下空行），值得单测；
 *   2. 复制按钮要的是**同一套**字段的文本化，两处若各写一遍就会漂。
 *
 * 刻意的取舍：**空值不出行**（失败的请求没有状态码、根目录的日志没有来源），
 * 于是详情段永不出现「状态：（空）」这种要用户自己判断的灰条。
 */
import type { ConsoleEntry, DownloadEntry, NetworkEntry } from "@shared/protocol";
import { formatBytes } from "./format";

export type ObsTab = "console" | "network" | "downloads";

export interface ObsField {
  label: string;
  value: string;
  /** 地址 / 路径 / 代码这类值用等宽字体：长度和形状一眼能对上，也便于横向比对 */
  mono: boolean;
}

/** 空的字段直接丢掉——详情段里不留空行（见文件头「刻意的取舍」） */
function field(label: string, value: string, mono = false): ObsField | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : { label, value: trimmed, mono };
}

function compact(fields: (ObsField | null)[]): ObsField[] {
  return fields.filter((item): item is ObsField => item !== null);
}

/** 控制台一条：级别 / 完整消息 / **完整来源**（概览里只有文件名） / 行号 */
export function consoleFields(entry: ConsoleEntry): ObsField[] {
  return compact([
    field("级别", entry.level),
    field("消息", entry.message),
    field("来源", entry.source, true),
    entry.line > 0 ? field("行", String(entry.line), true) : null,
  ]);
}

/** 网络一条：方法 / 状态码或错误 / 资源类型 / **完整 URL** */
export function networkFields(entry: NetworkEntry): ObsField[] {
  return compact([
    field("方法", entry.method, true),
    entry.statusCode !== undefined ? field("状态码", String(entry.statusCode), true) : null,
    field("错误", entry.error ?? ""),
    field("类型", entry.resourceType),
    field("URL", entry.url, true),
  ]);
}

/** 下载一条：文件名 / **绝对路径** / 来源 URL / 大小 / 状态 / 备注 */
export function downloadFields(entry: DownloadEntry): ObsField[] {
  return compact([
    field("文件", entry.filename, true),
    field("路径", entry.path, true),
    field("来源", entry.url, true),
    field("大小", formatBytes(entry.bytes)),
    field("状态", entry.state),
    field("备注", entry.note ?? ""),
  ]);
}

/**
 * 把字段表拍成可粘贴的多行文本（`标签：值`）。
 * 粘给模型问「这个请求为什么失败」时，一段完整的上下文比让模型猜有用得多。
 */
export function observeCopyText(fields: ObsField[]): string {
  return fields.map((item) => `${item.label}：${item.value}`).join("\n");
}

/**
 * 展开状态的键：**行签名**，不是下标。
 *
 * 抽屉每秒轮询一次，缓冲区会追加新条目、到头了还会从头裁掉——按下标记位置的话，
 * 展开的那一栏会**跳到别的行**上去（用户会以为点错了）。签名相同的行本就是同一件事，
 * 一起展开反而正确。
 */
export function consoleRowKey(entry: ConsoleEntry): string {
  return `console:${entry.level}|${entry.message}|${entry.source}|${entry.line}`;
}

export function networkRowKey(entry: NetworkEntry): string {
  return `network:${entry.method}|${entry.url}|${entry.statusCode ?? ""}|${entry.error ?? ""}`;
}

export function downloadRowKey(entry: DownloadEntry): string {
  return `downloads:${entry.filename}|${entry.path}`;
}
