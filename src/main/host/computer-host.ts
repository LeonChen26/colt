/**
 * 电脑控制宿主（Computer Use）：主进程负责截屏与向操作系统注入鼠标/键盘。
 *
 * 设计对齐业界共识（Codex / TRAE / Qoder）：
 *   - 闭环由模型驱动，宿主只做原子动作：截图 → 模型判断 → 点击/输入 → 再截图；
 *   - 强制「先观察再操作」：每次操作后截图作废，下一步必须先重新截图，
 *     从机制上杜绝「基于过期画面盲目操作」；
 *   - 屏幕尺寸变化时拒绝执行，要求重新截图（画面与截图可能已不一致）。
 *
 * 平台：当前实现 Windows（本产品的发布目标）。注入走 PowerShell + user32，
 * 避免引入需为 Electron ABI 重编译的原生模块。其它平台明确报错而非静默降级。
 */
import { spawn } from "node:child_process";
import { desktopCapturer, screen } from "electron";
import type { HostResult } from "@shared/worker-protocol";
import { escapeSendKeysText, toSendKeysCombo } from "./input-keys";

/** 单条注入指令上限 */
const INJECT_TIMEOUT_MS = 20_000;
/** 截图有效期：超过则要求重新截图 */
const SCREENSHOT_TTL_MS = 2 * 60 * 1000;

/** user32 P/Invoke 定义：SetCursorPos + mouse_event */
const NATIVE_MOUSE =
  "Add-Type -Namespace Banyan -Name Native -MemberDefinition " +
  "'[DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int X, int Y); " +
  "[DllImport(\"user32.dll\")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, int dwData, System.UIntPtr dwExtraInfo);'";

const SENDKEYS_PRELUDE = "Add-Type -AssemblyName System.Windows.Forms; ";

const MOUSE_LEFT_DOWN = "0x0002";
const MOUSE_LEFT_UP = "0x0004";
const MOUSE_RIGHT_DOWN = "0x0008";
const MOUSE_RIGHT_UP = "0x0010";
const MOUSE_WHEEL = "0x0800";

interface SessionState {
  capturedAt: number;
  width: number;
  height: number;
}

/** 执行一段 PowerShell 脚本；extraEnv 用于传递任意文本，避免拼接进脚本造成注入 */
function runPowerShell(script: string, extraEnv: Record<string, string> = {}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      env: { ...process.env, ...extraEnv },
    });

    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };

    timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error("电脑控制指令超时未返回")));
    }, INJECT_TIMEOUT_MS);
    timer.unref?.();

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => {
      finish(() => {
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `PowerShell 退出码 ${code ?? "未知"}`));
      });
    });
  });
}

function readCoord(value: unknown, name: string, max: number): number {
  const num = typeof value === "number" ? value : Number.NaN;
  if (!Number.isInteger(num) || num < 0 || num >= max) {
    throw new Error(`${name} 必须是 0 到 ${max - 1} 之间的整数像素坐标`);
  }
  return num;
}

function readText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("type 需要非空的 text");
  return value;
}

function readKeys(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string")) {
    throw new Error('key 需要非空的按键数组，例如 ["ctrl","c"]');
  }
  return value as string[];
}

function readScrollSteps(value: unknown): number {
  const num = typeof value === "number" ? value : 1;
  return Math.max(1, Math.min(10, Math.round(Math.abs(num)) || 1));
}

export class ComputerHost {
  readonly #sessions = new Map<string, SessionState>();

  async handle(sessionId: string, action: string, params: Record<string, unknown>): Promise<HostResult> {
    switch (action) {
      case "screenshot":
        return this.#screenshot(sessionId);
      case "click":
      case "type":
      case "key":
      case "scroll":
        return this.#action(sessionId, action, params);
      default:
        throw new Error(`未知的电脑控制动作：${action}`);
    }
  }

  async #screenshot(sessionId: string): Promise<HostResult> {
    const display = screen.getPrimaryDisplay();
    const { width, height } = primarySize();
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width, height },
    });
    // Windows 上 display_id 可能为空字符串，此时无法把画面源可靠地对应到主屏：
    // 只有在「仅一个画面源」时才可安全认定它就是主屏，否则宁可报错也不静默取错屏。
    const source =
      sources.find((item) => item.display_id === String(display.id)) ??
      (sources.length === 1 ? sources[0] : undefined);
    if (!source) {
      throw new Error("无法唯一定位主屏画面源（多显示器且未返回 display_id），请重试或改用单显示器。");
    }

    this.#sessions.set(sessionId, { capturedAt: Date.now(), width, height });
    return {
      text:
        `已截取主屏画面。坐标系为像素，范围 x: 0-${width - 1}，y: 0-${height - 1}；` +
        "点击/滚动请基于此画面给出坐标。",
      image: { data: source.thumbnail.toPNG().toString("base64"), mimeType: "image/png" },
    };
  }

  async #action(sessionId: string, action: string, params: Record<string, unknown>): Promise<HostResult> {
    if (process.platform !== "win32") {
      throw new Error("电脑控制当前仅支持 Windows；macOS 尚需实现并授予辅助功能/屏幕录制权限。");
    }

    const state = this.#sessions.get(sessionId);
    if (!state || Date.now() - state.capturedAt > SCREENSHOT_TTL_MS) {
      throw new Error("请先执行 computer_screenshot 观察当前界面，再进行操作。");
    }
    const { width, height } = primarySize();
    if (width !== state.width || height !== state.height) {
      throw new Error("屏幕分辨率已变化，请重新执行 computer_screenshot。");
    }

    switch (action) {
      case "click": {
        const x = readCoord(params.x, "x", width);
        const y = readCoord(params.y, "y", height);
        const right = params.button === "right";
        const down = right ? MOUSE_RIGHT_DOWN : MOUSE_LEFT_DOWN;
        const up = right ? MOUSE_RIGHT_UP : MOUSE_LEFT_UP;
        await runPowerShell(
          [
            NATIVE_MOUSE,
            `[Banyan.Native]::SetCursorPos(${x}, ${y})`,
            `[Banyan.Native]::mouse_event(${down},0,0,0,[System.UIntPtr]::Zero)`,
            `[Banyan.Native]::mouse_event(${up},0,0,0,[System.UIntPtr]::Zero)`,
          ].join("; "),
        );
        this.#invalidate(sessionId);
        return { text: `已${right ? "右键" : "左键"}点击 (${x}, ${y})` };
      }
      case "type": {
        const text = readText(params.text);
        await runPowerShell(`${SENDKEYS_PRELUDE}[System.Windows.Forms.SendKeys]::SendWait($env:BANYAN_TEXT)`, {
          BANYAN_TEXT: escapeSendKeysText(text),
        });
        this.#invalidate(sessionId);
        return { text: `已在当前焦点输入 ${text.length} 个字符` };
      }
      case "key": {
        const keys = readKeys(params.keys);
        const sequence = toSendKeysCombo(keys);
        await runPowerShell(`${SENDKEYS_PRELUDE}[System.Windows.Forms.SendKeys]::SendWait($env:BANYAN_KEY)`, {
          BANYAN_KEY: sequence,
        });
        this.#invalidate(sessionId);
        return { text: `已发送按键 ${keys.join("+")}` };
      }
      case "scroll": {
        const x = readCoord(params.x, "x", width);
        const y = readCoord(params.y, "y", height);
        const steps = readScrollSteps(params.delta);
        // delta 正值表示向下滚动；Windows 滚轮正值向上，故取负
        const data = -steps * 120;
        await runPowerShell(
          [
            NATIVE_MOUSE,
            `[Banyan.Native]::SetCursorPos(${x}, ${y})`,
            `[Banyan.Native]::mouse_event(${MOUSE_WHEEL},0,0,${data},[System.UIntPtr]::Zero)`,
          ].join("; "),
        );
        this.#invalidate(sessionId);
        return { text: `已在 (${x}, ${y}) 向${data < 0 ? "下" : "上"}滚动` };
      }
      default:
        throw new Error(`未知的电脑控制动作：${action}`);
    }
  }

  /** 操作后作废截图：强制下一步先重新观察 */
  #invalidate(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  resetSession(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }
}

/** 主屏物理像素尺寸（desktopCapturer 与 SetCursorPos 都按物理像素） */
function primarySize(): { width: number; height: number } {
  const display = screen.getPrimaryDisplay();
  return {
    width: Math.round(display.size.width * display.scaleFactor),
    height: Math.round(display.size.height * display.scaleFactor),
  };
}
