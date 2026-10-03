import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WindowRect } from '../types';

interface NativeWindow {
  id: number;
  pid: number;
  bounds: WindowRect;
  className: string;
  visible: boolean;
  minimized: boolean;
  maximized: boolean;
  cloaked: boolean;
  awareness: number;
  exStyle: number;
  alpha: number;
}

const state = vi.hoisted(() => ({
  windows: [] as NativeWindow[],
  context: vi.fn<(context: number | bigint) => number | bigint>(),
  dwmFailure: false,
  titlebarAvailable: true,
  titlebarWidth: 220,
  hitTestAvailable: false,
  hits: vi.fn<(x: number, y: number) => number>(),
}));

vi.mock('koffi', () => ({
  default: {
    struct: () => ({}),
    array: () => ({}),
    proto: () => ({}),
    sizeof: () => 140,
    decode: (buffer: Buffer) => ({
      left: buffer.readInt32LE(0),
      top: buffer.readInt32LE(4),
      right: buffer.readInt32LE(8),
      bottom: buffer.readInt32LE(12),
    }),
    load: () => ({
      func(signature: string) {
        const target = (id: bigint): NativeWindow => {
          const w = state.windows.find((w) => BigInt(w.id) === id);
          if (!w) throw new Error('测试窗口不存在');
          return w;
        };
        if (signature.includes('SetThreadDpi')) return state.context;
        if (signature.includes('EnumWindows'))
          return (callback: (id: number) => boolean) => {
            [...state.windows].reverse().forEach((w) => callback(w.id));
            return true;
          };
        if (signature.includes('GetTopWindow')) return () => state.windows[0]?.id ?? 0;
        if (signature.includes('GetWindow('))
          return (id: bigint) =>
            state.windows[state.windows.findIndex((w) => BigInt(w.id) === id) + 1]?.id ?? 0;
        if (signature.includes('IsWindow('))
          return (id: bigint) => state.windows.some((w) => BigInt(w.id) === id);
        if (signature.includes('IsWindowVisible')) return (id: bigint) => target(id).visible;
        if (signature.includes('IsIconic')) return (id: bigint) => target(id).minimized;
        if (signature.includes('IsZoomed')) return (id: bigint) => target(id).maximized;
        if (signature.includes('GetWindowThreadProcessId'))
          return (id: bigint, pid: number[]) => {
            pid[0] = target(id).pid;
            return 1;
          };
        if (signature.includes('GetClassNameW'))
          return (id: bigint, buffer: Buffer) => {
            buffer.write(target(id).className, 'utf16le');
            return target(id).className.length;
          };
        if (signature.includes('GetWindowLongPtrW')) return (id: bigint) => target(id).exStyle;
        if (signature.includes('GetWindowRect'))
          return (id: bigint, rect: WindowRect) => {
            Object.assign(rect, target(id).bounds);
            return true;
          };
        if (signature.includes('GetDpiForWindow'))
          return (id: bigint) => (target(id).awareness === 0 ? 96 : 144);
        if (signature.includes('GetWindowDpiAwarenessContext'))
          return (id: bigint) => target(id).awareness;
        if (signature.includes('GetAwarenessFrom')) return (context: number) => context;
        if (signature.includes('DwmGetWindowAttribute'))
          return (id: bigint, attribute: number, buffer: Buffer) => {
            if (state.dwmFailure && attribute === 14) return -1;
            const w = target(id);
            if (attribute === 14) buffer.writeUInt32LE(w.cloaked ? 1 : 0);
            else {
              const rect =
                attribute === 9
                  ? w.bounds
                  : {
                      left: w.bounds.right - w.bounds.left - 220,
                      top: 0,
                      right: w.bounds.right - w.bounds.left,
                      bottom: 45,
                    };
              [rect.left, rect.top, rect.right, rect.bottom].forEach((value, index) =>
                buffer.writeInt32LE(value, index * 4),
              );
            }
            return 0;
          };
        if (signature.includes('GetLayeredWindowAttributes'))
          return (id: bigint, _key: number[], alpha: number[], flags: number[]) => {
            alpha[0] = target(id).alpha;
            flags[0] = 2;
            return true;
          };
        if (signature.includes('SendMessageTimeoutW') && !signature.includes('LedgeTitlebarInfo'))
          return (
            _id: bigint,
            _message: number,
            _parameter: number,
            coordinates: number,
            _flags: number,
            _timeout: number,
            result: number[],
          ) => {
            const x = (coordinates << 16) >> 16,
              y = coordinates >> 16;
            result[0] = state.hitTestAvailable ? state.hits(x, y) : 1;
            return 1;
          };
        if (signature.includes('SendMessageTimeoutW'))
          return (
            id: bigint,
            _message: number,
            _parameter: number,
            info: { rgrect: WindowRect[]; rgstate: number[] },
          ) => {
            if (!state.titlebarAvailable) return 0;
            const w = target(id);
            info.rgrect[2] = {
              left: w.bounds.right - state.titlebarWidth,
              top: w.bounds.top,
              right: w.bounds.right,
              bottom: w.bounds.top + 45,
            };
            return 1;
          };
        throw new Error(signature);
      },
    }),
  },
}));

import { readWindows } from './windows';

beforeEach(() => {
  vi.stubGlobal('process', { ...process, platform: 'win32' });
  state.windows = [
    {
      id: 1,
      pid: 42,
      className: 'Notepad',
      bounds: { left: 300, top: 300, right: 1500, bottom: 900 },
      visible: true,
      minimized: false,
      maximized: false,
      cloaked: false,
      awareness: 2,
      exStyle: 0,
      alpha: 255,
    },
  ];
  state.context.mockReset().mockReturnValue(-4);
  state.dwmFailure = false;
  state.titlebarAvailable = true;
  state.titlebarWidth = 220;
  state.hitTestAvailable = false;
  state.hits.mockReset();
});
afterEach(() => vi.unstubAllGlobals());
const monitorBounds = { left: 0, top: 0, right: 2880, bottom: 1800 };
const monitors = [{ bounds: monitorBounds, scaleFactor: 1.5 }];
function firstWindow(): NativeWindow {
  const w = state.windows[0];
  if (!w) throw new Error('测试窗口不存在');
  return w;
}

describe('正式 Windows 窗口读取', () => {
  it('返回物理边界和 DPI 感知方式，调用后恢复线程环境', () => {
    const [window] = readWindows(monitors);
    expect(window).toMatchObject({
      eligible: true,
      bounds: state.windows[0]?.bounds,
      windowDpi: 144,
      dpiAwareness: 'per-monitor',
      buttonsSource: 'titlebar',
      buttons: { left: 1280, right: 1500, top: 300, bottom: 345 },
    });
    expect(state.context.mock.calls).toEqual([[-4], [-4]]);
  });
  it('Per-Monitor 窗口也优先绝对坐标，避免记事本 DWM 多扣左端空白', () => {
    state.titlebarWidth = 212;
    expect(readWindows(monitors)[0]).toMatchObject({
      buttonsSource: 'titlebar',
      buttons: { left: 1288, right: 1500, top: 300, bottom: 345 },
    });
    state.titlebarAvailable = false;
    expect(readWindows(monitors)[0]).toMatchObject({
      buttonsSource: 'dwm',
      buttons: { left: 1280, right: 1500, top: 300, bottom: 345 },
    });
  });
  it('老程序使用标题栏绝对屏幕坐标，220 像素不能变成 330 像素', () => {
    firstWindow().awareness = 0;
    expect(readWindows(monitors)[0]).toMatchObject({
      eligible: true,
      windowDpi: 96,
      dpiAwareness: 'unaware',
      buttonsSource: 'titlebar',
      buttons: { left: 1280, right: 1500, top: 300, bottom: 345 },
    });
    state.titlebarAvailable = false;
    expect(readWindows(monitors)[0]).toMatchObject({
      eligible: false,
      occludes: true,
      reason: 'buttons-unavailable',
    });
  });
  it('自绘按钮按实际命中区校正，移动只平移缓存，调整大小立即重新核对', () => {
    firstWindow().id = 77;
    state.hitTestAvailable = true;
    state.hits.mockImplementation((x, y) =>
      y >= 302 && y < 360 && x >= 1295 && x < 1490 ? (x < 1430 ? 8 : 20) : 1,
    );
    expect(readWindows(monitors)[0]).toMatchObject({
      buttonsSource: 'hit-test',
      buttons: { left: 1295, top: 302, right: 1490, bottom: 360 },
    });
    state.hits.mockClear();
    const w = firstWindow();
    w.bounds = { left: 320, top: 300, right: 1520, bottom: 900 };
    expect(readWindows(monitors)[0]?.buttons?.left).toBe(1315);
    expect(state.hits).not.toHaveBeenCalled();
    w.bounds.right = 1600;
    readWindows(monitors);
    expect(state.hits).toHaveBeenCalled();
  });
  it('DPI 不感知的标准窗口也校正横向范围，不能把系统标题栏较宽的矩形当作实际按钮', () => {
    const w = firstWindow();
    w.id = 78;
    w.awareness = 0;
    state.hitTestAvailable = true;
    state.hits.mockImplementation((x, y) =>
      y >= 312 && y < 345 && x >= 1344 && x < 1499 ? (x < 1440 ? 8 : 20) : 1,
    );
    expect(readWindows(monitors)[0]).toMatchObject({
      dpiAwareness: 'unaware',
      buttonsSource: 'hit-test',
      buttons: { left: 1344, top: 312, right: 1499, bottom: 345 },
    });
  });
  it.each(['minimized', 'cloaked', 'visible'] as const)('%s 状态禁止站立及遮挡', (field) => {
    firstWindow()[field] = field !== 'visible';
    expect(readWindows(monitors)[0]).toMatchObject({ eligible: false, occludes: false });
  });
  it('工具窗口、太小、最大化、全屏不站猫，但有实体的仍然遮挡', () => {
    const original = firstWindow();
    for (const patch of [
      { exStyle: 0x80 },
      { maximized: true },
      { bounds: { left: 100, top: 100, right: 200, bottom: 200 } },
      { bounds: monitorBounds },
    ]) {
      state.windows[0] = { ...original, ...patch };
      expect(readWindows(monitors)[0]).toMatchObject({ eligible: false, occludes: true });
    }
  });
  it('Codex 穿透透明层、全透明层不参与遮挡，普通不透明工具窗口仍挡住下面', () => {
    firstWindow().exStyle = 0x80000 | 0x20 | 0x80;
    expect(readWindows(monitors)[0]).toMatchObject({ reason: 'transparent', occludes: false });
    firstWindow().exStyle = 0x80000 | 0x80;
    firstWindow().alpha = 0;
    expect(readWindows(monitors)[0]).toMatchObject({ reason: 'transparent', occludes: false });
    firstWindow().alpha = 255;
    expect(readWindows(monitors)[0]).toMatchObject({ reason: 'tool', occludes: true });
  });
  it('自己的窗口完全排除，避免桌面层把所有窗口顶边挡住', () => {
    firstWindow().pid = process.pid;
    expect(readWindows(monitors)).toEqual([]);
  });
  it('查询与恢复同时失败要保留两个错误，不能由 finally 掩盖根因', () => {
    state.dwmFailure = true;
    state.context.mockReturnValueOnce(-4).mockReturnValueOnce(0);
    let failure: unknown;
    try {
      readWindows(monitors);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(2);
    expect(String((failure as AggregateError).errors[0])).toContain('系统隐藏状态');
  });
});
