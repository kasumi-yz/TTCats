import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, screen } from 'electron';
import type { Platform } from '../platform';
import type { Settings } from '../../shared/schemas';
import {
  IPC_CHANNELS,
  OVERLAY_TIMING,
  type MainToOverlay,
  type OverlayToMain,
} from '../../shared/ipc';
import { zh } from '../../shared/strings.zh-CN';
import { OverlaySafety } from './safety';

/** 必须在 app.ready 之前调用。 */
export function configureOverlayGpu(): void {
  app.commandLine.appendSwitch('force_low_power_gpu');
}

export interface OverlayOptions {
  system: Platform;
  settings: Settings;
  preload?: string;
  load?: (window: BrowserWindow) => Promise<void>;
  onWindow?: (window: BrowserWindow) => void;
  onMessage?: (message: OverlayToMain) => void;
  onError: (error: unknown) => void;
}

/** 正式窗口模块；IPC 的存档/命令路由由主入口整合（#28）。 */
export async function createOverlay(options: OverlayOptions) {
  let window: BrowserWindow | undefined;
  let settings = options.settings;
  let safety = new OverlaySafety();
  let ghost = false;
  let ignore = true;
  let fullscreen = false;
  let hidden = settings.visibleCats.length === 0;
  let disposed = false;
  let queue: Promise<void> = Promise.resolve();
  let lastFullscreenCheck = -Infinity;
  let rendererReady = false;
  const send = (message: MainToOverlay): void => {
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
      window.webContents.send(IPC_CHANNELS.mainToOverlay, message);
  };
  const input = () => {
    const bounds = window?.getBounds();
    const cursor = screen.getCursorScreenPoint();
    return {
      now: Date.now(),
      inside:
        bounds !== undefined &&
        cursor.x >= bounds.x &&
        cursor.y >= bounds.y &&
        cursor.x < bounds.x + bounds.width &&
        cursor.y < bounds.y + bounds.height,
      leftDown: options.system.isLeftButtonDown(),
      ctrlDown: options.system.isCtrlDown(),
      paused: fullscreen || hidden,
    };
  };
  const applyVisibility = (): void => {
    if (!window || window.isDestroyed()) return;
    send({ type: 'paused', paused: fullscreen || hidden });
    if (fullscreen || hidden) window.hide();
    else window.showInactive();
  };
  const poll = (): void => {
    if (!window || window.isDestroyed()) return;
    try {
      const state = input();
      if (state.now - lastFullscreenCheck >= 500) {
        const next = options.system.isFullscreen();
        lastFullscreenCheck = state.now;
        if (next !== fullscreen) {
          fullscreen = next;
          applyVisibility();
        }
      }
      state.paused = fullscreen || hidden;
      const result = safety.poll(state);
      if (result.cancel) send({ type: 'dragCancel' });
      if (result.ghost !== ghost) {
        ghost = result.ghost;
        send({ type: 'ghost', active: ghost });
      }
      if (result.ignore !== ignore) {
        ignore = result.ignore;
        window.setIgnoreMouseEvents(ignore, { forward: true });
      }
    } catch (error) {
      // 系统查询失败时优先释放鼠标，不能把失败当成安全的查询结果。
      ignore = true;
      window.setIgnoreMouseEvents(true, { forward: true });
      send({ type: 'dragCancel' });
      safety = new OverlaySafety();
      options.onError(error);
    }
  };
  const listener = (event: Electron.IpcMainEvent, payload: unknown): void => {
    if (!window || event.sender !== window.webContents) return;
    if (!payload || typeof payload !== 'object') return;
    const message = payload as OverlayToMain;
    try {
      safety.receive(message, input());
      if (message.type === 'catMenu' || message.type === 'stageDebug') options.onMessage?.(message);
      poll();
      if (!rendererReady) {
        rendererReady = true;
        send({ type: 'ghost', active: ghost });
        send({ type: 'paused', paused: fullscreen || hidden });
      }
    } catch (error) {
      options.onError(error);
    }
  };
  ipcMain.on(IPC_CHANNELS.overlayToMain, listener);

  const rebuild = (): Promise<void> => {
    const job = queue.then(async () => {
      if (disposed) return;
      const previous = window;
      const next = new BrowserWindow({
        ...screen.getPrimaryDisplay().workArea,
        title: zh.overlay.title,
        transparent: true,
        frame: false,
        alwaysOnTop: true,
        focusable: false,
        skipTaskbar: true,
        resizable: false,
        show: false,
        hasShadow: false,
        webPreferences: {
          preload: options.preload ?? join(import.meta.dirname, '../preload/index.cjs'),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      window = next;
      rendererReady = false;
      // Keep at least one BrowserWindow alive throughout reconstruction.
      if (previous && !previous.isDestroyed()) previous.destroy();
      safety = new OverlaySafety();
      ignore = true;
      ghost = false;
      next.setIgnoreMouseEvents(true, { forward: true });
      next.setContentProtection(!settings.showInScreenCapture);
      options.onWindow?.(next);
      try {
        if (options.load) await options.load(next);
        else {
          const url = process.env['ELECTRON_RENDERER_URL'];
          if (url) await next.loadURL(url + '/overlay/index.html');
          else await next.loadFile(join(import.meta.dirname, '../renderer/overlay/index.html'));
        }
        // disposed can change during the awaited load.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (!disposed && !next.isDestroyed()) {
          poll();
          send({ type: 'ghost', active: ghost });
          applyVisibility();
        }
      } catch (error) {
        if (!next.isDestroyed()) next.destroy();
        throw error;
      }
    });
    queue = job.catch(options.onError);
    return job;
  };
  const changed = (): void => {
    void rebuild().catch(options.onError);
  };
  screen.on('display-added', changed);
  screen.on('display-removed', changed);
  screen.on('display-metrics-changed', changed);
  const timer = setInterval(poll, OVERLAY_TIMING.watchdogMs);
  try {
    await rebuild();
  } catch (error) {
    clearInterval(timer);
    ipcMain.removeListener(IPC_CHANNELS.overlayToMain, listener);
    screen.removeListener('display-added', changed);
    screen.removeListener('display-removed', changed);
    screen.removeListener('display-metrics-changed', changed);
    throw error;
  }
  return {
    get window() {
      return window;
    },
    rebuild,
    updateSettings(next: Settings): void {
      settings = next;
      hidden = next.visibleCats.length === 0;
      window?.setContentProtection(!next.showInScreenCapture);
      applyVisibility();
      poll();
    },
    async dispose(): Promise<void> {
      disposed = true;
      clearInterval(timer);
      ipcMain.removeListener(IPC_CHANNELS.overlayToMain, listener);
      screen.removeListener('display-added', changed);
      screen.removeListener('display-removed', changed);
      screen.removeListener('display-metrics-changed', changed);
      if (window && !window.isDestroyed()) window.destroy();
      await queue;
    },
  };
}
