/**
 * 预加载：按白名单向渲染进程暴露最小 API 面
 * 渲染进程无 Node 能力，只能经由这里与主进程通信。
 * 作者：陕耀云栈WorkMate
 */
import { contextBridge, ipcRenderer } from "electron";
import {
  IPC_CHANNELS,
  IPC_EVENTS,
  type BanyanApi,
  type IpcChannel,
  type IpcEventName,
} from "@shared/protocol";

const channels = new Set<string>(IPC_CHANNELS);
const events = new Set<string>(IPC_EVENTS);

const api: BanyanApi = {
  invoke: (channel, request) => {
    if (!channels.has(channel)) {
      return Promise.reject(new Error(`未授权的 IPC 通道: ${String(channel)}`));
    }
    return ipcRenderer.invoke(channel as IpcChannel, request);
  },
  on: (event, handler) => {
    if (!events.has(event)) {
      throw new Error(`未授权的 IPC 事件: ${String(event)}`);
    }
    const listener = (_e: Electron.IpcRendererEvent, payload: unknown): void => {
      handler(payload as never);
    };
    ipcRenderer.on(event as IpcEventName, listener);
    return () => {
      ipcRenderer.off(event as IpcEventName, listener);
    };
  },
};

contextBridge.exposeInMainWorld("banyan", api);
