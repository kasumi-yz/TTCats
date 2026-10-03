import { screen } from 'electron';
import koffi from 'koffi';
import type { Platform, ScreenPoint } from '../types';
import { isFullscreenWindow, type Rect } from './fullscreen';
export { FULLSCREEN_IGNORED_PROCESSES } from './fullscreen';
export { readWindows } from './windows';
const QUNS_BUSY = 2;
const QUNS_RUNNING_D3D_FULL_SCREEN = 3;
const QUNS_PRESENTATION_MODE = 4;
const MONITOR_DEFAULTTONEAREST = 2;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

export function createWindowsPlatform(): Platform {
  const user32 = koffi.load('user32.dll');
  const shell32 = koffi.load('shell32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  const rect = koffi.struct('PlatformRect', {
    left: 'long',
    top: 'long',
    right: 'long',
    bottom: 'long',
  });
  koffi.struct('PlatformPoint', { x: 'long', y: 'long' });
  koffi.struct('PlatformMonitorInfo', {
    cbSize: 'uint32',
    rcMonitor: rect,
    rcWork: rect,
    dwFlags: 'uint32',
  });
  const getAsyncKeyState = user32.func('short __stdcall GetAsyncKeyState(int vKey)') as (
    key: number,
  ) => number;
  const getSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int nIndex)') as (
    index: number,
  ) => number;
  const queryNotificationState = shell32.func(
    'int __stdcall SHQueryUserNotificationState(_Out_ int *state)',
  ) as (state: number[]) => number;
  const getForegroundWindow = user32.func('intptr_t __stdcall GetForegroundWindow()') as () =>
    number | bigint;
  const getClassName = user32.func(
    'int __stdcall GetClassNameW(intptr_t window, void *text, int max)',
  ) as (window: number, text: Buffer, max: number) => number;
  const getWindowRect = user32.func(
    'bool __stdcall GetWindowRect(intptr_t window, _Out_ PlatformRect *rect)',
  ) as (window: number, rect: Rect) => boolean;
  const getWindowLongPtr = user32.func(
    'intptr_t __stdcall GetWindowLongPtrW(intptr_t window, int index)',
  ) as (window: number, index: number) => number | bigint;
  const setLastError = kernel32.func('void __stdcall SetLastError(uint error)') as (
    error: number,
  ) => void;
  const getLastError = kernel32.func('uint __stdcall GetLastError()') as () => number;
  const monitorFromWindow = user32.func(
    'intptr_t __stdcall MonitorFromWindow(intptr_t window, uint flags)',
  ) as (window: number, flags: number) => number | bigint;
  const monitorFromPoint = user32.func(
    'intptr_t __stdcall MonitorFromPoint(PlatformPoint point, uint flags)',
  ) as (point: { x: number; y: number }, flags: number) => number | bigint;
  const getMonitorInfo = user32.func(
    'bool __stdcall GetMonitorInfoW(intptr_t monitor, _Inout_ PlatformMonitorInfo *info)',
  ) as (monitor: number, info: { cbSize: number; rcMonitor: Rect }) => boolean;
  const getWindowThreadProcessId = user32.func(
    'uint __stdcall GetWindowThreadProcessId(intptr_t window, _Out_ uint *pid)',
  ) as (window: number, pid: number[]) => number;
  const openProcess = kernel32.func(
    'intptr_t __stdcall OpenProcess(uint access, bool inherit, uint pid)',
  ) as (access: number, inherit: boolean, pid: number) => number | bigint;
  const queryImageName = kernel32.func(
    'bool __stdcall QueryFullProcessImageNameW(intptr_t process, uint flags, void *name, _Inout_ uint *size)',
  ) as (process: number, flags: number, name: Buffer, size: number[]) => boolean;
  const closeHandle = kernel32.func('bool __stdcall CloseHandle(intptr_t handle)') as (
    handle: number,
  ) => boolean;

  const windowClass = (window: number): string => {
    const buffer = Buffer.alloc(512);
    const length = getClassName(window, buffer, 256);
    return buffer.toString('utf16le', 0, Math.max(0, length) * 2);
  };
  const windowStyle = (window: number): number | null => {
    // 返回 0 既可能是合法的无样式窗口，也可能是失败；按 Win32 约定清除再读错误码。
    setLastError(0);
    const style = Number(getWindowLongPtr(window, -16)); // GWL_STYLE
    return style === 0 && getLastError() !== 0 ? null : style;
  };
  /** 窗口所属程序的可执行文件名（小写）。没有权限读（比如管理员程序）时返回空字符串。 */
  const processName = (window: number): string => {
    const pid = [0];
    getWindowThreadProcessId(window, pid);
    const handle = Number(openProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid[0] ?? 0));
    if (handle === 0) return '';
    try {
      const buffer = Buffer.alloc(2048);
      const size = [1024];
      if (!queryImageName(handle, 0, buffer, size)) return '';
      const path = buffer.toString('utf16le', 0, (size[0] ?? 0) * 2);
      return (path.split('\\').pop() ?? '').toLowerCase();
    } finally {
      closeHandle(handle);
    }
  };
  /**
   * 前台窗口是不是真的盖满了猫所在的那块屏幕（桌面、任务栏、白名单程序不算）。
   * 前台窗口在别的屏幕上时不算，哪怕它盖满了那块屏幕。
   */
  const foregroundCoversMonitor = (display: ScreenPoint): boolean => {
    const window = Number(getForegroundWindow());
    if (window === 0) return false;
    const bounds = { left: 0, top: 0, right: 0, bottom: 0 };
    // 窗口刚好关掉时读不到位置，此时它显然不在全屏
    if (!getWindowRect(window, bounds)) return false;
    const monitor = Number(monitorFromWindow(window, MONITOR_DEFAULTTONEAREST));
    // Electron 的坐标按缩放换算过，Windows 的按物理像素，要先换过去才能问是哪块屏幕
    const point = screen.dipToScreenPoint(display);
    const target = { x: Math.round(point.x), y: Math.round(point.y) };
    if (monitor !== Number(monitorFromPoint(target, MONITOR_DEFAULTTONEAREST))) return false;
    const info = { cbSize: koffi.sizeof('PlatformMonitorInfo'), rcMonitor: { ...bounds } };
    if (!getMonitorInfo(monitor, info))
      throw new Error('GetMonitorInfoW 失败，无法判断前台窗口是否全屏');
    return isFullscreenWindow({
      className: windowClass(window),
      style: windowStyle(window),
      bounds,
      monitorBounds: info.rcMonitor,
      sameMonitor: true,
      processName: processName(window),
    });
  };

  return {
    isFullscreen(display) {
      const state = [0];
      const result = queryNotificationState(state);
      // HRESULT 的负值表示失败，不能把查询失败当作“没有全屏”。
      if (result < 0) {
        throw new Error(`SHQueryUserNotificationState: HRESULT 0x${(result >>> 0).toString(16)}`);
      }
      // 独占全屏的游戏和演示模式一定要躲开（系统不说是哪块屏幕）；
      // "忙碌"可能是悬浮层之类误报，或者是别的屏幕上的全屏，要再核对前台窗口。
      if (state[0] === QUNS_RUNNING_D3D_FULL_SCREEN || state[0] === QUNS_PRESENTATION_MODE)
        return true;
      return state[0] === QUNS_BUSY && foregroundCoversMonitor(display);
    },
    isCtrlDown() {
      // 只读当前按下位；最低位“自上次查询后按过”会被其他进程消耗。
      return (getAsyncKeyState(0x11) & 0x8000) !== 0;
    },
    isLeftButtonDown() {
      // GetAsyncKeyState 读物理按钮，交换左右键时主按钮是物理右键。
      // 每次读取设置，运行中交换按钮也立即生效，避免拖动兜底误判松手。
      const primaryButton = getSystemMetrics(23) !== 0 ? 0x02 : 0x01;
      return (getAsyncKeyState(primaryButton) & 0x8000) !== 0;
    },
  };
}
