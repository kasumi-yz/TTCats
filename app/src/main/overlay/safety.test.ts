import { describe, expect, it } from 'vitest';
import { OverlaySafety, type SafetyInput } from './safety';
const input = (now: number, patch: Partial<SafetyInput> = {}): SafetyInput => ({
  now,
  inside: true,
  leftDown: false,
  ctrlDown: false,
  paused: false,
  ...patch,
});

describe('桌面层主进程兜底', () => {
  it('桌面层卡死不续租时，120ms 恢复穿透，不依赖 mouseleave', () => {
    const safety = new OverlaySafety();
    safety.receive({ type: 'hover', onCat: true }, input(0));
    expect(safety.poll(input(119)).ignore).toBe(false);
    expect(safety.poll(input(120)).ignore).toBe(true);
  });
  it('离开工作区即使租约仍在也穿透；区域外的续租无效', () => {
    const safety = new OverlaySafety();
    safety.receive({ type: 'hover', onCat: true }, input(0));
    expect(safety.poll(input(1, { inside: false })).ignore).toBe(true);
    safety.receive({ type: 'hover', onCat: true }, input(2, { inside: false }));
    expect(safety.poll(input(3)).ignore).toBe(true);
  });
  it('拖动时即使移出猫和窗口、租约过期、按 Ctrl 也不丢猫', () => {
    const safety = new OverlaySafety();
    safety.receive({ type: 'drag', active: true }, input(0, { leftDown: true }));
    expect(safety.poll(input(1000, { inside: false, leftDown: true, ctrlDown: true }))).toEqual({
      ignore: false,
      ghost: true,
      cancel: false,
      clickThrough: false,
    });
  });
  it('松手事件丢失时由系统左键状态在60ms后结束拖动', () => {
    const safety = new OverlaySafety();
    safety.receive({ type: 'drag', active: true }, input(0, { leftDown: true }));
    expect(safety.poll(input(1)).ignore).toBe(false);
    expect(safety.poll(input(61))).toEqual({
      ignore: true,
      ghost: false,
      cancel: true,
      clickThrough: false,
    });
  });
  it('系统查询过渡的单次松手不终止仍然按着的拖动', () => {
    const safety = new OverlaySafety();
    safety.receive({ type: 'drag', active: true }, input(0, { leftDown: true }));
    safety.poll(input(10));
    expect(safety.poll(input(30, { leftDown: true })).cancel).toBe(false);
    expect(safety.poll(input(90, { leftDown: true })).ignore).toBe(false);
  });
  it('松开 Ctrl 后延长两秒，不能接受幽灵模式中的新拖动', () => {
    const safety = new OverlaySafety();
    expect(safety.poll(input(0, { ctrlDown: true })).ghost).toBe(true);
    safety.poll(input(20));
    safety.receive({ type: 'drag', active: true }, input(100, { leftDown: true }));
    expect(safety.poll(input(2019, { leftDown: true })).ignore).toBe(true);
    expect(safety.poll(input(2020)).ghost).toBe(false);
  });
  it('全屏暂停强制释放拖动和鼠标', () => {
    const safety = new OverlaySafety();
    safety.receive({ type: 'drag', active: true }, input(0, { leftDown: true }));
    expect(safety.poll(input(10, { leftDown: true, paused: true }))).toEqual({
      ignore: true,
      ghost: false,
      cancel: true,
      clickThrough: false,
    });
  });
});

describe('穿透点击只观察左键边沿', () => {
  it('按住不重复，松开后再按才发下一次；启动时按住不补发', () => {
    const safety = new OverlaySafety();
    expect(safety.poll(input(0, { leftDown: true })).clickThrough).toBe(false);
    safety.poll(input(20));
    expect(safety.poll(input(40, { leftDown: true })).clickThrough).toBe(true);
    expect(safety.poll(input(60, { leftDown: true })).clickThrough).toBe(false);
    safety.poll(input(80));
    expect(safety.poll(input(100, { leftDown: true })).clickThrough).toBe(true);
  });

  it.each([{ inside: false }, { paused: true }])(
    '窗口外或暂停时按下，进入后仍按住也不补发：%j',
    (patch) => {
      const safety = new OverlaySafety();
      safety.poll(input(0));
      expect(safety.poll(input(20, { ...patch, leftDown: true })).clickThrough).toBe(false);
      expect(safety.poll(input(40, { leftDown: true })).clickThrough).toBe(false);
    },
  );

  it('命中猫的租约和恢复穿透的那轮不误报，幽灵模式仍计数', () => {
    const safety = new OverlaySafety();
    safety.poll(input(0));
    safety.receive({ type: 'hover', onCat: true }, input(0));
    expect(safety.poll(input(20, { leftDown: true })).clickThrough).toBe(false);
    safety.poll(input(40));
    expect(safety.poll(input(140, { leftDown: true }), false).clickThrough).toBe(false);
    safety.poll(input(160, { ctrlDown: true }));
    expect(safety.poll(input(180, { ctrlDown: true, leftDown: true })).clickThrough).toBe(true);
  });

  it('拖动中的短暂松手和再次按下不当成穿透点击', () => {
    const safety = new OverlaySafety();
    safety.poll(input(0));
    safety.receive({ type: 'drag', active: true }, input(20, { leftDown: true }));
    expect(safety.poll(input(20, { leftDown: true, ctrlDown: true })).clickThrough).toBe(false);
    safety.poll(input(40));
    expect(safety.poll(input(60, { leftDown: true })).clickThrough).toBe(false);
  });
});
