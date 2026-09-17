/**
 * 冒烟装置的共享件：各模式（`modes/`）都要用的类型与小工具。
 *
 * 之所以单独成文件而不是留在 `index.ts`：模式跑在**主进程里**，而 `index.ts` 里的
 * `runSmoke` 负责建 `log` / `run` 这两个闭包——模式若从 `index.ts` 反向取用就会成环。
 * 把「双方都要用的东西」下沉到第三处，依赖方向才是单向的。
 */
import { nativeImage } from "electron";

/** 落盘 + 控制台双写的一行日志（由 runSmoke 建立，透传给各模式） */
export type Log = (message: string) => void;

/** 带兜底超时的 executeJavaScript（同上，由 runSmoke 建立） */
export type Run = <T>(expression: string) => Promise<T>;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 主进程里未捕获的异常。
 *
 * 有些错误是在用例之外异步抛出的（典型如窗口 closed 回调访问了已销毁的 webContents）：
 * 它不打断用例，总要等到用例记完结论之后才冒出来，把「21/21 通过」变成假绿。
 * 所以这里显式收口，由用例正文断言其为空。
 */
export const uncaughtErrors: string[] = [];

/**
 * 本次冒烟**归一化后**的产物路径（由调用方 launcher 算好，恒在 out/ 下）。
 * 用例内部需要派生伴生产物（如「待审截图」）时读它，而不是再读 COLT_SMOKE ——
 * 否则派生文件会绕过归一化，重新落回仓库根目录。
 */
// 导出的是**可变绑定**：`runSmoke` 用 setActiveOutputPath 改写后，各模式 import 进来
// 读到的就是新值（ESM 的 live binding），不需要模式侧再改写法。
export let activeOutputPath = "";

export function setActiveOutputPath(value: string): void {
  activeOutputPath = value;
}

/**
 * 生成纯红色 PNG（base64，不含 data URI 前缀）。
 * 用于验证「用户发图 → 模型看图」：颜色是确定的，模型答对即证明图片真的送达了。
 */
export function makeSolidPng(size: number): string {
  const pixels = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    pixels[i * 4] = 0; // B
    pixels[i * 4 + 1] = 0; // G
    pixels[i * 4 + 2] = 255; // R
    pixels[i * 4 + 3] = 255; // A
  }
  return nativeImage
    .createFromBitmap(pixels, { width: size, height: size })
    .toPNG()
    .toString("base64");
}

/** 打印一次会话视图（消息 / 工具调用 / 文件改动 / 用量），多个模式共用 */
export async function report(
  sessionId: string,
  log: Log,
  run: Run,
): Promise<void> {
  const view = await run<{
    messages: { role: string; text: string; toolCalls: { name: string; args: string }[] }[];
    fileChanges: { path: string; kind: string; addedLines: number; removedLines: number; patch: string | null }[];
    stats: { totalTokens: number; costUsd: number };
    running: boolean;
  } | null>(`window.colt.invoke("session.view", ${JSON.stringify({ sessionId })})`);

  if (!view) {
    log("未取得会话视图");
    return;
  }

  log(`消息数：${view.messages.length}，运行中：${view.running}`);
  for (const message of view.messages) {
    const calls = message.toolCalls.map((call) => `${call.name}(${call.args})`).join(" ");
    log(`  [${message.role}] ${message.text.slice(0, 100)}${calls ? ` → ${calls.slice(0, 120)}` : ""}`);
  }
  log(`文件改动：${view.fileChanges.length} 项`);
  for (const change of view.fileChanges) {
    log(`  ${change.kind} ${change.path} +${change.addedLines} -${change.removedLines} patch=${change.patch ? "有" : "无"}`);
  }
  log(`用量：${view.stats.totalTokens} tokens / $${view.stats.costUsd}`);
}
