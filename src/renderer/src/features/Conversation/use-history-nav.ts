/**
 * 会话导航（目录 / 搜索浮层）的状态：面板开合、跳到某一轮、「回到底部」的重放信号。
 *
 * 抽成 hook 而不是摊在 `Conversation/index.tsx` 里，两个具体理由：
 * ① 那个文件是**体量棘轮**盯着的（`tests/size-guard.test.ts`），往里加东西就得同时搬走等量旧代码；
 * ② 「换会话要清掉跳转请求」这条纪律只写在一个地方才不会漏。漏了的症状很隐蔽：
 *    切到新会话会照着**上一份视图的下标**立刻跳一下——在新会话里那是随机一条消息，
 *    看起来像「会话自己乱滚」，跟跳转请求八竿子打不着。
 */
import { useCallback, useEffect, useRef, useState } from "react";

export type JumpRequest = { index: number; nonce: number };

export type HistoryNav = {
  open: boolean;
  toggle: () => void;
  close: () => void;
  /** 待处理的跳转请求；`null` = 没有 */
  jump: JumpRequest | null;
  jumpTo: (index: number) => void;
  /** 每次自增表示「回到底部」被按了一次 */
  followNonce: number;
  bumpFollow: () => void;
};

export function useHistoryNav(sessionId: string): HistoryNav {
  const [open, setOpen] = useState(false);
  const [jump, setJump] = useState<JumpRequest | null>(null);
  const [followNonce, setFollowNonce] = useState(0);
  const nonce = useRef(0);

  useEffect(() => {
    setJump(null);
    setOpen(false);
  }, [sessionId]);

  const jumpTo = useCallback((index: number): void => {
    nonce.current += 1;
    setJump({ index, nonce: nonce.current });
    // 点完就收起来：浮层压着正文，而用户接下来要看的是那一轮本身
    setOpen(false);
  }, []);

  return {
    open,
    toggle: useCallback(() => setOpen((value) => !value), []),
    close: useCallback(() => setOpen(false), []),
    jump,
    jumpTo,
    followNonce,
    bumpFollow: useCallback(() => setFollowNonce((value) => value + 1), []),
  };
}
