import { describe, expect, it } from 'vitest';
import { windowInfo } from './test-windows';
import { computeLedges, type LedgeScreen } from './compute';

const screen: LedgeScreen = {
  workArea: { left: 0, top: 0, right: 1920, bottom: 1040 },
  scaleFactor: 1,
};

describe('窗口顶边在桌面层的坐标', () => {
  it.each([
    [1920, 1080, 1],
    [2560, 1440, 1],
    [3440, 1440, 1],
    [2880, 1800, 1.5],
    [1920, 1080, 1.25],
  ])('%ix%i、缩放 %s 时同样的逻辑位置不漂移，按钮区域不能站猫', (width, height, scale) => {
    const target = windowInfo('target', {
      bounds: { left: 100 * scale, top: 200 * scale, right: 1000 * scale, bottom: 600 * scale },
      buttons: { left: 850 * scale, top: 200 * scale, right: 1000 * scale, bottom: 230 * scale },
    });
    expect(
      computeLedges([target], {
        workArea: { left: 0, top: 0, right: width, bottom: height - 40 * scale },
        scaleFactor: scale,
      }),
    ).toEqual([
      { id: 'target', left: 100, right: 1000, top: 200, segments: [{ left: 100, right: 850 }] },
    ]);
  });
  it('混合缩放副屏使用物理工作区原点，其他屏幕的窗口不能提供可站段', () => {
    const target = windowInfo('secondary', {
      bounds: { left: -1770, top: 400, right: -570, bottom: 1000 },
      buttons: { left: -795, top: 400, right: -570, bottom: 445 },
    });
    expect(
      computeLedges([windowInfo('primary'), target], {
        workArea: { left: -1920, top: 100, right: 0, bottom: 1540 },
        scaleFactor: 1.5,
      }),
    ).toEqual([
      { id: 'primary', left: 2020 / 1.5, right: 2920 / 1.5, top: 100 / 1.5, segments: [] },
      { id: 'secondary', left: 100, right: 900, top: 200, segments: [{ left: 100, right: 750 }] },
    ]);
  });
  it('跨屏窗口只保留猫所在屏幕的部分；任务栏在左或顶上时仍从工作区起算', () => {
    const target = windowInfo('crossing', {
      bounds: { left: -100, top: 200, right: 500, bottom: 600 },
      buttons: null,
    });
    expect(
      computeLedges([target], {
        workArea: { left: 40, top: 40, right: 1920, bottom: 1080 },
        scaleFactor: 1,
      }),
    ).toEqual([
      { id: 'crossing', left: -140, right: 460, top: 160, segments: [{ left: 0, right: 460 }] },
    ]);
    expect(
      computeLedges(
        [windowInfo('offscreen', { bounds: { left: 0, top: -1, right: 1000, bottom: 600 } })],
        screen,
      ),
    ).toEqual([]);
  });
  it('DPI 不感知程序仍使用物理按钮尺寸，不能根据 windowDpi=96 放大第二次', () => {
    const target = windowInfo('legacy', {
      dpiAwareness: 'unaware',
      windowDpi: 96,
      buttonsSource: 'titlebar',
    });
    expect(computeLedges([target], { ...screen, scaleFactor: 1.5 })).toEqual([
      {
        id: 'legacy',
        left: 100 / 1.5,
        right: 1000 / 1.5,
        top: 200 / 1.5,
        segments: [{ left: 100 / 1.5, right: 850 / 1.5 }],
      },
    ]);
  });
  it('150% 下不足 8 DIP 的碎线排除，达到宽度的线保留', () => {
    const target = windowInfo('target', {
      bounds: { left: 0, top: 200, right: 1000, bottom: 600 },
      buttons: { left: 12, top: 200, right: 989, bottom: 230 },
    });
    expect(computeLedges([target], { ...screen, scaleFactor: 1.5 })).toEqual([
      {
        id: 'target',
        left: 0,
        right: 1000 / 1.5,
        top: 200 / 1.5,
        segments: [{ left: 0, right: 8 }],
      },
    ]);
    expect(computeLedges([target], screen, 100)).toEqual([
      { id: 'target', left: 0, right: 1000, top: 200, segments: [] },
    ]);
  });
  it('横向完全移出屏幕仍保留窗口真实边界，空可站段不等于窗口已关闭', () => {
    const target = windowInfo('outside', {
      bounds: { left: -1000, top: 200, right: -100, bottom: 600 },
      buttons: null,
    });
    expect(computeLedges([target], screen)).toEqual([
      { id: 'outside', left: -1000, right: -100, top: 200, segments: [] },
    ]);
  });
});

describe('窗口遮挡', () => {
  it('工具窗口不能站猫，但仍会把下层窗口分成两段', () => {
    const above = windowInfo('tool', {
      bounds: { left: 300, top: 100, right: 600, bottom: 300 },
      eligible: false,
      reason: 'tool',
    });
    expect(computeLedges([above, windowInfo()], screen)).toEqual([
      {
        id: 'target',
        left: 100,
        right: 1000,
        top: 200,
        segments: [
          { left: 100, right: 300 },
          { left: 600, right: 850 },
        ],
      },
    ]);
  });
  it.each(['minimized', 'cloaked', 'transparent', 'invisible'])(
    '%s 窗口不能成为遮挡，避免凭空扣掉可站的顶边',
    (reason) => {
      const above = windowInfo('hidden', { eligible: false, occludes: false, reason });
      expect(computeLedges([above, windowInfo()], screen)).toEqual([
        { id: 'target', left: 100, right: 1000, top: 200, segments: [{ left: 100, right: 850 }] },
      ]);
    },
  );
  it('完全遮挡、重叠遮挡以及下层窗口都按 Z 序计算', () => {
    const cover = windowInfo('cover', {
      eligible: false,
      bounds: { left: 0, top: 0, right: 1920, bottom: 1000 },
    });
    expect(computeLedges([cover, windowInfo()], screen)).toEqual([
      { id: 'target', left: 100, right: 1000, top: 200, segments: [] },
    ]);
    expect(computeLedges([windowInfo(), cover], screen)).toEqual([
      { id: 'target', left: 100, right: 1000, top: 200, segments: [{ left: 100, right: 850 }] },
    ]);
    const a = windowInfo('a', {
      eligible: false,
      bounds: { left: 100, top: 0, right: 500, bottom: 300 },
    });
    const b = windowInfo('b', {
      eligible: false,
      bounds: { left: 400, top: 0, right: 700, bottom: 300 },
    });
    expect(computeLedges([a, b, windowInfo()], screen)).toEqual([
      { id: 'target', left: 100, right: 1000, top: 200, segments: [{ left: 700, right: 850 }] },
    ]);
  });
});
