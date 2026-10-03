import type { WindowInfo, WindowRect } from '../platform/types';

/** #106 尚未合并，沿用实验版格式。id 是窗口 id，多个线段可以属于同一个窗口。 */
export interface Ledge {
  id: string;
  left: number;
  right: number;
  y: number;
}

/** 猫所在的唯一显示器及桌面层工作区；原点必须是物理像素，不能用 DIP 原点乘缩放猜。 */
export interface LedgeScreen {
  workArea: WindowRect;
  scaleFactor: number;
}

function subtract(segments: [number, number][], left: number, right: number): [number, number][] {
  return segments.flatMap(([a, b]) => {
    if (right <= a || left >= b) return [[a, b]];
    const result: [number, number][] = [];
    if (left > a) result.push([a, left]);
    if (right < b) result.push([right, b]);
    return result;
  });
}

/** 输入按 Z 序从上到下，输出为桌面层局部 CSS 像素。猫身体所需空间由 #115 判断。 */
export function computeLedges(
  windows: readonly WindowInfo[],
  screen: LedgeScreen,
  minimumWidth = 8,
): Ledge[] {
  const { workArea: area, scaleFactor: scale } = screen;
  if (
    !Number.isFinite(scale) ||
    scale <= 0 ||
    !Number.isFinite(minimumWidth) ||
    minimumWidth < 0 ||
    !Object.values(area).every(Number.isFinite) ||
    area.right <= area.left ||
    area.bottom <= area.top
  )
    throw new Error('窗口顶边需要有效的屏幕工作区、缩放和最短长度。');
  const result: Ledge[] = [];
  windows.forEach((window, index) => {
    const { left, top, right } = window.bounds;
    if (!window.eligible || top < area.top || top >= area.bottom) return;
    const a = Math.max(left, area.left),
      b = Math.min(right, area.right);
    if (b <= a) return;
    let segments: [number, number][] = [[a, b]];
    if (window.buttons) segments = subtract(segments, window.buttons.left, window.buttons.right);
    for (const above of windows.slice(0, index)) {
      if (above.occludes && above.bounds.top <= top && above.bounds.bottom > top)
        segments = subtract(segments, above.bounds.left, above.bounds.right);
    }
    for (const [left, right] of segments) {
      if (right - left >= minimumWidth * scale)
        result.push({
          id: window.id,
          left: (left - area.left) / scale,
          right: (right - area.left) / scale,
          y: (top - area.top) / scale,
        });
    }
  });
  return result;
}
