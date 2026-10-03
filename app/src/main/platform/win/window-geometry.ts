import type { WindowRect } from '../types';

export function validRect(rect: WindowRect): boolean {
  return (
    Object.values(rect).every(Number.isFinite) && rect.right > rect.left && rect.bottom > rect.top
  );
}

/** TITLEBARINFOEX 是屏幕坐标；不能再按目标窗口 DPI 放大，也不能夹住边缘掩盖错误。 */
export function titlebarButtons(
  rectangles: WindowRect[],
  states: number[],
  outer: WindowRect,
): WindowRect | null {
  const buttons = [2, 3, 4, 5]
    .filter((index) => ((states[index] ?? 0) & 0x18000) === 0)
    .map((index) => rectangles[index])
    .filter((rect): rect is WindowRect => rect !== undefined && validRect(rect));
  if (!buttons.length) return null;
  const result = {
    left: Math.min(...buttons.map((r) => r.left)),
    top: Math.min(...buttons.map((r) => r.top)),
    right: Math.max(...buttons.map((r) => r.right)),
    bottom: Math.max(...buttons.map((r) => r.bottom)),
  };
  return result.left >= outer.left - 2 &&
    result.right <= outer.right + 2 &&
    result.top >= outer.top - 2 &&
    result.bottom <= outer.bottom + 2
    ? result
    : null;
}

/** 独立 UI Automation 证据必须同时核对左边缘、右边缘及宽度，旧的过大预留会失败。 */
export function captionButtonsMatch(
  actual: WindowRect | null,
  reference: WindowRect,
  tolerance = 2,
): boolean {
  if (!actual || !validRect(actual) || !validRect(reference)) return false;
  return (
    Math.abs(actual.left - reference.left) <= tolerance &&
    Math.abs(actual.right - reference.right) <= tolerance &&
    Math.abs(actual.top - reference.top) <= tolerance &&
    Math.abs(actual.bottom - reference.bottom) <= tolerance &&
    Math.abs(actual.right - actual.left - (reference.right - reference.left)) <= tolerance
  );
}

/** 自绘按钮的实际命中范围；二分边界而非逐像素消息，避免每次采样阻塞主进程。 */
export function hitTestButtons(
  outer: WindowRect,
  hint: WindowRect,
  hit: (x: number, y: number) => number | null,
): WindowRect | null {
  const x = Math.floor(hint.right - (hint.bottom - hint.top) / 2);
  const y = Math.floor((hint.top + hint.bottom) / 2);
  const button = (code: number | null): boolean => code !== null && [8, 9, 20, 21].includes(code);
  // 提示区必须能定位实际关闭按钮，不能从不相关的客户区猜矩形。
  if (x < outer.left || x >= outer.right || y < outer.top || y >= outer.bottom || hit(x, y) !== 20)
    return null;
  const status = { timedOut: false };
  const matches = (px: number, py: number): boolean => {
    if (status.timedOut) return false;
    const code = hit(px, py);
    if (code === null) status.timedOut = true;
    return button(code);
  };
  const first = (low: number, high: number, test: (position: number) => boolean): number => {
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (test(mid)) high = mid;
      else low = mid + 1;
    }
    return low;
  };
  const left = first(outer.left, x, (px) => matches(px, y));
  const right = first(x + 1, outer.right, (px) => !matches(px, y));
  const top = first(outer.top, y, (py) => matches(x, py));
  const bottom = first(y + 1, outer.bottom, (py) => !matches(x, py));
  const result = { left, right, top, bottom };
  if (status.timedOut || !validRect(result)) return null;
  // 标准相邻按钮的联合矩形必须在内部持续命中，非连续自绘布局退回明确标记的来源。
  for (const fraction of [0, 0.25, 0.5, 0.75, 1])
    if (!matches(left + Math.floor((right - left - 1) * fraction), y)) return null;
  return result;
}
