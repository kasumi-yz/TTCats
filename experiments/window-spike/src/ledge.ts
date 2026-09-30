export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
export interface WindowInfo {
  id: string;
  pid: number;
  title: string;
  className: string;
  bounds: Rect;
  buttons: Rect | null;
  buttonsFallback: boolean;
  dpi: number;
  eligible: boolean;
  reason: string;
  maximized: boolean;
  fullscreen: boolean;
}
export interface Ledge {
  id: string;
  left: number;
  right: number;
  y: number;
}

export function subtract(
  segments: [number, number][],
  left: number,
  right: number,
): [number, number][] {
  return segments.flatMap(([a, b]) => {
    if (right <= a || left >= b) return [[a, b]];
    const result: [number, number][] = [];
    if (left > a) result.push([a, left]);
    if (right < b) result.push([right, b]);
    return result;
  });
}

// 输入顺序必须是 Z 序从上到下；不能站立的窗口仍然会挡住下面的窗口。
export function computeLedges(windows: WindowInfo[]): Ledge[] {
  const ledges: Ledge[] = [];
  windows.forEach((window, index) => {
    if (!window.eligible) return;
    const { left, top, right } = window.bounds;
    let segments: [number, number][] = [[left, right]];
    if (window.buttons) segments = subtract(segments, window.buttons.left, window.buttons.right);
    for (const above of windows.slice(0, index)) {
      if (above.bounds.top <= top && above.bounds.bottom > top) {
        segments = subtract(segments, above.bounds.left, above.bounds.right);
      }
    }
    for (const [a, b] of segments)
      if (b > a) ledges.push({ id: window.id, left: a, right: b, y: top });
  });
  return ledges;
}

export function movementSpeed(
  previous: Rect,
  current: Rect,
  elapsedMs: number,
  dpi: number,
): number {
  if (elapsedMs <= 0) return 0;
  return (
    (((Math.hypot(current.left - previous.left, current.top - previous.top) * 1000) / elapsedMs) *
      96) /
    dpi
  );
}
