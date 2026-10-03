import { describe, expect, it } from 'vitest';
import { isFullscreenWindow } from './fullscreen';

const fullscreen = {
  className: 'Chrome_WidgetWin_1',
  style: 0,
  bounds: { left: 0, top: 0, right: 2880, bottom: 1800 },
  monitorBounds: { left: 0, top: 0, right: 2880, bottom: 1800 },
  sameMonitor: true,
  processName: 'game.exe',
};

describe('忙碌时的前台全屏判断', () => {
  it.each([
    'Progman',
    'WorkerW',
    'Shell_TrayWnd',
    'XamlExplorerHostIslandWindow',
    'Windows.UI.Core.CoreWindow',
  ])('%s 不应让猫因桌面或系统面板而消失，大小写不影响排除', (className) => {
    for (const name of [className, className.toUpperCase(), className.toLowerCase()])
      expect(isFullscreenWindow({ ...fullscreen, className: name })).toBe(false);
  });

  it('UWP 应用的全屏不是系统面板，不能把 ApplicationFrameWindow 一并排除', () => {
    expect(isFullscreenWindow({ ...fullscreen, className: 'ApplicationFrameWindow' })).toBe(true);
  });

  it('副屏无任务栏或任务栏自动隐藏时，普通最大化窗口即使越过屏幕边界也不算全屏', () => {
    expect(
      isFullscreenWindow({
        ...fullscreen,
        style: 0x01c00000,
        bounds: { left: -1930, top: -10, right: 10, bottom: 1090 },
        monitorBounds: { left: -1920, top: 0, right: 0, bottom: 1080 },
      }),
    ).toBe(false);
  });

  it.each([0, 0x01000000, 0x01800000, 0x01400000, 0x00c00000])(
    '样式 0x%s 没有同时满足最大化和完整标题栏，全屏仍应隐藏猫',
    (style) => {
      expect(isFullscreenWindow({ ...fullscreen, style })).toBe(true);
    },
  );

  it.each(['left', 'top', 'right', 'bottom'] as const)(
    '窗口在 %s 边没盖满屏幕时，不算全屏',
    (edge) => {
      const bounds = { ...fullscreen.bounds };
      bounds[edge] += edge === 'left' || edge === 'top' ? 1 : -1;
      expect(isFullscreenWindow({ ...fullscreen, bounds })).toBe(false);
    },
  );

  it('另一块屏幕的全屏不能影响猫所在的桌面层', () => {
    expect(isFullscreenWindow({ ...fullscreen, sameMonitor: false })).toBe(false);
  });

  it('NVIDIA 常驻悬浮层仍不能让猫一直隐藏', () => {
    expect(isFullscreenWindow({ ...fullscreen, processName: 'NVIDIA Overlay.EXE' })).toBe(false);
  });

  it('读不到样式只回退到几何核对，普通窗口不会因此变成全屏', () => {
    expect(isFullscreenWindow({ ...fullscreen, style: null })).toBe(true);
    expect(
      isFullscreenWindow({
        ...fullscreen,
        style: null,
        bounds: { ...fullscreen.bounds, bottom: 1700 },
      }),
    ).toBe(false);
    expect(isFullscreenWindow({ ...fullscreen, style: null, className: 'Progman' })).toBe(false);
  });
});
