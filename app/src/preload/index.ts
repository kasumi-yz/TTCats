// 桌面层和面板共用的 preload：把 RendererBridge 挂到 window.ttcats 上。
// 只有一个 preload 文件：窗口开着 sandbox，sandbox 里的 preload 必须是一个完整的 CommonJS 文件，
// 不能 require 别的文件，多个 preload 一起打包会拆出公共文件。
// 桌面层按 OverlayBridge 用，面板按 PanelsBridge 用；窗口不能自己改需要存档的状态（ADR-0004）。
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { ContentCatalog } from '../shared/core-api';
import {
  BRIDGE_KEY,
  IPC_CHANNELS,
  type AppStatus,
  type MainToOverlay,
  type RendererBridge,
  type StageCommand,
  type StageDebugReport,
  type StateSnapshot,
  type Unsubscribe,
} from '../shared/ipc';

/** 监听主进程推送的消息，返回取消监听的函数。消息内容的类型由通道决定。 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
function listen<T>(channel: string, listener: (payload: T) => void): Unsubscribe {
  const handler = (_event: IpcRendererEvent, payload: T): void => {
    listener(payload);
  };
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

export const bridge: RendererBridge = {
  sendCommand(command) {
    ipcRenderer.send(IPC_CHANNELS.command, command);
  },
  sendFact(fact) {
    ipcRenderer.send(IPC_CHANNELS.fact, fact);
  },
  sendOverlay(message) {
    ipcRenderer.send(IPC_CHANNELS.overlayToMain, message);
  },
  getSnapshot() {
    return ipcRenderer.invoke(IPC_CHANNELS.getSnapshot) as Promise<StateSnapshot>;
  },
  getContent() {
    return ipcRenderer.invoke(IPC_CHANNELS.getContent) as Promise<ContentCatalog>;
  },
  getAppStatus() {
    return ipcRenderer.invoke(IPC_CHANNELS.getAppStatus) as Promise<AppStatus>;
  },
  onSnapshot(listener) {
    return listen<StateSnapshot>(IPC_CHANNELS.snapshot, listener);
  },
  onStageCommand(listener) {
    return listen<StageCommand>(IPC_CHANNELS.stageCommand, listener);
  },
  onOverlay(listener) {
    return listen<MainToOverlay>(IPC_CHANNELS.mainToOverlay, listener);
  },
  onStageDebug(listener) {
    return listen<StageDebugReport>(IPC_CHANNELS.stageDebug, listener);
  },
  onAppStatus(listener) {
    return listen<AppStatus>(IPC_CHANNELS.appStatus, listener);
  },
};

contextBridge.exposeInMainWorld(BRIDGE_KEY, bridge);
