import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const api = vi.hoisted(() => ({
  keyState: vi.fn<(key: number) => number>(),
  metrics: vi.fn<(index: number) => number>(),
  notification: vi.fn<(state: number[]) => number>(),
  /** 前台窗口：0 表示没有 */
  foreground: 100,
  windowClass: 'Chrome_WidgetWin_1',
  windowRect: { left: 0, top: 0, right: 2880, bottom: 1800 },
  monitorRect: { left: 0, top: 0, right: 2880, bottom: 1800 },
  /** 前台窗口所在的屏幕 */
  foregroundMonitor: 1,
  /** 猫所在的屏幕（按传进来的点查） */
  catMonitor: 1,
  process: String.raw`C:\Games\game.exe`,
  dipToScreenPoint: vi.fn((point: { x: number; y: number }) => point),
  monitorPoints: [] as { x: number; y: number }[],
}));

vi.mock('electron', () => ({ screen: { dipToScreenPoint: api.dipToScreenPoint } }));

const text = (buffer: Buffer, value: string, max: number): number => {
  buffer.write(value.slice(0, max), 'utf16le');
  return Math.min(value.length, max);
};

vi.mock('koffi', () => ({
  default: {
    struct: () => ({}),
    sizeof: () => 40,
    load: () => ({
      func: (signature: string) => {
        if (signature.includes('GetAsyncKeyState')) return api.keyState;
        if (signature.includes('GetSystemMetrics')) return api.metrics;
        if (signature.includes('SHQueryUserNotificationState')) return api.notification;
        if (signature.includes('GetForegroundWindow')) return () => api.foreground;
        if (signature.includes('GetClassNameW'))
          return (_w: number, b: Buffer, max: number) => text(b, api.windowClass, max);
        if (signature.includes('GetWindowRect'))
          return (_w: number, r: Rect) => (Object.assign(r, api.windowRect), true);
        if (signature.includes('MonitorFromWindow')) return () => api.foregroundMonitor;
        if (signature.includes('MonitorFromPoint'))
          return (point: { x: number; y: number }) => {
            api.monitorPoints.push(point);
            return api.catMonitor;
          };
        if (signature.includes('GetMonitorInfoW'))
          return (_m: number, info: { rcMonitor: Rect }) => {
            info.rcMonitor = { ...api.monitorRect };
            return true;
          };
        if (signature.includes('GetWindowThreadProcessId'))
          return (_w: number, pid: number[]) => ((pid[0] = 42), 1);
        if (signature.includes('OpenProcess')) return () => 7;
        if (signature.includes('QueryFullProcessImageNameW'))
          return (_h: number, _f: number, b: Buffer, size: number[]) => {
            size[0] = text(b, api.process, 1024);
            return true;
          };
        if (signature.includes('CloseHandle')) return () => true;
        throw new Error(signature);
      },
    }),
  },
}));

import { createWindowsPlatform } from './index';

beforeEach(() => {
  vi.resetAllMocks();
  api.keyState.mockReturnValue(0);
  api.metrics.mockReturnValue(0);
  api.notification.mockImplementation((state) => {
    state[0] = 5;
    return 0;
  });
  api.foreground = 100;
  api.windowClass = 'Chrome_WidgetWin_1';
  api.windowRect = { left: 0, top: 0, right: 2880, bottom: 1800 };
  api.monitorRect = { left: 0, top: 0, right: 2880, bottom: 1800 };
  api.process = String.raw`C:\Games\game.exe`;
  api.foregroundMonitor = 1;
  api.catMonitor = 1;
  api.dipToScreenPoint.mockImplementation((point) => point);
  api.monitorPoints = [];
});

const cat = { x: 100, y: 100 };

const busy = (): void => {
  api.notification.mockImplementation((state) => {
    state[0] = 2;
    return 0;
  });
};

describe('Windows 桌面层系统状态', () => {
  it.each([2, 3, 4])('状态 %i 且前台真的全屏时要隐藏桌面层，避免打扰全屏程序或演示', (value) => {
    api.notification.mockImplementation((state) => {
      state[0] = value;
      return 0;
    });
    expect(createWindowsPlatform().isFullscreen(cat)).toBe(true);
  });

  it('系统报告忙碌，但前台窗口没盖满屏幕（比如 NVIDIA 悬浮层常驻）：不隐藏猫', () => {
    busy();
    api.windowRect = { left: 0, top: 0, right: 1920, bottom: 1728 };
    expect(createWindowsPlatform().isFullscreen(cat)).toBe(false);
  });

  it('前台是白名单里的程序时，即使盖满屏幕也不隐藏猫', () => {
    busy();
    api.process = String.raw`C:\Program Files\NVIDIA Corporation\NVIDIA App\CEF\NVIDIA Overlay.exe`;
    expect(createWindowsPlatform().isFullscreen(cat)).toBe(false);
  });

  it.each(['Progman', 'WorkerW', 'Shell_TrayWnd'])('前台是桌面或任务栏（%s）时不算全屏', (name) => {
    busy();
    api.windowClass = name;
    expect(createWindowsPlatform().isFullscreen(cat)).toBe(false);
  });

  it('猫在副屏、副屏上开着全屏窗口：按副屏的大小核对，要隐藏', () => {
    busy();
    api.monitorRect = { left: -1920, top: 0, right: 0, bottom: 1080 };
    api.windowRect = { left: -1920, top: 0, right: 0, bottom: 1080 };
    expect(createWindowsPlatform().isFullscreen(cat)).toBe(true);
  });

  it('全屏窗口在另一块显示器上（比如副屏放全屏视频）：猫不藏', () => {
    busy();
    api.foregroundMonitor = 2;
    api.catMonitor = 1;
    expect(createWindowsPlatform().isFullscreen(cat)).toBe(false);
  });

  it('猫所在的那块屏幕上开着全屏窗口：要藏', () => {
    busy();
    api.foregroundMonitor = 2;
    api.catMonitor = 2;
    expect(createWindowsPlatform().isFullscreen(cat)).toBe(true);
  });

  it('按缩放把 Electron 坐标换成系统的物理像素再问是哪块屏幕', () => {
    busy();
    api.dipToScreenPoint.mockImplementation(({ x, y }) => ({ x: x * 1.5, y: y * 1.5 + 0.4 }));
    createWindowsPlatform().isFullscreen({ x: 2000, y: 300 });
    expect(api.dipToScreenPoint).toHaveBeenCalledWith({ x: 2000, y: 300 });
    expect(api.monitorPoints).toEqual([{ x: 3000, y: 450 }]);
  });

  it('独占全屏和演示模式不再核对前台窗口，一律隐藏（系统不说是哪块屏幕）', () => {
    api.windowRect = { left: 0, top: 0, right: 100, bottom: 100 };
    api.foregroundMonitor = 2;
    for (const value of [3, 4]) {
      api.notification.mockImplementation((state) => {
        state[0] = value;
        return 0;
      });
      expect(createWindowsPlatform().isFullscreen(cat)).toBe(true);
    }
  });

  it.each([1, 5, 6, 7])('状态 %i 不是全屏，不应因此隐藏猫', (value) => {
    api.notification.mockImplementation((state) => {
      state[0] = value;
      return 0;
    });
    expect(createWindowsPlatform().isFullscreen(cat)).toBe(false);
  });

  it('查询失败必须显式报错，避免误报没有全屏', () => {
    api.notification.mockReturnValue(-2147467259);
    expect(() => createWindowsPlatform().isFullscreen(cat)).toThrow('HRESULT 0x80004005');
  });

  it.each([0x8000, -32768, -32767])('Ctrl 当前按下值 %i 能触发幽灵模式', (state) => {
    api.keyState.mockReturnValue(state);
    expect(createWindowsPlatform().isCtrlDown()).toBe(true);
    expect(api.keyState).toHaveBeenCalledWith(0x11);
  });

  it.each([0, 1])('Ctrl 已松开时值 %i 不能继续算作按住', (state) => {
    api.keyState.mockReturnValue(state);
    expect(createWindowsPlatform().isCtrlDown()).toBe(false);
  });

  it('拖动兜底只看主按钮，并能跟随运行中交换左右键的设置', () => {
    const platform = createWindowsPlatform();
    api.keyState.mockImplementation((key) => (key === 0x01 ? -32768 : 0));
    expect(platform.isLeftButtonDown()).toBe(true);
    api.metrics.mockReturnValue(1);
    expect(platform.isLeftButtonDown()).toBe(false);
    api.keyState.mockImplementation((key) => (key === 0x02 ? -32768 : 0));
    expect(platform.isLeftButtonDown()).toBe(true);
    api.metrics.mockReturnValue(0);
    expect(platform.isLeftButtonDown()).toBe(false);
    expect(api.metrics).toHaveBeenCalledWith(23);
  });

  it('主按钮已松开但最近按过，也必须让拖动兜底判定为松手', () => {
    api.keyState.mockReturnValue(1);
    expect(createWindowsPlatform().isLeftButtonDown()).toBe(false);
  });
});
