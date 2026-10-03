import { join } from 'node:path';
import { BrowserWindow } from 'electron';
import type {
  AppStatus,
  MainToOverlay,
  PanelName,
  StageDebugReport,
  StateSnapshot,
} from '../shared/ipc';
import { IPC_CHANNELS } from '../shared/ipc';
import { zh } from '../shared/strings.zh-CN';
import { attachRendererLog, type FileLog } from './log';

export function sendToWindow(window: BrowserWindow, channel: string, payload: unknown): void {
  if (!window.isDestroyed() && !window.webContents.isDestroyed() && !window.webContents.isCrashed())
    window.webContents.send(channel, payload);
}

async function loadPanel(window: BrowserWindow, panel: PanelName, cat?: string): Promise<void> {
  const query = { panel, ...(cat === undefined ? {} : { cat }) };
  const url = process.env['ELECTRON_RENDERER_URL'];
  if (url) await window.loadURL(`${url}/panels/index.html?${new URLSearchParams(query)}`);
  else await window.loadFile(join(import.meta.dirname, '../renderer/panels/index.html'), { query });
}

export function createPanelWindows(options: {
  log: FileLog;
  report: (error: unknown) => void;
  overlaySend: (channel: string, payload: MainToOverlay) => void;
}) {
  const windows = new Set<BrowserWindow>();
  const panels = new Map<string, BrowserWindow>();
  const updateDebug = (): void => {
    options.overlaySend(IPC_CHANNELS.mainToOverlay, {
      type: 'stageDebug',
      enabled: panels.has('debug'),
    });
  };
  const registerWindow = (window: BrowserWindow): void => {
    windows.add(window);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => {
      event.preventDefault();
    });
    window.once('closed', () => {
      windows.delete(window);
    });
  };
  const openPanel = (panel: PanelName, cat?: string): void => {
    const key = panel === 'profile' ? `${panel}:${cat ?? ''}` : panel;
    const existing = panels.get(key);
    if (existing && !existing.isDestroyed()) {
      existing.show();
      existing.focus();
      return;
    }
    const window = new BrowserWindow({
      width: 600,
      height: 760,
      title: zh.app.panelsTitle,
      show: false,
      webPreferences: {
        preload: join(import.meta.dirname, '../preload/index.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    registerWindow(window);
    panels.set(key, window);
    const detach = attachRendererLog(window.webContents, `panels:${panel}`, options.log);
    window.once('closed', () => {
      detach();
      panels.delete(key);
      updateDebug();
    });
    window.webContents.on('did-finish-load', updateDebug);
    void loadPanel(window, panel, cat)
      .then(() => {
        if (!window.isDestroyed()) window.show();
      })
      .catch(options.report);
    updateDebug();
  };
  return {
    registerWindow,
    openPanel,
    updateDebug,
    allowedSender: (id: number): boolean =>
      [...windows].some((window) => !window.isDestroyed() && window.webContents.id === id),
    publish(snapshot: StateSnapshot): void {
      for (const window of windows) sendToWindow(window, IPC_CHANNELS.snapshot, snapshot);
    },
    publishAppStatus(status: AppStatus): void {
      for (const window of windows) sendToWindow(window, IPC_CHANNELS.appStatus, status);
    },
    sendDebugReport(report: StageDebugReport): void {
      const debug = panels.get('debug');
      if (debug) sendToWindow(debug, IPC_CHANNELS.stageDebug, report);
    },
    reload(): void {
      for (const panel of panels.values()) panel.reload();
    },
    dispose(): void {
      for (const panel of panels.values()) panel.destroy();
    },
  };
}
