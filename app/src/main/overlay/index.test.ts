import { EventEmitter } from 'node:events';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { defaultSettings } from '../../shared/schemas/settings';

const mock = vi.hoisted(() => ({
  windows: [] as unknown[],
  zeroWindows: 0,
  ipc: new Map<string, (...args: unknown[]) => void>(),
  bounds: { x: 0, y: 0, width: 1920, height: 1000 },
}));
vi.mock('electron', () => ({
  app: { commandLine: { appendSwitch: vi.fn() } },
  ipcMain: {
    on: (name: string, listener: (...args: unknown[]) => void) => mock.ipc.set(name, listener),
    removeListener: (name: string) => mock.ipc.delete(name),
  },
  screen: {
    getPrimaryDisplay: () => ({ workArea: mock.bounds }),
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  BrowserWindow: class extends EventEmitter {
    webContents = { send: vi.fn(), isDestroyed: () => this.dead };
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
    getBounds() {
      return mock.bounds;
    }
    setIgnoreMouseEvents = vi.fn();
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
  });
  it('重建必须等前一个加载完成，最终只留下最新窗口且没有抢焦点', async () => {
    const loads: ReturnType<typeof latch>[] = [];
    const load = vi.fn(() => {
      const pending = latch();
      loads.push(pending);
      return pending.promise;
    });
    const starting = createOverlay({
      system,
      settings: defaultSettings(['test']),
      load,
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
      expect(mock.windows).toHaveLength(2);
      loads[1]?.release();
      await first;
      await vi.waitFor(() => {
        expect(loads).toHaveLength(3);
      });
      loads[2]?.release();
      await second;
      const windows = mock.windows as { dead: boolean; showInactive: ReturnType<typeof vi.fn> }[];
      expect(windows.filter((w) => !w.dead)).toHaveLength(1);
      expect(windows[2]?.showInactive).toHaveBeenCalled();
      // Electron quits by default when the last window closes, even transiently.
      expect(mock.zeroWindows).toBe(0);
    } finally {
      await overlay.dispose();
    }
    expect(mock.ipc.size).toBe(0);
  });
  it('关闭时即使正在加载也不能复活窗口；队列里待重建的任务取消', async () => {
    let pending: ReturnType<typeof latch> | undefined;
    const options = {
      system,
      settings: defaultSettings(['test']),
      onError: vi.fn(),
      load: () => {
        pending = latch();
        return pending.promise;
      },
    };
    const running = createOverlay(options);
    await vi.waitFor(() => {
      expect(pending).toBeDefined();
    });
    pending?.release();
    const controller = await running;
    const rebuilding = controller.rebuild();
    await vi.waitFor(() => {
      expect(mock.windows).toHaveLength(2);
    });
    const queued = controller.rebuild();
    const closing = controller.dispose();
    pending?.release();
    await Promise.all([rebuilding, queued, closing]);
    expect((mock.windows as { dead: boolean }[]).every((w) => w.dead)).toBe(true);
    expect(mock.windows).toHaveLength(2);
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
});
