import { beforeEach, describe, expect, it, vi } from 'vitest';

interface SentInput {
  type: number;
  u: {
    mi?: { dx: number; dy: number; dwFlags: number };
    ki?: { wVk: number; wScan: number; dwFlags: number };
  };
}

const api = vi.hoisted(() => ({
  sent: [] as SentInput[],
  metrics: vi.fn<(index: number) => number>(),
  getWindow: vi.fn<(window: number, command: number) => number>(),
}));

vi.mock('koffi', () => ({
  default: {
    struct: () => ({}),
    union: () => ({}),
    sizeof: () => 40,
    load: () => ({
      func: (signature: string) => {
        if (signature.includes('SendInput'))
          return (_count: number, value: SentInput) => {
            api.sent.push(value);
            return 1;
          };
        if (signature.includes('GetSystemMetrics')) return api.metrics;
        if (signature.includes('GetWindow(')) return api.getWindow;
        return () => 0;
      },
    }),
  },
}));

import { createTestInput, toAbsolute } from './test-input';

beforeEach(() => {
  api.sent = [];
  api.metrics.mockReset();
  api.getWindow.mockReset();
});

describe('交互测试的模拟输入', () => {
  it('物理像素换成整个虚拟桌面的 0～65535 绝对坐标', () => {
    expect(toAbsolute(0, 0, 2880)).toBe(0);
    expect(toAbsolute(2879, 0, 2880)).toBe(65535);
    // 副屏在主屏左边时虚拟桌面原点是负数
    expect(toAbsolute(0, -1920, 4800)).toBe(Math.round((1920 * 65535) / 4799));
  });

  it('鼠标移动发绝对坐标，按虚拟桌面的位置和大小换算', () => {
    api.metrics.mockImplementation((index) => ({ 76: 0, 77: 0, 78: 2880, 79: 1800 })[index] ?? 0);
    createTestInput().mouseMove(1440, 900);
    const mi = api.sent[0]?.u.mi;
    expect(mi?.dwFlags).toBe(0x8000 | 0x4000 | 0x1);
    expect(mi?.dx).toBe(toAbsolute(1440, 0, 2880));
    expect(mi?.dy).toBe(toAbsolute(900, 0, 1800));
  });

  it('交换左右键后，主按钮改发物理右键，右键菜单改发物理左键', () => {
    api.metrics.mockReturnValue(0);
    const input = createTestInput();
    input.mouseButton(true);
    input.mouseButton(false, 'secondary');
    api.metrics.mockImplementation((index) => (index === 23 ? 1 : 0));
    input.mouseButton(true);
    input.mouseButton(true, 'secondary');
    expect(api.sent.map((s) => s.u.mi?.dwFlags)).toEqual([0x2, 0x10, 0x8, 0x2]);
  });

  it('打字按 Unicode 字符逐个按下松开，不依赖键盘布局', () => {
    createTestInput().typeText('a喵');
    expect(api.sent.map((s) => [s.u.ki?.wScan, s.u.ki?.dwFlags])).toEqual([
      [97, 0x4],
      [97, 0x6],
      [0x55b5, 0x4],
      [0x55b5, 0x6],
    ]);
  });

  it('Z 序：沿着上一个窗口往上找', () => {
    const chain = new Map([
      [30, 20],
      [20, 10],
      [10, 0],
    ]);
    api.getWindow.mockImplementation((window) => chain.get(window) ?? 0);
    const input = createTestInput();
    expect(input.isAbove(10, 30)).toBe(true);
    expect(input.isAbove(30, 10)).toBe(false);
  });
});
