// Copyright (c) 2026 Colt
// SPDX-License-Identifier: MIT

/**
 * 右栏宽度（规则 ⑦-B）：**只由用户拖拽决定**，含持久化（F5）。
 *
 * 宽度语义是**全局统一值**（v1.24 定调，不随页签、不随会话变），而 Conversation 以
 * key=sessionId 重挂载——存在它的 state 里切一次会话就丢。故初值从 localStorage 读、
 * 拖拽落定（mouseup）与双击复位时写回。这组逻辑整组抽出（体量闸要求的机械搬迁）：
 * 状态、量宽、拖拽跟随、复位全在这里，组件只消费 `{ dockWidth, dockDragging, ... }`。
 *
 * 位移计算见 AGENTS.md 3.3：只对「位移」取负、宽度本身恒正；拖拽起点把「当前宽度」
 * 和「指针位置」刻意分开存，别把两个量揉进一个数里。
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { clampDockWidth, dockWidthFromDrag } from "@/lib/dock";
import { loadDockWidth, saveDockWidth } from "@/lib/dock-persist";
import { DOCK_COLLAPSED_WIDTH, DOCK_DEFAULT_WIDTH } from "./WorkspaceDock";

export interface DockWidth {
  /** 当前生效的右栏宽度（折叠态为图标条宽度；展开态为 用户值/默认值 经可用空间钳制） */
  dockWidth: number;
  /** 是否正在拖拽把手（驱动光标与选中抑制） */
  dockDragging: boolean;
  /** 把手按下：记录拖拽起点 */
  onDockGripDown: (event: React.MouseEvent<HTMLDivElement>) => void;
  /** 双击把手：丢弃用户宽度（含持久化值），回到统一默认宽度 */
  resetDockWidth: () => void;
}

export function useDockWidth(
  rootRef: React.RefObject<HTMLDivElement | null>,
  dockCollapsed: boolean,
): DockWidth {
  /** 右栏可用宽度：用于把宽度钳制到不挤压中栏（⑦-B 中栏下限 360px） */
  const [dockSpace, setDockSpace] = useState(0);
  /**
   * 用户拖拽后的右栏宽度；null = 尚未拖过（此时才用视图建议值，规则 ⑦-B）。
   * 初值从 localStorage 读：宽度是全局值，组件重挂载（切会话）不能丢。
   */
  const [dockWidthUser, setDockWidthUserState] = useState<number | null>(() => loadDockWidth());
  /** 是否正在拖拽右栏把手（用于驱动光标与选中抑制） */
  const [dockDragging, setDockDragging] = useState(false);
  /**
   * 拖拽起点。startX 是按下时的指针横坐标，startWidth 是按下时的**实际**右栏宽度。
   * 两者刻意分开存——别把「当前宽度」和「位移」揉进一个数里（AGENTS.md 3.3 的翻车点）。
   */
  const dockDragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  /** 当前生效的右栏宽度，供拖拽开始时取起点，避免闭包读到旧值 */
  const dockWidthRef = useRef(0);
  /** 本次拖拽最近一次 mousemove 的落点：mouseup 时持久化取它（ref 里的生效宽度可能滞后一帧） */
  const dockDragLatestRef = useRef<number | null>(null);

  /**
   * 生效宽度：折叠态优先（固定图标条宽度，用户拖拽值保留，展开时恢复）；
   * 没有拖拽时用**统一默认宽度**——不按页签取建议值，否则切页签就会改宽度、
   * 中栏跟着重排。一旦拖过，用户值优先，其余一律不覆盖它。
   * 无论来源如何，都按当前可用空间钳制，保证中栏不被挤到 360px 以下、右栏也不越界。
   */
  const dockWidth = useMemo(() => {
    if (dockCollapsed) return DOCK_COLLAPSED_WIDTH;
    return clampDockWidth(dockWidthUser ?? DOCK_DEFAULT_WIDTH, dockSpace);
  }, [dockCollapsed, dockWidthUser, dockSpace]);

  useLayoutEffect(() => {
    dockWidthRef.current = dockWidth;
  }, [dockWidth]);

  // 量工作区可用宽度，用于把右栏宽度钳制到不挤压中栏
  useLayoutEffect(() => {
    const node = rootRef.current;
    if (node === null) return;
    const measure = (): void => setDockSpace(node.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [rootRef]);

  const onDockGripDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dockDragRef.current = { startX: event.clientX, startWidth: dockWidthRef.current };
    setDockDragging(true);
  }, []);

  const resetDockWidth = useCallback(() => {
    setDockWidthUserState(null);
    saveDockWidth(null);
  }, []);

  // 拖拽期间在 window 上跟随指针：把手指移出把手（甚至出窗口）也不会丢事件（原型同款做法）。
  useLayoutEffect(() => {
    if (!dockDragging) return;
    const onMove = (event: MouseEvent): void => {
      const start = dockDragRef.current;
      if (start === null) return;
      // 位移→宽度、以及钳制，都是 `lib/dock.ts` 里的纯函数（AGENTS.md §3.3 那次翻车的位置）。
      // 这里读 rootRef 而不是 `dockSpace` state：拖拽期间要的是**当下**的可用宽度，
      // 等 state 回流会晚一帧、出现可感知的滞后。
      const next = dockWidthFromDrag(start.startWidth, start.startX, event.clientX);
      const clamped = clampDockWidth(next, rootRef.current?.clientWidth ?? 0);
      dockDragLatestRef.current = clamped;
      setDockWidthUserState(clamped);
    };
    const onUp = (): void => {
      setDockDragging(false);
      // 拖拽落定才持久化：mousemove 期间只动 state，不把每帧写进存储。
      // 落点取专用 ref——dockWidthRef 经 useEffect 回流，可能滞后一帧。
      if (dockDragLatestRef.current !== null) {
        saveDockWidth(dockDragLatestRef.current);
        dockDragLatestRef.current = null;
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.classList.add("resizing");
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("resizing");
    };
  }, [dockDragging, rootRef]);

  return { dockWidth, dockDragging, onDockGripDown, resetDockWidth };
}
