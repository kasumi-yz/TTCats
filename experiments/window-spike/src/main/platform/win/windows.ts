import koffi from 'koffi';
import type { Rect, WindowInfo } from '../../../ledge';

const user = koffi.load('user32.dll');
const dwm = koffi.load('dwmapi.dll');
const RECT = koffi.struct('RECT', {
  left: 'int32',
  top: 'int32',
  right: 'int32',
  bottom: 'int32',
});
koffi.proto('int __stdcall EnumWindowsProc(void * hwnd, intptr_t parameter)');
const enumWindows = user.func(
  'int __stdcall EnumWindows(EnumWindowsProc * callback, intptr_t parameter)',
);
const validWindow = user.func('int __stdcall IsWindow(void * hwnd)');
const visible = user.func('int __stdcall IsWindowVisible(void * hwnd)');
const iconic = user.func('int __stdcall IsIconic(void * hwnd)');
const zoomed = user.func('int __stdcall IsZoomed(void * hwnd)');
const style = user.func('intptr_t __stdcall GetWindowLongPtrW(void * hwnd, int index)');
const getPid = user.func(
  'uint32 __stdcall GetWindowThreadProcessId(void * hwnd, _Out_ uint32 * pid)',
);
const getText = user.func('int __stdcall GetWindowTextW(void * hwnd, void * text, int length)');
const getClass = user.func('int __stdcall GetClassNameW(void * hwnd, void * text, int length)');
const getDpi = user.func('uint32 __stdcall GetDpiForWindow(void * hwnd)');
const getRect = user.func('int __stdcall GetWindowRect(void * hwnd, _Out_ RECT * rect)');
const attribute = dwm.func(
  'int32 __stdcall DwmGetWindowAttribute(void * hwnd, uint32 attr, void * value, uint32 size)',
);

function dwmRect(hwnd: unknown, attr: number): Rect | null {
  const buffer = Buffer.alloc(16);
  if (attribute(hwnd, attr, buffer, 16) !== 0) return null;
  return koffi.decode(buffer, RECT) as Rect;
}

export function enumerateWindows(monitors: Rect[], ownPid = process.pid): WindowInfo[] {
  const result: WindowInfo[] = [];
  const handles: unknown[] = [];
  // GetWindow 链表会在拖动换序时变化，可能重复或死循环；先由 EnumWindows 建立快照。
  if (
    !enumWindows((hwnd: unknown) => {
      handles.push(hwnd);
      return 1;
    }, 0)
  )
    throw new Error('无法枚举桌面窗口，请重新采样。');
  for (const hwnd of handles) {
    const id = String(hwnd);
    const pid = [0];
    getPid(hwnd, pid);
    const cloak = Buffer.alloc(4);
    if (!visible(hwnd) || iconic(hwnd) || pid[0] === ownPid) continue;
    if (attribute(hwnd, 14, cloak, 4) !== 0) {
      if (!validWindow(hwnd)) continue;
      throw new Error(`窗口 ${id} 的隐藏状态查询失败，请重新采样。`);
    }
    if (cloak.readUInt32LE() !== 0) continue;
    const bounds = dwmRect(hwnd, 9);
    if (!bounds || bounds.right <= bounds.left || bounds.bottom <= bounds.top) continue;
    const text = Buffer.alloc(2048);
    const name = Buffer.alloc(512);
    getText(hwnd, text, 1024);
    getClass(hwnd, name, 256);
    const dpi = getDpi(hwnd) || 96;
    const maximized = Boolean(zoomed(hwnd));
    const fullscreen = monitors.some(
      (m) =>
        bounds.left <= m.left + 1 &&
        bounds.top <= m.top + 1 &&
        bounds.right >= m.right - 1 &&
        bounds.bottom >= m.bottom - 1,
    );
    const tool = (Number(style(hwnd, -20)) & 0x80) !== 0;
    const small =
      bounds.right - bounds.left < (160 * dpi) / 96 || bounds.bottom - bounds.top < (80 * dpi) / 96;
    const className = name.toString('utf16le').split('\0')[0];
    const shell = ['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd'].includes(
      className,
    );
    const reason = shell
      ? 'shell'
      : tool
        ? 'tool'
        : small
          ? 'small'
          : maximized
            ? 'maximized'
            : fullscreen
              ? 'fullscreen'
              : '';
    const raw: Rect = { left: 0, top: 0, right: 0, bottom: 0 };
    const relative = dwmRect(hwnd, 5);
    let buttons: Rect | null = null;
    if (
      relative &&
      relative.right > relative.left &&
      relative.bottom > relative.top &&
      getRect(hwnd, raw)
    ) {
      buttons = {
        left: raw.left + relative.left,
        right: raw.left + relative.right,
        top: raw.top + relative.top,
        bottom: raw.top + relative.bottom,
      };
    }
    // 自绘标题栏没有可靠按钮边界时，保守扣掉右侧 160 DIP，报告记录该退路。
    const buttonsFallback = !buttons;
    if (!buttons)
      buttons = {
        left: Math.max(bounds.left, bounds.right - (160 * dpi) / 96),
        right: bounds.right,
        top: bounds.top,
        bottom: bounds.top + (40 * dpi) / 96,
      };
    result.push({
      id,
      pid: pid[0],
      title: text.toString('utf16le').split('\0')[0],
      className,
      bounds,
      buttons,
      buttonsFallback,
      dpi,
      eligible: !reason,
      reason,
      maximized,
      fullscreen,
    });
  }
  return result;
}

export function assertWindows(): void {
  if (process.platform !== 'win32') throw new Error('窗口模式小验证只能在 Windows 桌面运行。');
}

// 仅供 M0 的真实应用窗口测试；调用方必须在 finally 中恢复窗口。
const setPosition = user.func(
  'int __stdcall SetWindowPos(void * hwnd, void * after, int x, int y, int width, int height, uint32 flags)',
);
const showWindow = user.func('int __stdcall ShowWindow(void * hwnd, int command)');
const setDpiContext = user.func(
  'intptr_t __stdcall SetThreadDpiAwarenessContext(intptr_t context)',
);
export function usePhysicalCoordinates() {
  if (!setDpiContext(-4)) throw new Error('无法设置测试线程的 DPI 感知模式。');
}
export function prepareWindowTest(id: string) {
  const hwnd = BigInt(id);
  const maximized = Boolean(zoomed(hwnd));
  showWindow(hwnd, 9);
  const original: Rect = { left: 0, top: 0, right: 0, bottom: 0 };
  if (!getRect(hwnd, original)) throw new Error(`无法读取测试窗口 ${id} 的位置。`);
  return {
    move(x: number, y: number) {
      if (!setPosition(hwnd, null, x, y, 0, 0, 0x15)) throw new Error(`无法移动测试窗口 ${id}。`);
    },
    restore() {
      setPosition(hwnd, null, original.left, original.top, 0, 0, 0x15);
      if (maximized) showWindow(hwnd, 3);
    },
  };
}
