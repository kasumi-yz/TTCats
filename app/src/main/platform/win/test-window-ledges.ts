// 只供 #114 的真机核对脚本使用；正式应用不导入。
import koffi from 'koffi';
import type { WindowRect } from '../types';

/** 独立读取真实按钮的命中区域，供不暴露标题栏 UI Automation 的应用截图核对。 */
export function captionHitBounds(
  outer: WindowRect,
  scale: number,
  hit: (x: number, y: number) => number,
): WindowRect {
  const codes = [8, 9, 20, 21];
  const row = outer.top + Math.round(20 * scale);
  const positions = new Map<number, number[]>();
  for (let x = outer.left; x < outer.right; x++) {
    const code = hit(x, row);
    if (codes.includes(code)) {
      const xs = positions.get(code) ?? [];
      xs.push(x);
      positions.set(code, xs);
    }
  }
  if (!positions.has(20)) throw new Error('系统命中测试没有找到关闭按钮，不能据此核对截图。');
  const rectangles: WindowRect[] = [];
  for (const [code, xs] of positions) {
    const left = Math.min(...xs),
      right = Math.max(...xs) + 1;
    const x = Math.floor((left + right) / 2);
    const ys: number[] = [];
    for (let y = outer.top; y < Math.min(outer.bottom, outer.top + 100 * scale); y++)
      if (hit(x, y) === code) ys.push(y);
    if (!ys.length || right - left !== xs.length)
      throw new Error('系统按钮命中区域不连续，不能作为矩形参考。');
    rectangles.push({ left, right, top: Math.min(...ys), bottom: Math.max(...ys) + 1 });
  }
  return {
    left: Math.min(...rectangles.map((r) => r.left)),
    right: Math.max(...rectangles.map((r) => r.right)),
    top: Math.min(...rectangles.map((r) => r.top)),
    bottom: Math.max(...rectangles.map((r) => r.bottom)),
  };
}

export function createWindowLedgeTest() {
  const user = koffi.load('user32.dll');
  const point = koffi.struct('LedgeTestPoint', { x: 'long', y: 'long' });
  const rect = koffi.struct('LedgeTestRect', {
    left: 'long',
    top: 'long',
    right: 'long',
    bottom: 'long',
  });
  koffi.struct('LedgeTestPlacement', {
    length: 'uint32',
    flags: 'uint32',
    showCmd: 'uint32',
    ptMinPosition: point,
    ptMaxPosition: point,
    rcNormalPosition: rect,
  });
  const context = user.func(
    'intptr_t __stdcall SetThreadDpiAwarenessContext(intptr_t context)',
  ) as (context: number | bigint) => number | bigint;
  const create = user.func(
    'intptr_t __stdcall CreateWindowExW(uint exStyle, str16 className, str16 title, uint style, int x, int y, int width, int height, intptr_t parent, intptr_t menu, intptr_t instance, intptr_t parameter)',
  ) as (
    exStyle: number,
    className: string,
    title: string,
    style: number,
    x: number,
    y: number,
    width: number,
    height: number,
    parent: number,
    menu: number,
    instance: number,
    parameter: number,
  ) => number | bigint;
  const show = user.func('bool __stdcall ShowWindow(intptr_t window, int command)') as (
    window: bigint,
    command: number,
  ) => boolean;
  const destroy = user.func('bool __stdcall DestroyWindow(intptr_t window)') as (
    window: bigint,
  ) => boolean;
  const position = user.func(
    'bool __stdcall SetWindowPos(intptr_t window, intptr_t after, int x, int y, int width, int height, uint flags)',
  ) as (
    window: bigint,
    after: number,
    x: number,
    y: number,
    width: number,
    height: number,
    flags: number,
  ) => boolean;
  const getPlacement = user.func(
    'bool __stdcall GetWindowPlacement(intptr_t window, _Inout_ LedgeTestPlacement *placement)',
  ) as (window: bigint, placement: object) => boolean;
  const setPlacement = user.func(
    'bool __stdcall SetWindowPlacement(intptr_t window, LedgeTestPlacement *placement)',
  ) as (window: bigint, placement: object) => boolean;
  const outer = user.func(
    'bool __stdcall GetWindowRect(intptr_t window, _Out_ LedgeTestRect *rect)',
  ) as (window: bigint, rect: WindowRect) => boolean;
  const alpha = user.func(
    'bool __stdcall SetLayeredWindowAttributes(intptr_t window, uint key, uint8 alpha, uint flags)',
  ) as (window: bigint, key: number, alpha: number, flags: number) => boolean;
  const visible = user.func('bool __stdcall IsWindowVisible(intptr_t window)') as (
    window: bigint,
  ) => boolean;
  const style = user.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t window, int index)') as (
    window: bigint,
    index: number,
  ) => number | bigint;
  const hitTest = user.func(
    'intptr_t __stdcall SendMessageTimeoutW(intptr_t window, uint message, uintptr_t wParam, intptr_t lParam, uint flags, uint timeout, _Out_ intptr_t *result)',
  ) as (
    window: bigint,
    message: number,
    parameter: number,
    coordinates: number,
    flags: number,
    timeout: number,
    result: (number | bigint)[],
  ) => number | bigint;
  const fixtures: bigint[] = [];
  const previous = context(-4);
  if (BigInt(previous) === 0n) throw new Error('无法设置真机核对的物理坐标。');
  return {
    fixture(title: string, unaware = false, exStyle = 0): string {
      const old = context(unaware ? -1 : -4);
      if (BigInt(old) === 0n) throw new Error('无法设置测试窗口的 DPI 感知方式。');
      let id = 0n,
        failure: unknown;
      try {
        id = BigInt(create(exStyle, 'STATIC', title, 0xcf0000, 100, 100, 600, 400, 0, 0, 0, 0));
        if (id === 0n) throw new Error(`无法创建 ${title} 测试窗口。`);
        fixtures.push(id);
      } catch (error) {
        failure = error;
      }
      if (BigInt(context(old)) === 0n) {
        const restore = new Error('无法恢复创建测试窗口前的 DPI 感知方式。');
        throw failure === undefined
          ? restore
          : new AggregateError([failure, restore], restore.message);
      }
      if (failure !== undefined)
        throw failure instanceof Error
          ? failure
          : new Error('创建测试窗口失败。', { cause: failure });
      if (exStyle & 0x80000) {
        if (!alpha(id, 0, title.endsWith('AlphaZero') ? 0 : 1, 2))
          throw new Error('无法设置测试透明层。');
      }
      show(id, 4);
      return String(id);
    },
    prepare(id: string) {
      const hwnd = BigInt(id);
      const wasVisible = visible(hwnd);
      const wasTopmost = Boolean(Number(style(hwnd, -20)) & 8);
      const placement = {
        length: koffi.sizeof('LedgeTestPlacement'),
        flags: 0,
        showCmd: 0,
        ptMinPosition: { x: 0, y: 0 },
        ptMaxPosition: { x: 0, y: 0 },
        rcNormalPosition: { left: 0, top: 0, right: 0, bottom: 0 },
      };
      if (!getPlacement(hwnd, placement)) throw new Error(`无法保存窗口 ${id} 的原位置。`);
      return {
        move(x: number, y: number, width = 0, height = 0): void {
          show(hwnd, 9);
          if (!position(hwnd, 0, x, y, width, height, width ? 0x14 : 0x15))
            throw new Error(`无法移动窗口 ${id}。`);
        },
        raise(): void {
          if (!position(hwnd, -1, 0, 0, 0, 0, 0x13))
            throw new Error(`无法调整窗口 ${id} 的前后顺序。`);
        },
        minimize(): void {
          show(hwnd, 6);
        },
        maximize(): void {
          show(hwnd, 3);
        },
        hide(): void {
          show(hwnd, 0);
        },
        restore(): void {
          if (!setPlacement(hwnd, placement))
            throw new Error(`无法恢复窗口 ${id} 的原位置和状态。`);
          if (!position(hwnd, wasTopmost ? -1 : -2, 0, 0, 0, 0, 0x13))
            throw new Error(`无法恢复窗口 ${id} 的置顶状态。`);
          if (!wasVisible) show(hwnd, 0);
        },
      };
    },
    outer(id: string): WindowRect {
      const bounds = { left: 0, top: 0, right: 0, bottom: 0 };
      if (!outer(BigInt(id), bounds)) throw new Error(`无法读取窗口 ${id} 的外框。`);
      return bounds;
    },
    captionBounds(id: string, scale: number): WindowRect {
      const bounds = { left: 0, top: 0, right: 0, bottom: 0 };
      const hwnd = BigInt(id);
      if (!outer(hwnd, bounds)) throw new Error('无法读取截图核对窗口的外框。');
      return captionHitBounds(bounds, scale, (x, y) => {
        const value = [0];
        if (
          BigInt(hitTest(hwnd, 0x84, 0, ((y & 0xffff) << 16) | (x & 0xffff), 0x22, 8, value)) === 0n
        )
          throw new Error('窗口没有及时回应按钮命中测试。');
        return Number(value[0]);
      });
    },
    closeFixture(id: string): void {
      const hwnd = BigInt(id);
      if (!fixtures.includes(hwnd)) throw new Error('只允许关闭本轮创建的测试窗口。');
      if (!destroy(hwnd)) throw new Error('无法关闭测试窗口。');
      fixtures.splice(fixtures.indexOf(hwnd), 1);
    },
    dispose(): void {
      const errors: Error[] = [];
      for (const hwnd of fixtures) if (!destroy(hwnd)) errors.push(new Error('无法销毁测试窗口。'));
      if (BigInt(context(previous)) === 0n)
        errors.push(new Error('无法恢复真机核对前的 DPI 感知方式。'));
      if (errors.length) throw new AggregateError(errors, '真机核对收尾失败。');
    },
  };
}
