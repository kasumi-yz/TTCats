import koffi from 'koffi';
import type { Rect, WindowInfo } from '../../../ledge';

export function assertWindows(): void {
  if (process.platform !== 'win32') throw new Error('窗口模式小验证只能在 Windows 桌面运行。');
}
assertWindows();

export interface MonitorInfo extends Rect {
  dpi: number;
}
export const ignoredTransparentWindows: {
  id: string;
  pid: number;
  bounds: Rect;
  extendedStyle: number;
  reason: string;
}[] = [];

const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x80;
const WS_EX_LAYERED = 0x80000;
const WS_EX_TRANSPARENT = 0x20;
const LWA_ALPHA = 2;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
const DWMWA_CLOAKED = 14;
const DWMWA_CAPTION_BUTTON_BOUNDS = 5;
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
const extendedStyle = user.func('intptr_t __stdcall GetWindowLongPtrW(void * hwnd, int index)');
const layeredAttributes = user.func(
  'int __stdcall GetLayeredWindowAttributes(void * hwnd, _Out_ uint32 * key, _Out_ uint8 * alpha, _Out_ uint32 * flags)',
);
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

export function enumerateWindows(monitors: MonitorInfo[]): WindowInfo[] {
  if (!monitors.length) throw new Error('读取窗口前必须提供显示器边界及缩放。');
  ignoredTransparentWindows.length = 0;
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
    if (!visible(hwnd) || iconic(hwnd) || pid[0] === process.pid) continue;
    if (attribute(hwnd, DWMWA_CLOAKED, cloak, 4) !== 0) {
      if (!validWindow(hwnd)) continue;
      throw new Error(`窗口 ${id} 的隐藏状态查询失败，请重新采样。`);
    }
    if (cloak.readUInt32LE() !== 0) continue;
    const bounds = dwmRect(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS);
    if (!bounds || bounds.right <= bounds.left || bounds.bottom <= bounds.top) continue;
    const exStyle = Number(extendedStyle(hwnd, GWL_EXSTYLE));
    if (exStyle & WS_EX_LAYERED) {
      // M0 策略：鼠标穿过的分层窗口不作为遮挡物；不能仅凭 TOOLWINDOW 排除。
      const alpha = [255];
      const flags = [0];
      const key = [0];
      const reason =
        exStyle & WS_EX_TRANSPARENT
          ? 'layered-click-through'
          : layeredAttributes(hwnd, key, alpha, flags) && flags[0] & LWA_ALPHA && alpha[0] === 0
            ? 'alpha-zero'
            : '';
      if (reason) {
        ignoredTransparentWindows.push({ id, pid: pid[0], bounds, extendedStyle: exStyle, reason });
        continue;
      }
    }
    const text = Buffer.alloc(2048);
    const name = Buffer.alloc(512);
    getText(hwnd, text, 1024);
    getClass(hwnd, name, 256);
    // 目标程序可能不支持 DPI；GetDpiForWindow 此时返回 96，不能用作屏幕倍率。
    const monitor = [...monitors].sort((a, b) => {
      const overlap = (m: Rect) =>
        Math.max(0, Math.min(bounds.right, m.right) - Math.max(bounds.left, m.left)) *
        Math.max(0, Math.min(bounds.bottom, m.bottom) - Math.max(bounds.top, m.top));
      return overlap(b) - overlap(a);
    })[0];
    const dpi = monitor.dpi;
    const maximized = Boolean(zoomed(hwnd));
    const fullscreen = monitors.some(
      (m) =>
        bounds.left <= m.left + 1 &&
        bounds.top <= m.top + 1 &&
        bounds.right >= m.right - 1 &&
        bounds.bottom >= m.bottom - 1,
    );
    const tool = (exStyle & WS_EX_TOOLWINDOW) !== 0;
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
    const relative = dwmRect(hwnd, DWMWA_CAPTION_BUTTON_BOUNDS);
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
      windowDpi: getDpi(hwnd) || 96,
      eligible: !reason,
      reason,
      maximized,
      fullscreen,
    });
  }
  return result;
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
export function outerBounds(id: string): Rect {
  const rect: Rect = { left: 0, top: 0, right: 0, bottom: 0 };
  if (!getRect(BigInt(id), rect)) throw new Error(`无法读取窗口 ${id} 的外框。`);
  return rect;
}
export function prepareWindowTest(id: string) {
  const hwnd = BigInt(id);
  const maximized = Boolean(zoomed(hwnd));
  showWindow(hwnd, 9);
  const original: Rect = { left: 0, top: 0, right: 0, bottom: 0 };
  if (!getRect(hwnd, original)) throw new Error(`无法读取测试窗口 ${id} 的位置。`);
  return {
    maximize() {
      showWindow(hwnd, 3);
    },
    move(x: number, y: number) {
      if (!setPosition(hwnd, null, x, y, 0, 0, 0x15)) throw new Error(`无法移动测试窗口 ${id}。`);
    },
    restore() {
      showWindow(hwnd, 9);
      setPosition(hwnd, null, original.left, original.top, 0, 0, 0x15);
      if (maximized) showWindow(hwnd, 3);
    },
  };
}

export function applicationTargets(windows: WindowInfo[]) {
  return [
    ['资源管理器', windows.find((w) => w.className === 'CabinetWClass')],
    ['Chrome', windows.find((w) => w.title.endsWith('Google Chrome'))],
    ['微信', windows.find((w) => w.className === 'Qt51514QWindowIcon')],
    ['VS Code', windows.find((w) => w.title.includes('Visual Studio Code'))],
    ['记事本', windows.find((w) => w.className === 'Notepad')],
    [
      '设置',
      windows.find(
        (w) => w.className === 'ApplicationFrameWindow' && ['设置', 'Settings'].includes(w.title),
      ),
    ],
  ] as const;
}

// 真实回归窗口仅在独立测试子进程里创建，退出进程时由系统销毁。
const createWindow = user.func(
  'void * __stdcall CreateWindowExW(uint32 exStyle, str16 className, str16 title, uint32 style, int x, int y, int width, int height, void * parent, void * menu, void * instance, void * parameter)',
);
const setAlpha = user.func(
  'int __stdcall SetLayeredWindowAttributes(void * hwnd, uint32 key, uint8 alpha, uint32 flags)',
);
export function createNativeFixtures(): void {
  for (const [title, exStyle] of [
    ['M0-B ClickThrough', WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | 8],
    ['M0-B AlphaZero', WS_EX_LAYERED | WS_EX_TOOLWINDOW | 8],
    ['M0-B Legacy', 0],
  ] as const) {
    const oldContext = setDpiContext(-1);
    let hwnd: unknown;
    try {
      hwnd = createWindow(
        exStyle,
        'STATIC',
        title,
        0x00cf0000,
        1500,
        500,
        400,
        250,
        null,
        null,
        null,
        null,
      );
    } finally {
      setDpiContext(oldContext);
    }
    if (!hwnd) throw new Error(`无法创建 ${title} 测试窗口。`);
    if (exStyle & WS_EX_LAYERED) {
      if (!setAlpha(hwnd, 0, title.endsWith('AlphaZero') ? 0 : 1, LWA_ALPHA))
        throw new Error(`无法设置 ${title} 测试窗口的透明度。`);
    }
    showWindow(hwnd, 4);
  }
}
