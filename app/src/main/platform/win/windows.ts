import koffi from 'koffi';
import type { WindowInfo, WindowMonitor, WindowRect } from '../types';
import { titlebarButtons, validRect } from './window-geometry';

const SHELL = ['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd'];
const emptyRect = (): WindowRect => ({ left: 0, top: 0, right: 0, bottom: 0 });

function createBindings() {
  const user = koffi.load('user32.dll');
  const dwm = koffi.load('dwmapi.dll');
  const rect = koffi.struct('LedgeWindowRect', {
    left: 'long',
    top: 'long',
    right: 'long',
    bottom: 'long',
  });
  koffi.struct('LedgeTitlebarInfo', {
    cbSize: 'uint32',
    rcTitleBar: rect,
    rgstate: koffi.array('uint32', 6),
    rgrect: koffi.array(rect, 6),
  });
  koffi.proto('bool __stdcall LedgeEnumWindowsProc(intptr_t hwnd, intptr_t parameter)');
  return {
    rect,
    enumerate: user.func(
      'bool __stdcall EnumWindows(LedgeEnumWindowsProc *callback, intptr_t parameter)',
    ) as (callback: (id: number | bigint) => boolean, parameter: number) => boolean,
    top: user.func('intptr_t __stdcall GetTopWindow(intptr_t window)') as (
      window: number,
    ) => number | bigint,
    next: user.func('intptr_t __stdcall GetWindow(intptr_t window, uint command)') as (
      window: bigint,
      command: number,
    ) => number | bigint,
    exists: user.func('bool __stdcall IsWindow(intptr_t window)') as (window: bigint) => boolean,
    visible: user.func('bool __stdcall IsWindowVisible(intptr_t window)') as (
      window: bigint,
    ) => boolean,
    minimized: user.func('bool __stdcall IsIconic(intptr_t window)') as (window: bigint) => boolean,
    maximized: user.func('bool __stdcall IsZoomed(intptr_t window)') as (window: bigint) => boolean,
    pid: user.func('uint __stdcall GetWindowThreadProcessId(intptr_t window, _Out_ uint *pid)') as (
      window: bigint,
      pid: number[],
    ) => number,
    className: user.func('int __stdcall GetClassNameW(intptr_t window, void *name, int max)') as (
      window: bigint,
      buffer: Buffer,
      max: number,
    ) => number,
    style: user.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t window, int index)') as (
      window: bigint,
      index: number,
    ) => number | bigint,
    outer: user.func(
      'bool __stdcall GetWindowRect(intptr_t window, _Out_ LedgeWindowRect *rect)',
    ) as (window: bigint, rect: WindowRect) => boolean,
    dpi: user.func('uint __stdcall GetDpiForWindow(intptr_t window)') as (window: bigint) => number,
    context: user.func('intptr_t __stdcall GetWindowDpiAwarenessContext(intptr_t window)') as (
      window: bigint,
    ) => number | bigint,
    awareness: user.func('int __stdcall GetAwarenessFromDpiAwarenessContext(intptr_t context)') as (
      context: number | bigint,
    ) => number,
    setContext: user.func('intptr_t __stdcall SetThreadDpiAwarenessContext(intptr_t context)') as (
      context: number | bigint,
    ) => number | bigint,
    attribute: dwm.func(
      'long __stdcall DwmGetWindowAttribute(intptr_t window, uint attribute, void *value, uint size)',
    ) as (window: bigint, attribute: number, buffer: Buffer, size: number) => number,
    alpha: user.func(
      'bool __stdcall GetLayeredWindowAttributes(intptr_t window, _Out_ uint *key, _Out_ uint8 *alpha, _Out_ uint *flags)',
    ) as (window: bigint, key: number[], alpha: number[], flags: number[]) => boolean,
    titlebar: user.func(
      'intptr_t __stdcall SendMessageTimeoutW(intptr_t window, uint message, uintptr_t wParam, _Inout_ LedgeTitlebarInfo *info, uint flags, uint timeout, _Out_ uintptr_t *result)',
    ) as (
      window: bigint,
      message: number,
      parameter: number,
      info: { cbSize: number; rcTitleBar: WindowRect; rgstate: number[]; rgrect: WindowRect[] },
      flags: number,
      timeout: number,
      result: (number | bigint)[],
    ) => number | bigint,
  };
}

let native: ReturnType<typeof createBindings> | undefined;

/** 独立 Z 序来源，不假设 EnumWindows 的回调顺序。变化中的链只重试三次，不能死循环。 */
export function windowsInZOrder(api: {
  enumerate(callback: (id: number | bigint) => boolean, parameter: number): boolean;
  top(window: number): number | bigint;
  next(window: bigint, command: number): number | bigint;
  exists(window: bigint): boolean;
}): bigint[] {
  for (let attempt = 0; attempt < 3; attempt++) {
    const snapshot = new Set<bigint>();
    if (
      !api.enumerate((id) => {
        snapshot.add(BigInt(id));
        return true;
      }, 0)
    )
      throw new Error('无法读取窗口列表。');
    const seen = new Set<bigint>();
    const ordered: bigint[] = [];
    let current = BigInt(api.top(0));
    while (current !== 0n && !seen.has(current) && seen.size < 10000) {
      seen.add(current);
      if (snapshot.has(current)) ordered.push(current);
      current = BigInt(api.next(current, 2));
    }
    if (current === 0n && [...snapshot].every((id) => seen.has(id) || !api.exists(id)))
      return ordered;
  }
  throw new Error('窗口前后顺序正在变化，三次读取仍不一致，请重新采样。');
}

/** 调用时才加载 DLL；导入模块不会启动轮询或影响 Linux CI。 */
export function readWindows(
  monitors: readonly WindowMonitor[],
  excludedPids = [process.pid],
): WindowInfo[] {
  if (process.platform !== 'win32') throw new Error('窗口列表只能在 Windows 桌面读取。');
  if (
    !monitors.length ||
    monitors.some(
      (m) => !validRect(m.bounds) || !Number.isFinite(m.scaleFactor) || m.scaleFactor <= 0,
    )
  )
    throw new Error('读取窗口前必须提供有效的显示器范围及缩放。');
  const api = (native ??= createBindings());
  const previous = api.setContext(-4);
  if (BigInt(previous) === 0n) throw new Error('无法切换窗口查询线程到物理像素坐标。');
  let failure: unknown;
  const result: WindowInfo[] = [];
  try {
    const dwmRect = (id: bigint, attribute: number): WindowRect | null => {
      const buffer = Buffer.alloc(16);
      if (api.attribute(id, attribute, buffer, 16) !== 0) return null;
      const value = koffi.decode(buffer, api.rect) as WindowRect;
      return validRect(value) ? value : null;
    };
    for (const id of windowsInZOrder(api)) {
      const pid = [0];
      if (!api.pid(id, pid) || excludedPids.includes(pid[0] ?? 0)) continue;
      const outer = emptyRect();
      if (!api.outer(id, outer)) {
        if (!api.exists(id)) continue;
        throw new Error(`无法读取窗口 ${String(id)} 的位置。`);
      }
      const bounds = dwmRect(id, 9) ?? outer;
      if (!validRect(bounds)) continue;
      const visible = api.visible(id);
      const minimized = api.minimized(id);
      const maximized = api.maximized(id);
      const cloak = Buffer.alloc(4);
      if (api.attribute(id, 14, cloak, 4) !== 0) {
        if (!api.exists(id)) continue;
        throw new Error(`无法读取窗口 ${String(id)} 的系统隐藏状态。`);
      }
      const cloaked = cloak.readUInt32LE() !== 0;
      const classBuffer = Buffer.alloc(512);
      const length = api.className(id, classBuffer, 256);
      const className = classBuffer.toString('utf16le', 0, Math.max(0, length) * 2);
      const awareness = api.awareness(api.context(id));
      if (awareness < 0) {
        if (!api.exists(id)) continue;
        throw new Error(`无法读取窗口 ${String(id)} 的 DPI 感知方式。`);
      }
      const dpiAwareness = awareness === 0 ? 'unaware' : awareness === 1 ? 'system' : 'per-monitor';
      const windowDpi = api.dpi(id);
      if (!windowDpi) {
        if (!api.exists(id)) continue;
        throw new Error(`无法读取窗口 ${String(id)} 的 DPI。`);
      }
      const overlap = (monitor: WindowMonitor): number =>
        Math.max(
          0,
          Math.min(bounds.right, monitor.bounds.right) - Math.max(bounds.left, monitor.bounds.left),
        ) *
        Math.max(
          0,
          Math.min(bounds.bottom, monitor.bounds.bottom) - Math.max(bounds.top, monitor.bounds.top),
        );
      const monitor = monitors.reduce((best, m) => (overlap(m) > overlap(best) ? m : best));
      const fullscreen = monitors.some(
        ({ bounds: m }) =>
          bounds.left <= m.left + 1 &&
          bounds.top <= m.top + 1 &&
          bounds.right >= m.right - 1 &&
          bounds.bottom >= m.bottom - 1,
      );
      const exStyle = Number(api.style(id, -20));
      let transparent = false;
      if (exStyle & 0x80000) {
        const alpha = [255],
          flags = [0],
          key = [0];
        // 和 M0 的 Codex 透明层回归一致。其他工具窗口仍然参与遮挡。
        transparent =
          Boolean(exStyle & 0x20) ||
          (api.alpha(id, key, alpha, flags) && Boolean((flags[0] ?? 0) & 2) && alpha[0] === 0);
      }
      const occludes =
        visible &&
        !minimized &&
        !cloaked &&
        !transparent &&
        !['Progman', 'WorkerW'].includes(className);
      let reason = !visible
        ? 'invisible'
        : minimized
          ? 'minimized'
          : cloaked
            ? 'cloaked'
            : transparent
              ? 'transparent'
              : SHELL.includes(className)
                ? 'shell'
                : exStyle & 0x80
                  ? 'tool'
                  : bounds.right - bounds.left < 160 * monitor.scaleFactor ||
                      bounds.bottom - bounds.top < 80 * monitor.scaleFactor
                    ? 'small'
                    : maximized
                      ? 'maximized'
                      : fullscreen
                        ? 'fullscreen'
                        : '';
      let buttons: WindowRect | null = null;
      let buttonsSource: WindowInfo['buttonsSource'] = 'none';
      if (!reason) {
        // 老程序不使用 M0 的 DWM 混合单位公式。读取系统标题栏的绝对屏幕坐标。
        if (dpiAwareness !== 'per-monitor') {
          const info = {
            cbSize: koffi.sizeof('LedgeTitlebarInfo'),
            rcTitleBar: emptyRect(),
            rgstate: Array<number>(6).fill(0),
            rgrect: Array.from({ length: 6 }, emptyRect),
          };
          if (BigInt(api.titlebar(id, 0x33f, 0, info, 0x22, 8, [0])) !== 0n)
            buttons = titlebarButtons(info.rgrect, info.rgstate, outer);
          if (buttons) buttonsSource = 'titlebar';
        }
        if (!buttons && dpiAwareness === 'per-monitor') {
          const relative = dwmRect(id, 5);
          if (relative) {
            buttons = {
              left: outer.left + relative.left,
              right: outer.left + relative.right,
              top: outer.top + relative.top,
              bottom: outer.top + relative.bottom,
            };
            buttonsSource = 'dwm';
          }
        }
        if (!buttons && dpiAwareness !== 'per-monitor') reason = 'buttons-unavailable';
        else if (!buttons) {
          buttons = {
            left: Math.max(bounds.left, bounds.right - 160 * monitor.scaleFactor),
            right: bounds.right,
            top: bounds.top,
            bottom: bounds.top + 40 * monitor.scaleFactor,
          };
          buttonsSource = 'fallback';
        }
      }
      if (!api.exists(id)) continue;
      result.push({
        id: String(id),
        pid: pid[0] ?? 0,
        className,
        bounds,
        buttons,
        buttonsSource,
        dpiAwareness,
        windowDpi,
        visible,
        minimized,
        maximized,
        fullscreen,
        cloaked,
        occludes,
        eligible: !reason,
        reason,
      });
    }
  } catch (error) {
    failure = error;
  }
  if (BigInt(api.setContext(previous)) === 0n) {
    const restore = new Error('窗口查询后无法恢复线程的 DPI 感知方式。');
    if (failure !== undefined) throw new AggregateError([failure, restore], restore.message);
    throw restore;
  }
  if (failure !== undefined)
    throw failure instanceof Error ? failure : new Error('窗口列表查询失败。', { cause: failure });
  return result;
}
