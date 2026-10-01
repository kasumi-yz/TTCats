import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  keyState: vi.fn<(key: number) => number>(),
  metrics: vi.fn<(index: number) => number>(),
  notification: vi.fn<(state: number[]) => number>(),
}));

vi.mock('koffi', () => ({
  default: {
    load: () => ({
      func: (signature: string) => {
        if (signature.includes('GetAsyncKeyState')) return api.keyState;
        if (signature.includes('GetSystemMetrics')) return api.metrics;
        if (signature.includes('SHQueryUserNotificationState')) return api.notification;
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
});

describe('Windows 桌面层系统状态', () => {
  it.each([2, 3, 4])('状态 %i 要隐藏桌面层，避免打扰全屏程序或演示', (value) => {
    api.notification.mockImplementation((state) => {
      state[0] = value;
      return 0;
    });
    expect(createWindowsPlatform().isFullscreen()).toBe(true);
  });

  it.each([1, 5, 6, 7])('状态 %i 不是全屏，不应因此隐藏猫', (value) => {
    api.notification.mockImplementation((state) => {
      state[0] = value;
      return 0;
    });
    expect(createWindowsPlatform().isFullscreen()).toBe(false);
  });

  it('查询失败必须显式报错，避免误报没有全屏', () => {
    api.notification.mockReturnValue(-2147467259);
    expect(() => createWindowsPlatform().isFullscreen()).toThrow('HRESULT 0x80004005');
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
