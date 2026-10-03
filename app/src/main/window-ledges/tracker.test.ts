import { afterEach, describe, expect, it, vi } from 'vitest';
import { windowInfo } from './test-windows';
import { createWindowLedgeTracker, type WindowLedgeUpdate } from './tracker';

afterEach(() => vi.useRealTimers());

function setup() {
  vi.useFakeTimers();
  const readWindows = vi.fn(() => [windowInfo()]);
  const updates: WindowLedgeUpdate[] = [];
  const onError = vi.fn();
  const tracker = createWindowLedgeTracker({
    readWindows,
    screen: () => ({ workArea: { left: 0, top: 0, right: 1920, bottom: 1040 }, scaleFactor: 1.5 }),
    onUpdate: (update) => updates.push(update),
    onError,
    now: () => Date.now(),
  });
  return { tracker, readWindows, updates, onError };
}

describe('窗口顶边读取频率和窗口变化', () => {
  it('地板模式零读取；无猫站顶边只每秒读一次，站上去后立即提速', () => {
    const { tracker, readWindows } = setup();
    vi.advanceTimersByTime(10000);
    expect(readWindows).not.toHaveBeenCalled();
    tracker.setMode(true);
    expect(readWindows).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(999);
    expect(readWindows).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(readWindows).toHaveBeenCalledTimes(2);
    tracker.setMode(true, true);
    vi.advanceTimersByTime(33);
    expect(readWindows).toHaveBeenCalledTimes(4);
    tracker.setMode(false);
    vi.advanceTimersByTime(10000);
    expect(readWindows).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('位移按实际经过的时间和桌面层缩放输出，堵塞后不能伪装成一个固定帧', () => {
    const { tracker, readWindows, updates } = setup();
    tracker.setMode(true, true);
    readWindows.mockReturnValue([
      windowInfo('target', { bounds: { left: 250, top: 230, right: 1150, bottom: 630 } }),
    ]);
    vi.setSystemTime(Date.now() + 500);
    vi.advanceTimersByTime(33);
    expect(updates.at(-1)?.moved).toEqual([{ id: 'target', dx: 100, dy: 20, elapsedMs: 533 }]);
  });
  it.each(['minimized', 'maximized', 'cloaked', 'fullscreen'])(
    '窗口变成 %s 时通知不能再站，关闭也要通知',
    (reason) => {
      const { tracker, readWindows, updates } = setup();
      tracker.setMode(true, true);
      readWindows.mockReturnValue([windowInfo('target', { eligible: false, reason })]);
      vi.advanceTimersByTime(33);
      expect(updates.at(-1)?.unavailable).toEqual([{ id: 'target', reason }]);
      expect(updates.at(-1)?.ledges.windows).toEqual([]);
      readWindows.mockReturnValue([windowInfo()]);
      tracker.refresh();
      readWindows.mockReturnValue([]);
      vi.advanceTimersByTime(33);
      expect(updates.at(-1)?.unavailable).toEqual([{ id: 'target', reason: 'closed' }]);
    },
  );
  it('句柄被别的进程复用时不能把新窗口当成旧窗口的移动', () => {
    const { tracker, readWindows, updates } = setup();
    tracker.setMode(true, true);
    readWindows.mockReturnValue([
      windowInfo('target', { pid: 2, bounds: { left: 400, top: 200, right: 1300, bottom: 600 } }),
    ]);
    vi.advanceTimersByTime(33);
    expect(updates.at(-1)?.moved).toEqual([]);
    expect(updates.at(-1)?.unavailable).toEqual([{ id: 'target', reason: 'closed' }]);
  });
  it('系统查询失败清掉旧顶边并报错，下次可以恢复；关闭后不遗留定时器', () => {
    const { tracker, readWindows, updates, onError } = setup();
    tracker.setMode(true, true);
    readWindows.mockImplementationOnce(() => {
      throw new Error('系统查询失败');
    });
    vi.advanceTimersByTime(33);
    expect(updates.at(-1)?.ledges.windows).toEqual([]);
    expect(updates.at(-1)?.unavailable).toEqual([{ id: 'target', reason: 'query-failed' }]);
    expect(onError).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(33);
    expect(updates.at(-1)?.ledges.windows).not.toEqual([]);
    tracker.dispose();
    vi.advanceTimersByTime(10000);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('窗口已跨出左边界后继续移动，完整边界与位移不被可站段的裁剪吞掉', () => {
    const { tracker, readWindows, updates } = setup();
    readWindows.mockReturnValue([
      windowInfo('target', {
        bounds: { left: -150, top: 200, right: 750, bottom: 600 },
        buttons: null,
      }),
    ]);
    tracker.setMode(true, true);
    const first = updates.at(-1);
    expect(first?.ledges.at).toBe(Date.now());
    expect(first?.ledges.windows[0]).toMatchObject({
      left: -100,
      right: 500,
      segments: [{ left: 0, right: 500 }],
    });
    readWindows.mockReturnValue([
      windowInfo('target', {
        bounds: { left: -300, top: 200, right: 600, bottom: 600 },
        buttons: null,
      }),
    ]);
    vi.advanceTimersByTime(33);
    expect(updates.at(-1)?.ledges.windows[0]).toMatchObject({
      left: -200,
      right: 400,
      segments: [{ left: 0, right: 400 }],
    });
    expect(updates.at(-1)?.moved).toEqual([{ id: 'target', dx: -100, dy: 0, elapsedMs: 33 }]);
    expect((updates.at(-1)?.ledges.at ?? 0) - (first?.ledges.at ?? 0)).toBe(33);
  });
});
