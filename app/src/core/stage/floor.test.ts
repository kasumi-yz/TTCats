import { describe, expect, it } from 'vitest';
import type { StageBounds } from '../../shared/core-api';
import { FAR_SCALE_AT_FULL_DEPTH, Floor, STANDARD_CAT_HEIGHT } from './floor';
import { at } from './test-fixtures';

/** Windows 11 的任务栏高 48 个逻辑像素，桌面层覆盖工作区。 */
function workArea(width: number, height: number, dpiScale: number): StageBounds {
  return { width: width / dpiScale, height: height / dpiScale - 48 };
}

// D23 支持的 4 种配置，以及不在保证范围里的 1920×1080 125%
const CONFIGS = [
  { name: '1920×1080 100%', bounds: workArea(1920, 1080, 1) },
  { name: '2560×1440 100%', bounds: workArea(2560, 1440, 1) },
  { name: '3440×1440 100%', bounds: workArea(3440, 1440, 1) },
  { name: '2880×1800 150%', bounds: workArea(2880, 1800, 1.5) },
  { name: '1920×1080 125%', bounds: workArea(1920, 1080, 1.25) },
];

describe('地板几何', () => {
  describe.each(CONFIGS)('$name', ({ bounds }) => {
    it.each([0.5, 1, 2])('缩放 %s 时地板在屏幕底部，最远处也放得下最大的猫', (scale) => {
      const floor = new Floor({ bounds, scale, floorDepth: 1 });
      expect(floor.nearY).toBeLessThan(bounds.height);
      expect(floor.nearY).toBeGreaterThan(bounds.height - 0.1 * STANDARD_CAT_HEIGHT * scale);
      expect(floor.farY).toBeLessThan(floor.nearY);
      expect(floor.farY - 1.5 * STANDARD_CAT_HEIGHT * scale).toBeGreaterThanOrEqual(0);
    });

    it('纵深拉满时最远处 85%、最近处 100%', () => {
      const floor = new Floor({ bounds, scale: 1, floorDepth: 1 });
      expect(floor.depthScale(0)).toBeCloseTo(FAR_SCALE_AT_FULL_DEPTH);
      expect(floor.depthScale(1)).toBe(1);
      expect(floor.yAt(0)).toBe(floor.farY);
      expect(floor.yAt(1)).toBe(floor.nearY);
    });

    it('猫的落脚锚点留在屏幕里，身体也不会伸出左右两边', () => {
      const floor = new Floor({ bounds, scale: 2, floorDepth: 0.5 });
      const { min, max } = floor.xRange(1.5);
      expect(min).toBeGreaterThanOrEqual(0.5 * STANDARD_CAT_HEIGHT * 2 * 1.5);
      expect(max).toBeLessThanOrEqual(bounds.width - 0.5 * STANDARD_CAT_HEIGHT * 2 * 1.5);
      expect(floor.clampX(-100, 1.5)).toBe(min);
      expect(floor.clampX(1e6, 1.5)).toBe(max);
    });
  });

  it('地板有多高只跟猫的大小有关，不跟屏幕分辨率有关', () => {
    const bands = CONFIGS.map(
      ({ bounds }) => new Floor({ bounds, scale: 1, floorDepth: 0.5 }).band,
    );
    expect(new Set(bands).size).toBe(1);
    expect(bands[0]).toBeCloseTo(0.5 * STANDARD_CAT_HEIGHT);
  });

  it('纵深为 0 时猫都在同一条线上，一样大', () => {
    const floor = new Floor({ bounds: at(CONFIGS, 0).bounds, scale: 1, floorDepth: 0 });
    expect(floor.band).toBe(0);
    expect(floor.depthScale(0)).toBe(1);
    expect(floor.yAt(0)).toBe(floor.yAt(1));
    expect(floor.depthAtY(500)).toBeUndefined();
  });

  it('纵深调小时，最远处的缩放按透视接近 100%', () => {
    const half = new Floor({ bounds: at(CONFIGS, 0).bounds, scale: 1, floorDepth: 0.5 });
    expect(half.farScale).toBeCloseTo(1 - (1 - FAR_SCALE_AT_FULL_DEPTH) / 2);
  });

  it('屏幕矮得放不下时，地板收窄而不是伸出屏幕', () => {
    const floor = new Floor({ bounds: { width: 800, height: 300 }, scale: 1, floorDepth: 1 });
    expect(floor.farY).toBeGreaterThanOrEqual(1.5 * STANDARD_CAT_HEIGHT);
    expect(floor.farScale).toBeGreaterThan(FAR_SCALE_AT_FULL_DEPTH);
  });

  it('桌面层大小为 0 时不出现 NaN', () => {
    const floor = new Floor({ bounds: { width: 0, height: 0 }, scale: 1, floorDepth: 1 });
    const values = [floor.nearY, floor.farY, floor.farScale, floor.yAt(0.5), floor.clampX(50, 1)];
    expect(values.every(Number.isFinite)).toBe(true);
    expect(floor.xRange(1)).toEqual({ min: 0, max: 0 });
  });

  it('屏幕上的 y 换算成纵深，超出地板的取最近的一端', () => {
    const floor = new Floor({ bounds: at(CONFIGS, 0).bounds, scale: 1, floorDepth: 1 });
    expect(floor.depthAtY(floor.yAt(0.25))).toBeCloseTo(0.25);
    expect(floor.depthAtY(0)).toBe(0);
    expect(floor.depthAtY(5000)).toBe(1);
  });
});
