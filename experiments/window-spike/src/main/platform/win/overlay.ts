import { screen, type BrowserWindow, type Rectangle } from 'electron';
import type { MonitorInfo } from './windows';

export function monitors(): MonitorInfo[] {
  return screen.getAllDisplays().map((display) => {
    const r = screen.dipToScreenRect(null, display.bounds);
    return {
      left: r.x,
      top: r.y,
      right: r.x + r.width,
      bottom: r.y + r.height,
      dpi: display.scaleFactor * 96,
    };
  });
}

export function overlayRect(overlay: BrowserWindow, rect: Rectangle): Rectangle {
  const r = screen.screenToDipRect(overlay, rect);
  const origin = overlay.getBounds();
  return { ...r, x: r.x - origin.x, y: r.y - origin.y };
}

export function keepAboveDrag(overlay: BrowserWindow): void {
  // Windows 拖动循环会把活动窗口排到前面；重新置顶但不获取焦点。
  overlay.moveTop();
}
