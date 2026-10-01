// Windows 桌面验收的系统输入工具；不参与正式应用构建。
import koffi from 'koffi';
const user = koffi.load('user32.dll');
const mi = koffi.struct('OverlayCheckMouseInput', {
  dx: 'long',
  dy: 'long',
  mouseData: 'uint32',
  dwFlags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'uintptr_t',
});
const ki = koffi.struct('OverlayCheckKeyInput', {
  wVk: 'uint16',
  wScan: 'uint16',
  dwFlags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'uintptr_t',
});
const hi = koffi.struct('OverlayCheckHardwareInput', {
  uMsg: 'uint32',
  wParamL: 'uint16',
  wParamH: 'uint16',
});
const union = koffi.union('OverlayCheckUnion', { mi, ki, hi });
const input = koffi.struct('OverlayCheckInput', { type: 'uint32', u: union });
const sendInput = user.func(
  'uint __stdcall SendInput(uint count, OverlayCheckInput *inputs, int size)',
) as (count: number, inputs: object, size: number) => number;
const metrics = user.func('int __stdcall GetSystemMetrics(int index)') as (index: number) => number;
const dpi = user.func('bool __stdcall SetProcessDpiAwarenessContext(intptr_t context)') as (
  context: number,
) => boolean;
const foreground = user.func('intptr_t __stdcall GetForegroundWindow()') as () => number | bigint;
const style = user.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t window, int index)') as (
  window: number,
  index: number,
) => number | bigint;
function send(value: object): void {
  if (sendInput(1, value, koffi.sizeof(input)) !== 1) throw new Error('SendInput');
}
export function setDpiAware(): void {
  dpi(-4);
}
export function mouseMove(x: number, y: number): void {
  send({
    type: 0,
    u: {
      mi: {
        dx: Math.round(((x - metrics(76)) * 65535) / (metrics(78) - 1)),
        dy: Math.round(((y - metrics(77)) * 65535) / (metrics(79) - 1)),
        mouseData: 0,
        dwFlags: 0x8000 | 0x4000 | 1,
        time: 0,
        dwExtraInfo: 0,
      },
    },
  });
}
export function mouseButton(down: boolean): void {
  send({
    type: 0,
    u: { mi: { dx: 0, dy: 0, mouseData: 0, dwFlags: down ? 2 : 4, time: 0, dwExtraInfo: 0 } },
  });
}
export function ctrl(down: boolean): void {
  send({
    type: 1,
    u: { ki: { wVk: 0x11, wScan: 0, dwFlags: down ? 0 : 2, time: 0, dwExtraInfo: 0 } },
  });
}
export function foregroundWindow(): number {
  return Number(foreground());
}
export function extendedStyle(window: number): number {
  return Number(style(window, -20));
}
