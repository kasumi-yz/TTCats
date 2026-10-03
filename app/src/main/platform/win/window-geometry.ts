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
