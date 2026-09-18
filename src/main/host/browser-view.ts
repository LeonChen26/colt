// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 内嵌浏览器的「每会话视图记录」与调参常量——从 `browser-host.ts` 整体搬出。
 *
 * 搬移的原因与判据见 `tests/size-guard.test.ts` 的体量棘轮：`browser-host.ts` 是已知大户
 * （上限 = 建闸那天的行数，零余量），加功能必须同时搬走等量旧代码。这里搬的是
 * **纯声明**（常量 + 类型，没有任何行为），位置变了、行为没变；`browser-host.ts` 的
 * 类逻辑原样留在原地。
 */
import type { Rectangle, WebContentsView } from "electron";
import type { CaptureBuffer } from "./browser-observe";

/** 单次页面加载上限 */
export const NAV_TIMEOUT_MS = 30_000;
/** did-fail-load 的 ERR_ABORTED：多为导航被新请求取代，不算页面故障 */
export const ERR_ABORTED = -3;
/**
 * 浏览器专属 partition：持久化（persist: 前缀）以便登录态跨会话保留，
 * 同时与主应用的 defaultSession 隔离——网络/下载观测因此不必再靠 webContentsId
 * 把应用自身的流量剔除出去。
 */
export const BROWSER_PARTITION = "persist:colt-browser";
/**
 * 渲染层尚未上报矩形时的兜底视口。
 * 自动化冒烟（runFixture）直接驱动宿主、没有渲染层参与，页面仍需一个非退化视口
 * 才能让响应式重排可观测，故给一个合理的默认值。
 */
export const DEFAULT_RECT: Rectangle = { x: 0, y: 0, width: 1024, height: 768 };

/**
 * 「重新量页面内容宽度」的去抖延时。
 * 拖动分隔条时宽度逐像素变化，而每量一次都要查一次页面布局，故等手停下来再量。
 */
export const MEASURE_DEBOUNCE_MS = 300;

/**
 * 「页面还在装载、这次量不成」时的重试间隔与次数上限。
 * `did-finish-load` 触发时子资源可能还在飞（`isLoading()` 仍为 true），只量一次会**静默漏掉**，
 * 故等一小会儿再试；重试有上限，免得页面永远加载不完时留下一个常驻定时器。
 */
export const MEASURE_RETRY_MS = 500;
export const MEASURE_MAX_ATTEMPTS = 3;

/**
 * 「适应宽度」的缩放下限（可读下限）。
 *
 * 缩放能让固定宽度的页面整体塞进更窄的停靠区，但字会一起变小：最窄停靠区 219px
 * 要装下 768px 的页面得缩到 29%，12px 的字就剩 3.5px——那时候「全都看得见」已经没有意义。
 * 所以缩到这个比例就停手，**如实告诉用户「还需拖宽右栏」**，而不是给他一屏读不了的蚂蚁字。
 */
export const MIN_FIT_ZOOM = 0.6;

export interface SessionBrowser {
  view: WebContentsView;
  /** 控制台与网络观测缓冲，导航时清空 */
  capture: CaptureBuffer;
  /** 渲染层上报的页面区域；null 表示尚未上报（用兜底矩形） */
  bounds: Rectangle | null;
  /**
   * 渲染层明确表示「当前不可见」（切到了别的页签 / 会话切走）。
   * 注意不能用 bounds === null 表达隐藏：自动化冒烟没有渲染层参与、
   * 视图从未被上报过，此时必须保持可见，否则 setBounds 不生效、响应式重排无从观测。
   */
  hidden: boolean;
  /** viewport 动作的临时覆盖尺寸（响应式联调用），null 表示未覆盖 */
  viewport: { width: number; height: number } | null;
  /** 页面够不到的内容宽度（0 = 没有；口径见 browser-scripts.ts 的 CONTENT_WIDTH_SCRIPT），报给界面用于提示 */
  contentWidth: number;
  /** 当前缩放比例（1 = 100%），「适应宽度」生效时小于 1；见 setZoom */
  zoom: number;
  /** 用户是否开着「适应宽度」（**意图**，跨导航保留：换一页仍按它决定要不要缩） */
  fit: boolean;
  /** 上一次摆放用的宽度：宽度一变页面就重排，「够不够看」要重新量 */
  appliedWidth: number;
  /** 去抖用的重测定时器（拖分隔条时每像素都会走到 #applyBounds） */
  measureTimer?: NodeJS.Timeout;
}
