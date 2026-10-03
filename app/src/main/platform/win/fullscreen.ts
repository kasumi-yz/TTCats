/** Windows 物理像素矩形。 */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** NVIDIA 的常驻隐形悬浮层会令系统一直报告忙碌（#29）。 */
export const FULLSCREEN_IGNORED_PROCESSES = ['nvidia overlay.exe'];
const IGNORED_WINDOW_CLASSES = [
  'progman',
  'workerw',
  'shell_traywnd',
  'xamlexplorerhostislandwindow',
  'windows.ui.core.corewindow',
];
const WS_MAXIMIZE = 0x01000000;
// WS_CAPTION 是 WS_BORDER | WS_DLGFRAME，必须两位都有才能算完整标题栏。
const WS_CAPTION = 0x00c00000;

/** 仅用于 QUNS_BUSY 的前台核对；独占全屏和演示模式仍由通知状态直接决定。 */
export function isFullscreenWindow(window: {
  className: string;
  /** null 表示读取失败，保留原有的几何判断。0 是合法样式。 */
  style: number | null;
  bounds: Rect;
  monitorBounds: Rect;
  sameMonitor: boolean;
  processName: string;
}): boolean {
  if (!window.sameMonitor || IGNORED_WINDOW_CLASSES.includes(window.className.toLowerCase()))
    return false;
  if (FULLSCREEN_IGNORED_PROCESSES.includes(window.processName.toLowerCase())) return false;
  if (
    window.style !== null &&
    (window.style & WS_MAXIMIZE) !== 0 &&
    (window.style & WS_CAPTION) === WS_CAPTION
  )
    return false;
  const { bounds, monitorBounds: area } = window;
  return (
    bounds.left <= area.left &&
    bounds.top <= area.top &&
    bounds.right >= area.right &&
    bounds.bottom >= area.bottom
  );
}
