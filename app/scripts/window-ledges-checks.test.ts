import { afterEach, expect, it, vi } from 'vitest';
import { captionCaptureMethod, createCheckLog, movementProbe } from './window-ledges-checks';

afterEach(() => vi.useRealTimers());

it('首个应用或 CPU 阶段失败也保留数据并继续其余项目，最后的 CPU 阶段不能丢失', async () => {
  const saved: unknown[] = [];
  const log = createCheckLog(() => saved.push(structuredClone(log.entries)));
  for (const name of ['CPU floor', 'CPU idle', 'CPU occupied', '记事本', '老程序', 'Legacy']) {
    await log.run(name, () => {
      if (name === 'CPU floor' || name === '老程序') throw new Error(name);
    });
  }
  expect(log.entries.map((e) => [e.name, e.status])).toEqual([
    ['CPU floor', 'failed'],
    ['CPU idle', 'passed'],
    ['CPU occupied', 'passed'],
    ['记事本', 'passed'],
    ['老程序', 'failed'],
    ['Legacy', 'passed'],
  ]);
  expect(saved).toHaveLength(6);
  expect(saved.at(-1)).toEqual(log.entries);
});

it('旧程序即使与显示器同为 96 DPI 也用屏幕，跨缩放的系统感知窗口不能用 PrintWindow', () => {
  expect(captionCaptureMethod({ dpiAwareness: 'unaware', windowDpi: 96 }, 1)).toBe('screen');
  expect(captionCaptureMethod({ dpiAwareness: 'unaware', windowDpi: 96 }, 1.5)).toBe('screen');
  expect(captionCaptureMethod({ dpiAwareness: 'system', windowDpi: 144 }, 1)).toBe('screen');
  expect(captionCaptureMethod({ dpiAwareness: 'per-monitor', windowDpi: 144 }, 1)).toBe('screen');
  expect(captionCaptureMethod({ dpiAwareness: 'per-monitor', windowDpi: 144 }, 1.5)).toBe(
    'PrintWindow',
  );
});

it('记录回调时刻，不把 Promise 等待及后续调度时间混入跟随延迟', async () => {
  vi.useFakeTimers();
  let at = 100;
  const probe = movementProbe(() => at);
  const result = probe.move('7', () => {});
  at = 133;
  probe.update({
    at: 130,
    windows: [],
    ledges: [],
    unavailable: [],
    moved: [{ id: '7', dx: 20, dy: 0, elapsedMs: 46 }],
  });
  at = 200;
  expect(await result).toBe(33);
  probe.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

it('其他窗口的更新不冒充本次移动；超时计为失败且清除等待', async () => {
  vi.useFakeTimers();
  const probe = movementProbe(() => 100);
  const result = probe.move('7', () => {});
  const assertion = expect(result).rejects.toThrow('500 ms');
  probe.update({
    at: 100,
    windows: [],
    ledges: [],
    unavailable: [],
    moved: [{ id: '8', dx: 20, dy: 0, elapsedMs: 46 }],
  });
  await vi.advanceTimersByTimeAsync(500);
  await assertion;
  expect(vi.getTimerCount()).toBe(0);
  probe.dispose();
});
