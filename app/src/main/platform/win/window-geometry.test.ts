import { describe, expect, it } from 'vitest';
import { captionButtonsMatch, hitTestButtons, titlebarButtons } from './window-geometry';
import { windowsInZOrder } from './windows';

const outer = { left: 2260, top: 750, right: 2847, bottom: 1125 };
const reference = { left: 2619, top: 750, right: 2839, bottom: 795 };
const empty = { left: 0, top: 0, right: 0, bottom: 0 };

describe('标题栏按钮的独立核对', () => {
  it('自绘标题栏的范围不能沿用系统默认值，二分结果核对影响可站顶边的左右边缘', () => {
    const outer = { left: 180, top: 360, right: 1380, bottom: 960 };
    const hint = { left: 1150, top: 360, right: 1370, bottom: 404 };
    const actual = { left: 1165, top: 362, right: 1370, bottom: 420 };
    let calls = 0;
    const hit = (x: number, y: number): number => {
      calls++;
      if (x < actual.left || x >= actual.right || y < actual.top || y >= actual.bottom) return 1;
      return x < 1300 ? 8 : 20;
    };
    const result = hitTestButtons(outer, hint, hit);
    expect(result).toEqual(actual);
    expect(captionButtonsMatch(hint, actual)).toBe(false);
    expect(captionButtonsMatch(result, actual)).toBe(true);
    expect(calls).toBeLessThan(50);
    expect(hitTestButtons(outer, hint, () => null)).toBeNull();
    expect(hitTestButtons(outer, hint, () => 1)).toBeNull();
    let timedCalls = 0;
    expect(hitTestButtons(outer, hint, () => (++timedCalls === 1 ? 20 : null))).toBeNull();
    expect(timedCalls).toBe(2);
  });
  it('150% 下老程序的物理宽高只用一次，不能重复放大', () => {
    const rectangles = [
      empty,
      empty,
      { left: 2619, top: 750, right: 2692, bottom: 795 },
      { left: 2692, top: 750, right: 2765, bottom: 795 },
      empty,
      { left: 2765, top: 750, right: 2839, bottom: 795 },
    ];
    expect(titlebarButtons(rectangles, [0, 0, 0, 0, 0x8000, 0], outer)).toEqual(reference);
  });
  it('原检查即使夹住右端也不能证明正确，新检查会拒绝多扣 115 像素', () => {
    expect(captionButtonsMatch({ left: 2504, top: 750, right: 2839, bottom: 818 }, reference)).toBe(
      false,
    );
    expect(captionButtonsMatch(reference, reference)).toBe(true);
    expect(captionButtonsMatch({ ...reference, right: 2844 }, reference)).toBe(false);
    expect(captionButtonsMatch({ ...reference, left: 2614 }, reference)).toBe(false);
    expect(captionButtonsMatch(null, reference)).toBe(false);
  });
  it('顶边只扣按钮的横向范围，老程序边框造成上下差异不改变可站位置', () => {
    const actual = { left: 879, top: 158, right: 932, bottom: 203 };
    const hit = { left: 877, top: 168, right: 930, bottom: 201 };
    expect(captionButtonsMatch(actual, hit)).toBe(true);
    expect(captionButtonsMatch({ ...actual, left: 880 }, hit)).toBe(false);
    expect(captionButtonsMatch({ ...actual, right: 933 }, hit)).toBe(false);
  });
  it('只保留可见按钮，禁用但可见的按钮也不能让猫站上去', () => {
    const rectangles = [empty, empty, reference, empty, empty, empty];
    expect(titlebarButtons(rectangles, [0, 0, 1, 0, 0, 0], outer)).toEqual(reference);
    expect(titlebarButtons(rectangles, [0, 0, 0x8000, 0, 0, 0], outer)).toBeNull();
  });
  it('明显不在物理外框内的标题栏不能通过夹边变成可靠按钮', () => {
    const rectangles = [empty, empty, { ...reference, left: 1500 }, empty, empty, empty];
    expect(titlebarButtons(rectangles, [], outer)).toBeNull();
  });
});

describe('窗口前后顺序', () => {
  it('遮挡排序使用 GetWindow 的 Z 序，而不是枚举的回调顺序', () => {
    const api = {
      enumerate(callback: (id: number) => boolean) {
        [3, 1, 2].forEach(callback);
        return true;
      },
      top: () => 1,
      next: (id: bigint) => (id === 1n ? 2 : id === 2n ? 3 : 0),
      exists: () => true,
    };
    expect(windowsInZOrder(api)).toEqual([1n, 2n, 3n]);
  });
  it('实时换序造成环时重试，持续不一致就明确失败', () => {
    let calls = 0;
    const api = {
      enumerate(callback: (id: number) => boolean) {
        calls++;
        callback(1);
        callback(2);
        return true;
      },
      top: () => 1,
      next: () => 1,
      exists: () => true,
    };
    expect(() => windowsInZOrder(api)).toThrow('三次读取仍不一致');
    expect(calls).toBe(3);
  });
  it('枚举后已关闭的窗口可以缺席，仍存在但未排序的窗口不可以丢失', () => {
    const api = {
      enumerate(callback: (id: number) => boolean) {
        callback(1);
        callback(2);
        return true;
      },
      top: () => 1,
      next: () => 0,
      exists: (id: bigint) => id !== 2n,
    };
    expect(windowsInZOrder(api)).toEqual([1n]);
    expect(() => windowsInZOrder({ ...api, exists: () => true })).toThrow('三次读取仍不一致');
  });
});
