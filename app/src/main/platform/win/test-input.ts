// 真实桌面交互测试（#29）用的系统级鼠标键盘模拟和窗口查询。
// 只给 app/scripts/interaction-test.ts 等验收脚本用，正式应用不导入本文件。
// SendInput 发出的事件和真人操作走同一条系统输入路径；坐标一律是物理像素。
import koffi from 'koffi';

/** 测试会用到的虚拟键码。 */
export const VK = {
  CONTROL: 0x11,
  LCONTROL: 0xa2,
  ESCAPE: 0x1b,
  S: 0x53,
  W: 0x57,
} as const;

/** GetWindowLongPtr(GWL_EXSTYLE) 里测试关心的位。 */
export const WS_EX = {
  TOPMOST: 0x8,
  TRANSPARENT: 0x20,
  NOACTIVATE: 0x8000000,
} as const;

export type MouseButton = 'primary' | 'secondary';

export interface TestInput {
  /** 让本进程按物理像素读写坐标（Per-Monitor V2）。返回是否成功。 */
  setDpiAware(): boolean;
  cursorPos(): { x: number; y: number };
  mouseMove(x: number, y: number): void;
  /** primary 是系统设置里的主按钮；交换左右键后自动改发物理右键。 */
  mouseButton(down: boolean, button?: MouseButton): void;
  key(vk: number, down: boolean): void;
  /** 按 Unicode 字符逐个输入，不受键盘布局和输入法影响。 */
  typeText(text: string): void;
  /** 按键当前是否按下（只读当前按下位）。 */
  isKeyDown(vk: number): boolean;
  foregroundWindow(): number;
  extendedStyle(window: number): number;
  windowText(window: number): string;
  windowClass(window: number): string;
  windowExists(window: number): boolean;
  isWindowVisible(window: number): boolean;
  /** 发 WM_CLOSE，相当于点窗口右上角的关闭。 */
  closeWindow(window: number): void;
  /** upper 在 Z 序里是否位于 lower 上面。 */
  isAbove(upper: number, lower: number): boolean;
  /** 某个物理像素点上、会接收鼠标的顶层窗口。 */
  rootWindowAt(x: number, y: number): number;
  /** 当前是否有可见的系统弹出菜单（窗口类 #32768）。 */
  popupMenuVisible(): boolean;
}

const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;
const MOUSEEVENTF = {
  MOVE: 0x1,
  LEFTDOWN: 0x2,
  LEFTUP: 0x4,
  RIGHTDOWN: 0x8,
  RIGHTUP: 0x10,
  VIRTUALDESK: 0x4000,
  ABSOLUTE: 0x8000,
} as const;
const KEYEVENTF = { KEYUP: 0x2, UNICODE: 0x4 } as const;
const SM = {
  SWAPBUTTON: 23,
  XVIRTUALSCREEN: 76,
  YVIRTUALSCREEN: 77,
  CXVIRTUALSCREEN: 78,
  CYVIRTUALSCREEN: 79,
} as const;
const GWL_EXSTYLE = -20;
const GW_HWNDPREV = 3;
const GA_ROOT = 2;
const WM_CLOSE = 0x10;
const DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4;

/** 把物理像素换成 SendInput 绝对坐标（整个虚拟桌面映射到 0～65535）。 */
export function toAbsolute(value: number, origin: number, size: number): number {
  return Math.round(((value - origin) * 65535) / Math.max(1, size - 1));
}

export function createTestInput(): TestInput {
  const user32 = koffi.load('user32.dll');
  const mouseInput = koffi.struct('TestMouseInput', {
    dx: 'long',
    dy: 'long',
    mouseData: 'uint32',
    dwFlags: 'uint32',
    time: 'uint32',
    dwExtraInfo: 'uintptr_t',
  });
  const keyInput = koffi.struct('TestKeyInput', {
    wVk: 'uint16',
    wScan: 'uint16',
    dwFlags: 'uint32',
    time: 'uint32',
    dwExtraInfo: 'uintptr_t',
  });
  const hardwareInput = koffi.struct('TestHardwareInput', {
    uMsg: 'uint32',
    wParamL: 'uint16',
    wParamH: 'uint16',
  });
  const inputUnion = koffi.union('TestInputUnion', {
    mi: mouseInput,
    ki: keyInput,
    hi: hardwareInput,
  });
  const input = koffi.struct('TestInput', { type: 'uint32', u: inputUnion });
  koffi.struct('TestPoint', { x: 'long', y: 'long' });

  const sendInput = user32.func(
    'uint __stdcall SendInput(uint count, TestInput *inputs, int size)',
  ) as (count: number, inputs: object, size: number) => number;
  const getSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int index)') as (
    index: number,
  ) => number;
  const setDpiContext = user32.func(
    'bool __stdcall SetProcessDpiAwarenessContext(intptr_t context)',
  ) as (context: number) => boolean;
  const getCursorPos = user32.func(
    'bool __stdcall GetCursorPos(_Out_ TestPoint *point)',
  ) as (point: { x: number; y: number }) => boolean;
  const getAsyncKeyState = user32.func('short __stdcall GetAsyncKeyState(int key)') as (
    key: number,
  ) => number;
  const getForegroundWindow = user32.func('intptr_t __stdcall GetForegroundWindow()') as () =>
    number | bigint;
  const getWindowLongPtr = user32.func(
    'intptr_t __stdcall GetWindowLongPtrW(intptr_t window, int index)',
  ) as (window: number, index: number) => number | bigint;
  const getWindowText = user32.func(
    'int __stdcall GetWindowTextW(intptr_t window, void *text, int max)',
  ) as (window: number, text: Buffer, max: number) => number;
  const getClassName = user32.func(
    'int __stdcall GetClassNameW(intptr_t window, void *text, int max)',
  ) as (window: number, text: Buffer, max: number) => number;
  const isWindow = user32.func('bool __stdcall IsWindow(intptr_t window)') as (
    window: number,
  ) => boolean;
  const isWindowVisible = user32.func('bool __stdcall IsWindowVisible(intptr_t window)') as (
    window: number,
  ) => boolean;
  const postMessage = user32.func(
    'bool __stdcall PostMessageW(intptr_t window, uint message, uintptr_t wParam, intptr_t lParam)',
  ) as (window: number, message: number, wParam: number, lParam: number) => boolean;
  const getWindow = user32.func('intptr_t __stdcall GetWindow(intptr_t window, uint command)') as (
    window: number,
    command: number,
  ) => number | bigint;
  const windowFromPoint = user32.func(
    'intptr_t __stdcall WindowFromPoint(TestPoint point)',
  ) as (point: { x: number; y: number }) => number | bigint;
  const getAncestor = user32.func(
    'intptr_t __stdcall GetAncestor(intptr_t window, uint flags)',
  ) as (window: number, flags: number) => number | bigint;
  const findWindow = user32.func(
    'intptr_t __stdcall FindWindowW(str16 className, str16 title)',
  ) as (className: string, title: string | null) => number | bigint;

  const send = (value: object): void => {
    if (sendInput(1, value, koffi.sizeof(input)) !== 1) throw new Error('SendInput');
  };
  const mouse = (dwFlags: number, dx = 0, dy = 0): void => {
    send({
      type: INPUT_MOUSE,
      u: { mi: { dx, dy, mouseData: 0, dwFlags, time: 0, dwExtraInfo: 0 } },
    });
  };
  const keyboard = (wVk: number, wScan: number, dwFlags: number): void => {
    send({ type: INPUT_KEYBOARD, u: { ki: { wVk, wScan, dwFlags, time: 0, dwExtraInfo: 0 } } });
  };
  const text = (read: (buffer: Buffer, max: number) => number): string => {
    const buffer = Buffer.alloc(1024);
    const length = read(buffer, 512);
    return buffer.toString('utf16le', 0, Math.max(0, length) * 2);
  };

  return {
    setDpiAware: () => setDpiContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2),
    cursorPos() {
      const point = { x: 0, y: 0 };
      if (!getCursorPos(point)) throw new Error('GetCursorPos');
      return point;
    },
    mouseMove(x, y) {
      mouse(
        MOUSEEVENTF.MOVE | MOUSEEVENTF.VIRTUALDESK | MOUSEEVENTF.ABSOLUTE,
        toAbsolute(x, getSystemMetrics(SM.XVIRTUALSCREEN), getSystemMetrics(SM.CXVIRTUALSCREEN)),
        toAbsolute(y, getSystemMetrics(SM.YVIRTUALSCREEN), getSystemMetrics(SM.CYVIRTUALSCREEN)),
      );
    },
    mouseButton(down, button = 'primary') {
      // SendInput 的 LEFT/RIGHT 指物理按钮；交换左右键后主按钮是物理右键。
      const swapped = getSystemMetrics(SM.SWAPBUTTON) !== 0;
      const left = (button === 'primary') !== swapped;
      mouse(
        left
          ? down
            ? MOUSEEVENTF.LEFTDOWN
            : MOUSEEVENTF.LEFTUP
          : down
            ? MOUSEEVENTF.RIGHTDOWN
            : MOUSEEVENTF.RIGHTUP,
      );
    },
    key(vk, down) {
      keyboard(vk, 0, down ? 0 : KEYEVENTF.KEYUP);
    },
    typeText(value) {
      for (const char of value) {
        const code = char.charCodeAt(0);
        keyboard(0, code, KEYEVENTF.UNICODE);
        keyboard(0, code, KEYEVENTF.UNICODE | KEYEVENTF.KEYUP);
      }
    },
    isKeyDown: (vk) => (getAsyncKeyState(vk) & 0x8000) !== 0,
    foregroundWindow: () => Number(getForegroundWindow()),
    extendedStyle: (window) => Number(getWindowLongPtr(window, GWL_EXSTYLE)),
    windowText: (window) => text((buffer, max) => getWindowText(window, buffer, max)),
    windowClass: (window) => text((buffer, max) => getClassName(window, buffer, max)),
    windowExists: (window) => isWindow(window),
    isWindowVisible: (window) => isWindowVisible(window),
    closeWindow(window) {
      postMessage(window, WM_CLOSE, 0, 0);
    },
    isAbove(upper, lower) {
      // 从 lower 往上走 Z 序，遇到 upper 说明它在上面；窗口数有限，设上限防止异常时死循环。
      let current = lower;
      for (let i = 0; i < 10000; i++) {
        current = Number(getWindow(current, GW_HWNDPREV));
        if (current === 0) return false;
        if (current === upper) return true;
      }
      return false;
    },
    rootWindowAt(x, y) {
      const window = Number(windowFromPoint({ x, y }));
      return window === 0 ? 0 : Number(getAncestor(window, GA_ROOT));
    },
    popupMenuVisible() {
      const menu = Number(findWindow('#32768', null));
      return menu !== 0 && isWindowVisible(menu);
    },
  };
}
