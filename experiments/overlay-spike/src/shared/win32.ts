// Windows API 绑定（koffi）。主进程和测试脚本共用。
// 正式工程里这类代码只能放在 app/src/main/platform/win/ 下（硬性规则 3）。

import koffi from 'koffi';

const user32 = koffi.load('user32.dll');
const shell32 = koffi.load('shell32.dll');

const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });
const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
  dx: 'long',
  dy: 'long',
  mouseData: 'uint32',
  dwFlags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'uintptr_t',
});
const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
  wVk: 'uint16',
  wScan: 'uint16',
  dwFlags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'uintptr_t',
});
const HARDWAREINPUT = koffi.struct('HARDWAREINPUT', { uMsg: 'uint32', wParamL: 'uint16', wParamH: 'uint16' });
const INPUT_UNION = koffi.union('INPUT_UNION', { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT });
const INPUT = koffi.struct('INPUT', { type: 'uint32', u: INPUT_UNION });

const GetAsyncKeyState = user32.func('short __stdcall GetAsyncKeyState(int vKey)');
const GetCursorPos = user32.func('bool __stdcall GetCursorPos(_Out_ POINT *pt)');
const SendInput = user32.func('uint __stdcall SendInput(uint cInputs, INPUT *pInputs, int cbSize)');
const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int nIndex)');
const SetProcessDpiAwarenessContext = user32.func('bool __stdcall SetProcessDpiAwarenessContext(intptr_t value)');
const GetForegroundWindow = user32.func('intptr_t __stdcall GetForegroundWindow()');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(intptr_t hWnd, _Out_ uint8_t *buf, int n)');
const GetClassNameW = user32.func('int __stdcall GetClassNameW(intptr_t hWnd, _Out_ uint8_t *buf, int n)');
const GetWindowThreadProcessId = user32.func(
  'uint32 __stdcall GetWindowThreadProcessId(intptr_t hWnd, _Out_ uint32 *pid)',
);
const PostMessageW = user32.func('bool __stdcall PostMessageW(intptr_t hWnd, uint msg, uintptr_t w, intptr_t l)');
const IsWindow = user32.func('bool __stdcall IsWindow(intptr_t hWnd)');
const GetWindowLongPtrW = user32.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t hWnd, int index)');
const SHQueryUserNotificationState = shell32.func('int __stdcall SHQueryUserNotificationState(_Out_ int *state)');

export const VK = {
  LBUTTON: 0x01,
  CONTROL: 0x11,
  LCONTROL: 0xa2,
  LWIN: 0x5b,
  SNAPSHOT: 0x2c,
  S: 0x53,
  W: 0x57,
} as const;

export function isKeyDown(vk: number): boolean {
  return (GetAsyncKeyState(vk) & 0x8000) !== 0;
}

/** SHQueryUserNotificationState 的返回值；2/3/4 表示有全屏程序或演示模式 */
export const QUNS = {
  1: 'NOT_PRESENT',
  2: 'BUSY',
  3: 'RUNNING_D3D_FULL_SCREEN',
  4: 'PRESENTATION_MODE',
  5: 'ACCEPTS_NOTIFICATIONS',
  6: 'QUIET_TIME',
  7: 'APP',
} as Record<number, string>;

export function queryUserNotificationState(): number {
  const out = [0];
  const hr = SHQueryUserNotificationState(out);
  return hr === 0 ? out[0] : -1;
}

export function isFullscreenState(state: number): boolean {
  return state === 2 || state === 3 || state === 4;
}

/** 让本进程按物理像素工作（Per-Monitor V2）。测试脚本发送鼠标事件前要先调用。 */
export function setDpiAware(): boolean {
  return SetProcessDpiAwarenessContext(-4);
}

export function cursorPos(): { x: number; y: number } {
  const pt = { x: 0, y: 0 };
  GetCursorPos(pt);
  return pt;
}

function send(input: object): void {
  const n = SendInput(1, input, koffi.sizeof(INPUT));
  if (n !== 1) throw new Error('SendInput 失败（可能被 UIPI 拦截）');
}

const MOUSEEVENTF = { MOVE: 0x1, LEFTDOWN: 0x2, LEFTUP: 0x4, ABSOLUTE: 0x8000, VIRTUALDESK: 0x4000 };

/** 把鼠标移动到物理像素坐标 (x, y)。需要先 setDpiAware()。 */
export function mouseMove(x: number, y: number): void {
  const vx = GetSystemMetrics(76);
  const vy = GetSystemMetrics(77);
  const vw = GetSystemMetrics(78);
  const vh = GetSystemMetrics(79);
  const dx = Math.round(((x - vx) * 65535) / (vw - 1));
  const dy = Math.round(((y - vy) * 65535) / (vh - 1));
  send({
    type: 0,
    u: {
      mi: {
        dx,
        dy,
        mouseData: 0,
        dwFlags: MOUSEEVENTF.MOVE | MOUSEEVENTF.ABSOLUTE | MOUSEEVENTF.VIRTUALDESK,
        time: 0,
        dwExtraInfo: 0,
      },
    },
  });
}

export function mouseButton(down: boolean): void {
  send({
    type: 0,
    u: {
      mi: {
        dx: 0,
        dy: 0,
        mouseData: 0,
        dwFlags: down ? MOUSEEVENTF.LEFTDOWN : MOUSEEVENTF.LEFTUP,
        time: 0,
        dwExtraInfo: 0,
      },
    },
  });
}

export function key(vk: number, down: boolean): void {
  send({ type: 1, u: { ki: { wVk: vk, wScan: 0, dwFlags: down ? 0 : 0x2, time: 0, dwExtraInfo: 0 } } });
}

/** 用 KEYEVENTF_UNICODE 逐字输入文字 */
export function typeText(text: string): void {
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    send({ type: 1, u: { ki: { wVk: 0, wScan: code, dwFlags: 0x4, time: 0, dwExtraInfo: 0 } } });
    send({ type: 1, u: { ki: { wVk: 0, wScan: code, dwFlags: 0x4 | 0x2, time: 0, dwExtraInfo: 0 } } });
  }
}

export function foregroundWindow(): number {
  return Number(GetForegroundWindow());
}

export function windowText(hwnd: number): string {
  const buf = Buffer.alloc(1024);
  const n = GetWindowTextW(hwnd, buf, 512);
  return buf.subarray(0, n * 2).toString('utf16le');
}

export function windowClass(hwnd: number): string {
  const buf = Buffer.alloc(512);
  const n = GetClassNameW(hwnd, buf, 256);
  return buf.subarray(0, n * 2).toString('utf16le');
}

export function windowPid(hwnd: number): number {
  const out = [0];
  GetWindowThreadProcessId(hwnd, out);
  return out[0];
}

export function closeWindow(hwnd: number): void {
  PostMessageW(hwnd, 0x0010, 0, 0); // WM_CLOSE
}

export function windowExists(hwnd: number): boolean {
  return IsWindow(hwnd);
}

/** 读取扩展窗口样式（GWL_EXSTYLE），用来核对 WS_EX_TRANSPARENT / WS_EX_NOACTIVATE */
export function exStyle(hwnd: number): number {
  return Number(GetWindowLongPtrW(hwnd, -20));
}

export const WS_EX = { TRANSPARENT: 0x20, LAYERED: 0x80000, NOACTIVATE: 0x8000000, TOPMOST: 0x8 };

export function hwndOf(handle: Buffer): number {
  return Number(handle.readBigUInt64LE(0));
}
