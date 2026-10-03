import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, screen } from 'electron';
import type { Platform } from '../platform';
import type { Settings } from '../../shared/schemas';
import { chooseDisplay, type DisplayInfo } from '../../shared/display';
import {
  IPC_CHANNELS,
  OVERLAY_TIMING,
  type StageCommand,
  type MainToOverlay,
  type OverlayToMain,
} from '../../shared/ipc';
import { zh } from '../../shared/strings.zh-CN';
import { displayInfo, listDisplays, toOverlayDisplay } from './displays';
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
  onReady?: () => void;
  /** 每次按显示器重新摆放桌面层后调用（参数没变、跳过重建时也调用）：现在的全部显示器，以及桌面层在哪一块。 */
  onDisplays?: (displays: DisplayInfo[], current: number) => void;
  onExitChange?: () => void;
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
  let simulatedFullscreen = false;
  let hideAll = false;
  let hidden = settings.visibleCats.length === 0;
  let waitingForExit = false;
  const setWaitingForExit = (active: boolean): void => {
    if (active === waitingForExit) return;
    waitingForExit = active;
    options.onExitChange?.();
  };
  let disposed = false;
  let safeMode = false;
  let loading = false;
  let windowHookCompleted = false;
  let queue: Promise<void> = Promise.resolve();
  let pendingDisplayRebuild: Promise<void> | undefined;
  let displayKey: string | undefined;
  /** 桌面层实际在哪块显示器（Display.id）。挪不过去时按窗口实际位置算，不是想去的那块。 */
  let displayId: number | undefined;
  let lastFullscreenCheck = -Infinity;
  let rendererReady = false;
  let photoCaptures = 0;
  const send = (message: MainToOverlay): void => {
    if (
      window &&
      !window.isDestroyed() &&
      !window.webContents.isDestroyed() &&
      !window.webContents.isCrashed()
    )
      window.webContents.send(IPC_CHANNELS.mainToOverlay, message);
  };
  const input = () => {
    const bounds = window?.getBounds();
    const cursor = screen.getCursorScreenPoint();
    return {
      now: Date.now(),
      x: cursor.x - (bounds?.x ?? 0),
      y: cursor.y - (bounds?.y ?? 0),
      inside:
        bounds !== undefined &&
        cursor.x >= bounds.x &&
        cursor.y >= bounds.y &&
        cursor.x < bounds.x + bounds.width &&
        cursor.y < bounds.y + bounds.height,
      leftDown: options.system.isLeftButtonDown(),
      ctrlDown: options.system.isCtrlDown(),
      paused: safeMode || loading || fullscreen || hidden || hideAll,
    };
  };
  const applyVisibility = (): void => {
    if (disposed || !window || window.isDestroyed()) return;
    const paused = safeMode || loading || fullscreen || hidden || hideAll;
    send({ type: 'paused', paused });
    if (paused) window.hide();
    else window.showInactive();
  };
  /** 只管桌面层所在的那块显示器：别的显示器上的全屏不影响猫（#65）。 */
  const systemFullscreen = (): boolean => {
    if (!window || window.isDestroyed()) return false;
    const bounds = window.getBounds();
    return options.system.isFullscreen({
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
    });
  };
  const updateFullscreen = (next: boolean): void => {
    if (next === fullscreen) return;
    const ended = fullscreen && !next;
    fullscreen = next;
    applyVisibility();
    // 只有全屏结束并真正恢复显示才重新入场；普通暂停恢复不能触发。
    if (ended && !safeMode && !loading && !hidden && !hideAll && window && !window.isDestroyed())
      window.webContents.send(IPC_CHANNELS.stageCommand, {
        type: 'cat/entrance',
      } satisfies StageCommand);
  };
  const poll = (sample?: ReturnType<typeof input>): void => {
    if (disposed || safeMode || loading || !window || window.isDestroyed()) return;
    try {
      const state = sample ?? input();
      if (state.now - lastFullscreenCheck >= 500) {
        const next = simulatedFullscreen || systemFullscreen();
        lastFullscreenCheck = state.now;
        updateFullscreen(next);
      }
      state.paused = fullscreen || hidden || hideAll;
      const result = safety.poll(state, ignore);
      if (result.cancel) send({ type: 'dragCancel' });
      if (result.ghost !== ghost) {
        ghost = result.ghost;
        send({ type: 'ghost', active: ghost });
      }
      if (result.ignore !== ignore) {
        ignore = result.ignore;
        window.setIgnoreMouseEvents(ignore, { forward: true });
      }
      if (result.clickThrough) send({ type: 'clickThrough', x: state.x, y: state.y });
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
    if (
      disposed ||
      safeMode ||
      loading ||
      !window ||
      window.isDestroyed() ||
      event.sender !== window.webContents ||
      event.senderFrame !== event.sender.mainFrame
    )
      return;
    if (!payload || typeof payload !== 'object') return;
    const message = payload as OverlayToMain;
    try {
      const state = input();
      safety.receive(message, state);
      if (message.type === 'stageDebug' && waitingForExit && message.report.cats.length === 0) {
        setWaitingForExit(false);
        hidden = true;
        applyVisibility();
      }
      if (message.type === 'catMenu' || message.type === 'stageDebug') options.onMessage?.(message);
      poll(state);
      if (!rendererReady) {
        rendererReady = true;
        options.onReady?.();
        send({ type: 'ghost', active: ghost });
        send({ type: 'paused', paused: fullscreen || hidden || hideAll });
      }
    } catch (error) {
      options.onError(error);
    }
  };
  ipcMain.on(IPC_CHANNELS.overlayToMain, listener);

  const resetInput = (): void => {
    safety = new OverlaySafety();
    rendererReady = false;
    ignore = true;
    ghost = false;
    if (!window || window.isDestroyed()) return;
    window.setIgnoreMouseEvents(true, { forward: true });
    send({ type: 'dragCancel' });
    send({ type: 'ghost', active: false });
  };
  const load = async (): Promise<void> => {
    if (disposed || safeMode || !window || window.isDestroyed()) return;
    const target = window;
    loading = true;
    // 重载后的 stage 已无出场中的猫，不能继续等待旧报告。
    setWaitingForExit(false);
    hidden = settings.visibleCats.length === 0;
    resetInput();
    applyVisibility();
    // 加载失败时保持隐藏、穿透；保留窗口供随后到达的 gone 事件恢复。
    if (options.load) await options.load(target);
    else {
      const url = process.env['ELECTRON_RENDERER_URL'];
      if (url) await target.loadURL(url + '/overlay/index.html');
      else await target.loadFile(join(import.meta.dirname, '../renderer/overlay/index.html'));
    }
    loading = false;
    poll();
    applyVisibility();
  };
  const reload = (): Promise<void> => {
    const job = queue.then(load);
    queue = job.catch(options.onError);
    return job;
  };
  const rebuild = (force = true): Promise<void> => {
    if (!force && pendingDisplayRebuild) return pendingDisplayRebuild;
    const job = queue.then(async () => {
      if (!force) pendingDisplayRebuild = undefined;
      if (disposed || safeMode) return;
      const primary = screen.getPrimaryDisplay();
      const displays = listDisplays(screen.getAllDisplays(), primary.id);
      // 设置的那块不在时用主显示器；不改设置，接回来以后下一次显示器事件会把猫放回去
      const target =
        chooseDisplay(settings.display, displays) ?? toOverlayDisplay(primary, primary.id);
      const area = target.workArea;
      const key = JSON.stringify([
        target.id,
        area.x,
        area.y,
        area.width,
        area.height,
        target.scaleFactor,
      ]);
      const placed = (): void => {
        if (displayId !== undefined) options.onDisplays?.(displays.map(displayInfo), displayId);
      };
      if (!force && key === displayKey && window && !window.isDestroyed()) {
        placed();
        return;
      }
      if (window) {
        if (window.isDestroyed()) return;
        window.setBounds(area);
        const matches = (): boolean => {
          const bounds = window?.getBounds();
          return (
            bounds !== undefined &&
            bounds.x === area.x &&
            bounds.y === area.y &&
            bounds.width === area.width &&
            bounds.height === area.height
          );
        };
        displayId = target.id;
        if (!matches()) {
          window.setBounds(area);
          if (!matches()) {
            const actual = window.getBounds();
            options.onError(
              new Error(
                zh.integration.overlayBoundsMismatch(JSON.stringify(area), JSON.stringify(actual)),
              ),
            );
            // 没挪到目标显示器上时，调试台要看到窗口实际在的那块
            displayId = screen.getDisplayMatching(actual).id;
          }
        }
        displayKey = key;
        placed();
        await load();
        return;
      }
      const next = new BrowserWindow({
        ...area,
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
      displayKey = key;
      displayId = target.id;
      placed();
      next.setIgnoreMouseEvents(true, { forward: true });
      next.setContentProtection(!settings.showInScreenCapture);
      options.onWindow?.(next);
      windowHookCompleted = options.onWindow !== undefined;
      await load();
    });
    queue = job.catch(options.onError);
    if (!force) pendingDisplayRebuild = job;
    return job;
  };
  const changed = (): void => {
    // queue 已报告失败；事件入口只消费 rejection。
    void rebuild(false).catch(() => {});
  };
  screen.on('display-added', changed);
  screen.on('display-removed', changed);
  screen.on('display-metrics-changed', changed);
  const timer = setInterval(() => {
    poll();
  }, OVERLAY_TIMING.watchdogMs);
  try {
    await rebuild();
  } catch (error) {
    // 只容忍真实崩溃，保留窗口等待 gone；文件缺失等普通加载错误必须抛给主入口。
    if (
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- rebuild 的异步回调会设置恢复挂钩状态。
      !windowHookCompleted ||
      !window ||
      window.isDestroyed() ||
      window.webContents.isDestroyed() ||
      !window.webContents.isCrashed()
    ) {
      clearInterval(timer);
      ipcMain.removeListener(IPC_CHANNELS.overlayToMain, listener);
      screen.removeListener('display-added', changed);
      screen.removeListener('display-removed', changed);
      screen.removeListener('display-metrics-changed', changed);
      if (window && !window.isDestroyed()) window.destroy();
      throw error;
    }
  }
  return {
    get window() {
      return window;
    },
    get waitingForExit() {
      return waitingForExit;
    },
    rebuild,
    reload,
    simulateFullscreen(active: boolean): void {
      if (disposed || safeMode) return;
      simulatedFullscreen = active;
      updateFullscreen(active || systemFullscreen());
      poll();
    },
    updateHideAll(active: boolean): void {
      if (disposed || active === hideAll) return;
      hideAll = active;
      applyVisibility();
      poll();
    },
    async withCaptureProtection<T>(capture: () => Promise<T>): Promise<T> {
      const target = window;
      if (!target || target.isDestroyed()) throw new Error(zh.photo.desktopChanged);
      photoCaptures++;
      try {
        target.setContentProtection(true);
        return await capture();
      } finally {
        photoCaptures--;
        if (!target.isDestroyed())
          target.setContentProtection(photoCaptures > 0 || !settings.showInScreenCapture);
      }
    },
    enterSafeMode(): void {
      safeMode = true;
      resetInput();
      applyVisibility();
    },
    updateSettings(next: Settings): void {
      if (disposed) return;
      const moved = JSON.stringify(next.display) !== JSON.stringify(settings.display);
      if (settings.visibleCats.length > 0 && next.visibleCats.length === 0) setWaitingForExit(true);
      if (next.visibleCats.length > 0) setWaitingForExit(false);
      settings = next;
      hidden = next.visibleCats.length === 0 && !waitingForExit;
      if (window && !window.isDestroyed())
        window.setContentProtection(photoCaptures > 0 || !next.showInScreenCapture);
      applyVisibility();
      poll();
      if (moved) changed();
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
