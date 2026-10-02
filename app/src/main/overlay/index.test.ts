import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
// eslint-disable-next-line no-restricted-imports -- 临时目录仅用于测试。
import { tmpdir } from 'node:os';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { defaultSettings } from '../../shared/schemas/settings';
import { IPC_CHANNELS } from '../../shared/ipc';
import { attachRecovery } from '../recovery';
import { FileLog } from '../log';
import { SaveStore } from '../save';
import { CURRENT_SAVE_VERSION, defaultGameState, GameStateSchema } from '../../shared/schemas/save';
import type { BrowserWindow } from 'electron';

function mockWindow() {
  return mock.windows[0] as {
    isDestroyed: () => boolean;
    setBounds: ReturnType<typeof vi.fn>;
    getBounds: ReturnType<typeof vi.fn>;
    setIgnoreMouseEvents: ReturnType<typeof vi.fn>;
    hide: ReturnType<typeof vi.fn>;
    showInactive: ReturnType<typeof vi.fn>;
    webContents: EventEmitter & {
      mainFrame: BrowserWindow['webContents']['mainFrame'];
      send: ReturnType<typeof vi.fn>;
      isCrashed: ReturnType<typeof vi.fn<() => boolean>>;
    };
  };
}

const mock = vi.hoisted(() => ({
  windows: [] as unknown[],
  zeroWindows: 0,
  ipc: new Map<string, (...args: unknown[]) => void>(),
  bounds: { x: 0, y: 0, width: 1920, height: 1000 },
  displayId: 1,
  scaleFactor: 1,
  displayListeners: new Map<string, () => void>(),
}));
vi.mock('electron', () => ({
  app: { commandLine: { appendSwitch: vi.fn() } },
  ipcMain: {
    on: (name: string, listener: (...args: unknown[]) => void) => mock.ipc.set(name, listener),
    removeListener: (name: string) => mock.ipc.delete(name),
  },
  screen: {
    getPrimaryDisplay: () => ({
      id: mock.displayId,
      scaleFactor: mock.scaleFactor,
      workArea: mock.bounds,
    }),
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    on: (event: string, listener: () => void) => mock.displayListeners.set(event, listener),
    removeListener: (event: string) => mock.displayListeners.delete(event),
  },
  BrowserWindow: class extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), {
      send: vi.fn(),
      isDestroyed: () => this.dead,
      isCrashed: vi.fn(() => false),
      mainFrame: {},
      isLoadingMainFrame: () => false,
      executeJavaScript: () => Promise.resolve(0),
    });
    dead = false;
    constructor(readonly options: unknown) {
      super();
      mock.windows.push(this);
    }
    destroy() {
      this.dead = true;
      if ((mock.windows as { dead: boolean }[]).every((w) => w.dead)) mock.zeroWindows++;
    }
    isDestroyed() {
      return this.dead;
    }
    getBounds = vi.fn(() => mock.bounds);
    setIgnoreMouseEvents = vi.fn();
    setBounds = vi.fn();
    setContentProtection = vi.fn();
    hide = vi.fn();
    showInactive = vi.fn();
  },
}));
import { createOverlay } from './index';
const system = {
  isFullscreen: () => false,
  isCtrlDown: () => false,
  isLeftButtonDown: () => false,
};
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('桌面层重建队列', () => {
  beforeEach(() => {
    mock.windows.length = 0;
    mock.zeroWindows = 0;
    mock.ipc.clear();
    mock.bounds = { x: 0, y: 0, width: 1920, height: 1000 };
    mock.displayId = 1;
    mock.scaleFactor = 1;
    mock.displayListeners.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it.each([false, true])(
    '显示器缩放造成尺寸偏差时重试，持续偏差才报告（%s）',
    async (persistent) => {
      const onError = vi.fn();
      const overlay = await createOverlay({
        system,
        settings: defaultSettings(['test']),
        load: () => Promise.resolve(),
        onError,
      });
      try {
        const w = mockWindow();
        const wrong = { ...mock.bounds, width: 100 };
        if (persistent) w.getBounds.mockReturnValue(wrong);
        else w.getBounds.mockReturnValueOnce(wrong);
        await overlay.rebuild();
        expect(w.setBounds).toHaveBeenCalledTimes(2);
        expect(w.setBounds).toHaveBeenNthCalledWith(1, mock.bounds);
        expect(w.setBounds).toHaveBeenNthCalledWith(2, mock.bounds);
        expect(onError).toHaveBeenCalledTimes(persistent ? 1 : 0);
        if (persistent) expect(String(onError.mock.calls[0]?.[0])).toContain('尺寸重试后仍不一致');
      } finally {
        await overlay.dispose();
      }
    },
  );
  it('重建必须等前一个加载完成，复用同一窗口和恢复挂钩且没有抢焦点', async () => {
    const loads: ReturnType<typeof latch>[] = [];
    const load = vi.fn(() => {
      const pending = latch();
      loads.push(pending);
      return pending.promise;
    });
    const onWindow = vi.fn();
    const starting = createOverlay({
      system,
      settings: defaultSettings(['test']),
      load,
      onWindow,
      onError: vi.fn(),
    });
    await vi.waitFor(() => {
      expect(loads).toHaveLength(1);
    });
    loads[0]?.release();
    const overlay = await starting;
    try {
      const first = overlay.rebuild();
      const second = overlay.rebuild();
      await vi.waitFor(() => {
        expect(loads).toHaveLength(2);
      });
      expect(mock.windows).toHaveLength(1);
      loads[1]?.release();
      await first;
      await vi.waitFor(() => {
        expect(loads).toHaveLength(3);
      });
      loads[2]?.release();
      await second;
      const windows = mock.windows as { dead: boolean; showInactive: ReturnType<typeof vi.fn> }[];
      expect(windows.filter((w) => !w.dead)).toHaveLength(1);
      expect(windows[0]?.showInactive).toHaveBeenCalled();
      expect(onWindow).toHaveBeenCalledOnce();
      // Electron quits by default when the last window closes, even transiently.
      expect(mock.zeroWindows).toBe(0);
    } finally {
      await overlay.dispose();
    }
    expect(mock.ipc.size).toBe(0);
  });
  it('关闭时即使正在加载也不能复活窗口；队列里待重建的任务取消', async () => {
    let pending: ReturnType<typeof latch> | undefined;
    const load = vi.fn(() => {
      pending = latch();
      return pending.promise;
    });
    const options = {
      system,
      settings: defaultSettings(['test']),
      onError: vi.fn(),
      load,
    };
    const running = createOverlay(options);
    await vi.waitFor(() => {
      expect(pending).toBeDefined();
    });
    pending?.release();
    const controller = await running;
    const rebuilding = controller.rebuild();
    await vi.waitFor(() => {
      expect(load).toHaveBeenCalledTimes(2);
    });
    const queued = controller.rebuild();
    const closing = controller.dispose();
    pending?.release();
    await Promise.all([rebuilding, queued, closing]);
    expect((mock.windows as { dead: boolean }[]).every((w) => w.dead)).toBe(true);
    expect(mock.windows).toHaveLength(1);
    expect(load).toHaveBeenCalledTimes(2);
  });
  it('系统查询失败时立即穿透并取消拖动，错误交给主入口', async () => {
    const error = new Error('native query failed');
    const onError = vi.fn();
    const overlay = await createOverlay({
      system: {
        ...system,
        isCtrlDown: () => {
          throw error;
        },
      },
      settings: defaultSettings(['test']),
      load: () => Promise.resolve(),
      onError,
    });
    try {
      expect(onError).toHaveBeenCalledWith(error);
      const w = mock.windows[0] as { setIgnoreMouseEvents: ReturnType<typeof vi.fn> };
      expect(w.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true });
    } finally {
      await overlay.dispose();
    }
  });
  it('副屏通知不重建，主屏的一批重复通知只重建一次，缩放和主屏切换也不能漏掉', async () => {
    const load = vi.fn(() => Promise.resolve());
    const overlay = await createOverlay({
      system,
      settings: defaultSettings(['test']),
      load,
      onError: vi.fn(),
    });
    const changed = () => {
      for (const event of ['display-added', 'display-removed', 'display-metrics-changed'])
        mock.displayListeners.get(event)?.();
    };
    try {
      changed();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(load).toHaveBeenCalledTimes(1);
      mock.bounds = { ...mock.bounds, width: 1600 };
      changed();
      await vi.waitFor(() => {
        expect(load).toHaveBeenCalledTimes(2);
      });
      changed();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(load).toHaveBeenCalledTimes(2);
      mock.scaleFactor = 1.5;
      changed();
      await vi.waitFor(() => {
        expect(load).toHaveBeenCalledTimes(3);
      });
      mock.displayId = 2;
      changed();
      await vi.waitFor(() => {
        expect(load).toHaveBeenCalledTimes(4);
      });
      expect(mock.zeroWindows).toBe(0);
    } finally {
      await overlay.dispose();
    }
    expect(mock.displayListeners.size).toBe(0);
  });
  it('加载期间的显示器通知合并为一个待办，并在开始时使用最新主屏参数', async () => {
    let pending: ReturnType<typeof latch> | undefined;
    const load = vi.fn(() => pending?.promise ?? Promise.resolve());
    const overlay = await createOverlay({
      system,
      settings: defaultSettings(['test']),
      load,
      onError: vi.fn(),
    });
    try {
      pending = latch();
      mock.bounds = { ...mock.bounds, width: 1600 };
      mock.displayListeners.get('display-metrics-changed')?.();
      await vi.waitFor(() => {
        expect(load).toHaveBeenCalledTimes(2);
      });
      for (let i = 0; i < 10; i++) {
        mock.bounds = { ...mock.bounds, width: 1500 - i };
        mock.displayListeners.get('display-metrics-changed')?.();
      }
      pending.release();
      await vi.waitFor(() => {
        expect(load).toHaveBeenCalledTimes(3);
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(load).toHaveBeenCalledTimes(3);
      expect(mockWindow().setBounds).toHaveBeenLastCalledWith({ ...mock.bounds, width: 1491 });
      expect(mock.windows).toHaveLength(1);
      expect(mock.zeroWindows).toBe(0);
    } finally {
      pending?.release();
      await overlay.dispose();
    }
  });
  it('每条 hover 只查询一次系统输入，并继续由20ms看门狗兜底', async () => {
    vi.useFakeTimers();
    const isCtrlDown = vi.fn(() => false);
    const isLeftButtonDown = vi.fn(() => false);
    const overlay = await createOverlay({
      system: { ...system, isCtrlDown, isLeftButtonDown },
      settings: defaultSettings(['test']),
      load: () => Promise.resolve(),
      onError: vi.fn(),
    });
    try {
      isCtrlDown.mockClear();
      isLeftButtonDown.mockClear();
      const window = overlay.window;
      mock.ipc.get(IPC_CHANNELS.overlayToMain)?.(
        { sender: window?.webContents, senderFrame: window?.webContents.mainFrame },
        { type: 'hover', onCat: true },
      );
      expect(isCtrlDown).toHaveBeenCalledOnce();
      expect(isLeftButtonDown).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(20);
      expect(isCtrlDown).toHaveBeenCalledTimes(2);
      expect(isLeftButtonDown).toHaveBeenCalledTimes(2);
    } finally {
      await overlay.dispose();
    }
  });
  it('正式重载释放旧租约、拖动和幽灵状态，加载期间旧页面不能重新截获鼠标', async () => {
    vi.useFakeTimers();
    let ctrlDown = false;
    let pending: ReturnType<typeof latch> | undefined;
    const load = vi.fn(() => pending?.promise ?? Promise.resolve());
    const onMessage = vi.fn();
    const onReady = vi.fn();
    const overlay = await createOverlay({
      system: { ...system, isLeftButtonDown: () => true, isCtrlDown: () => ctrlDown },
      settings: defaultSettings(['test']),
      load,
      onMessage,
      onReady,
      onError: vi.fn(),
    });
    const w = mockWindow();
    const message = (payload: unknown, senderFrame = w.webContents.mainFrame) =>
      mock.ipc.get(IPC_CHANNELS.overlayToMain)?.({ sender: w.webContents, senderFrame }, payload);
    try {
      message({ type: 'hover', onCat: true });
      message({ type: 'drag', active: true });
      expect(onReady).toHaveBeenCalledOnce();
      expect(w.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, { forward: true });
      ctrlDown = true;
      await vi.advanceTimersByTimeAsync(20);
      ctrlDown = false;
      await vi.advanceTimersByTimeAsync(20);
      pending = latch();
      const reloading = overlay.reload();
      await Promise.resolve();
      expect(w.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
      expect(w.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.mainToOverlay, {
        type: 'dragCancel',
      });
      expect(w.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.mainToOverlay, {
        type: 'ghost',
        active: false,
      });
      message({ type: 'hover', onCat: true });
      message({ type: 'drag', active: true });
      message({ type: 'catMenu', catId: 'test' });
      await vi.advanceTimersByTimeAsync(20);
      expect(onMessage).not.toHaveBeenCalled();
      expect(w.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
      pending.release();
      await reloading;
      expect(w.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
      message({ type: 'hover', onCat: true }, {} as Electron.WebFrameMain);
      expect(w.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
      message({ type: 'hover', onCat: true });
      // 新页面能立即互动，说明旧 Ctrl 的两秒幽灵保留期也已经清除。
      expect(onReady).toHaveBeenCalledTimes(2);
      expect(w.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, { forward: true });
      expect(load).toHaveBeenCalledTimes(2);
      expect(load).toHaveBeenLastCalledWith(w);
    } finally {
      pending?.release();
      await overlay.dispose();
    }
  });
  it('安全模式立即隐藏，正在加载、排队重建、设置和全屏恢复均不能重新显示', async () => {
    vi.useFakeTimers();
    let fullscreen = false;
    let pending: ReturnType<typeof latch> | undefined;
    const load = vi.fn(() => pending?.promise ?? Promise.resolve());
    const overlay = await createOverlay({
      system: { ...system, isFullscreen: () => fullscreen },
      settings: defaultSettings(['test']),
      load,
      onError: vi.fn(),
    });
    const w = mockWindow();
    try {
      pending = latch();
      const reloading = overlay.reload();
      await Promise.resolve();
      const queued = overlay.rebuild();
      vi.mocked(w.showInactive).mockClear();
      overlay.enterSafeMode();
      expect(w.hide).toHaveBeenCalled();
      expect(w.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
      pending.release();
      await Promise.all([reloading, queued]);
      fullscreen = true;
      await vi.advanceTimersByTimeAsync(500);
      fullscreen = false;
      await vi.advanceTimersByTimeAsync(500);
      overlay.updateSettings(defaultSettings([]));
      overlay.updateSettings(defaultSettings(['test']));
      mock.bounds = { ...mock.bounds, width: 1600 };
      mock.displayListeners.get('display-metrics-changed')?.();
      await overlay.rebuild();
      await overlay.reload();
      expect(w.showInactive).not.toHaveBeenCalled();
      expect(w.setBounds).not.toHaveBeenCalled();
      expect(load).toHaveBeenCalledTimes(2);
      expect(mock.windows).toHaveLength(1);
    } finally {
      pending?.release();
      await overlay.dispose();
    }
  });
  it('首次加载先 reject 后 gone 仍能恢复；显示器重建不重置三次恢复额度', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ttcats-overlay-test-'));
    const state = () => defaultGameState(['test']);
    const save = new SaveStore({
      directory,
      currentVersion: CURRENT_SAVE_VERSION,
      schema: GameStateSchema,
      defaultState: state,
      now: Date.now,
      log: vi.fn(),
    });
    const log = new FileLog({ directory: join(directory, 'logs') });
    const error = new Error('initial load rejected before gone');
    const load = vi
      .fn()
      .mockImplementationOnce(() => {
        mockWindow().webContents.isCrashed.mockReturnValue(true);
        return Promise.reject(error);
      })
      .mockImplementation(() => {
        mockWindow().webContents.isCrashed.mockReturnValue(false);
        return Promise.resolve();
      });
    const onError = vi.fn();
    const notify = vi.fn();
    let recovery: ReturnType<typeof attachRecovery> | undefined;
    const onWindow = vi.fn(
      (window: NonNullable<Awaited<ReturnType<typeof createOverlay>>['window']>) => {
        recovery = attachRecovery({
          overlay: window,
          save,
          log,
          defaultState: state,
          activeCats: () => ['test'],
          catName: (id) => id,
          notify,
          reload: () => overlay.reload(),
          applySafeMode: () => {
            overlay.enterSafeMode();
          },
        });
      },
    );
    const overlay = await createOverlay({
      system,
      settings: state().settings,
      load,
      onWindow,
      onError,
    });
    try {
      const w = mockWindow();
      expect(w.isDestroyed()).toBe(false);
      expect(onError).toHaveBeenCalledExactlyOnceWith(error);
      expect(w.showInactive).not.toHaveBeenCalled();
      for (let index = 0; index < 4; index++) {
        w.webContents.isCrashed.mockReturnValue(true);
        w.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
        await vi.waitFor(() => {
          expect(recovery?.getState().failures).toHaveLength(index + 1);
        });
        if (index < 3) {
          await vi.waitFor(() => {
            expect(load).toHaveBeenCalledTimes(2 + index * 2);
          });
          await overlay.rebuild();
        }
      }
      await vi.waitFor(() => {
        expect(notify).toHaveBeenCalledOnce();
      });
      expect(recovery?.getState().safeMode).toBe(true);
      expect(onWindow).toHaveBeenCalledOnce();
      expect(overlay.window).toBe(w);
      vi.mocked(w.showInactive).mockClear();
      await overlay.rebuild();
      overlay.updateSettings(state().settings);
      expect(w.showInactive).not.toHaveBeenCalled();
      expect(load).toHaveBeenCalledTimes(7);
    } finally {
      recovery?.dispose();
      await overlay.dispose();
      rmSync(directory, { recursive: true });
    }
  });
  it.each([false, true])(
    '首次文件缺失且没有 gone 必须抛错并清理，即使存在 onWindow：%s',
    async (withHook) => {
      vi.useFakeTimers();
      const error = new Error('ERR_FILE_NOT_FOUND');
      const onWindow = vi.fn();
      const onError = vi.fn();
      await expect(
        createOverlay({
          system,
          settings: defaultSettings(['test']),
          load: () => Promise.reject(error),
          onWindow: withHook ? onWindow : undefined,
          onError,
        }),
      ).rejects.toBe(error);
      expect(mock.windows).toHaveLength(1);
      expect((mock.windows[0] as { dead: boolean }).dead).toBe(true);
      expect(mock.ipc.size).toBe(0);
      expect(mock.displayListeners.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(onWindow).toHaveBeenCalledTimes(withHook ? 1 : 0);
      expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    },
  );
  it('向崩溃进程发送消息不能阻断安全模式的隐藏与鼠标释放', async () => {
    const overlay = await createOverlay({
      system,
      settings: defaultSettings(['test']),
      load: () => Promise.resolve(),
      onError: vi.fn(),
    });
    const w = mockWindow();
    try {
      w.webContents.isCrashed.mockReturnValue(true);
      w.webContents.send.mockClear().mockImplementation(() => {
        throw new Error('render frame disposed');
      });
      w.hide.mockClear();
      expect(() => {
        overlay.enterSafeMode();
      }).not.toThrow();
      expect(w.webContents.send).not.toHaveBeenCalled();
      expect(w.hide).toHaveBeenCalledOnce();
      expect(w.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
    } finally {
      await overlay.dispose();
    }
  });
});
