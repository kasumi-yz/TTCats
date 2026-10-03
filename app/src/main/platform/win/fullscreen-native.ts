// #103 的真机复测入口；正式应用不导入。默认不改设置；自动隐藏复测须先获用户确认。
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { release } from 'node:os';
import { app, BrowserWindow, screen } from 'electron';
import koffi from 'koffi';
import { createWindowsPlatform } from './index';
import { createTestInput } from './test-input';

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const output = process.argv.find((arg) => arg.startsWith('--output='))?.slice(9);
if (!output) throw new Error('请用 --output= 指定实测记录路径');
app.commandLine.appendSwitch('force_low_power_gpu');
// 关闭临时窗口后还必须等设置恢复和记录写完，不能由默认行为提前退出。
app.on('window-all-closed', () => {});

void app.whenReady().then(async () => {
  const user32 = koffi.load('user32.dll');
  const shell32 = koffi.load('shell32.dll');
  koffi.struct('FullscreenTestRect', {
    left: 'long',
    top: 'long',
    right: 'long',
    bottom: 'long',
  });
  const appBarData = koffi.struct('FullscreenTestAppBarData', {
    cbSize: 'uint32',
    hWnd: 'intptr_t',
    uCallbackMessage: 'uint32',
    uEdge: 'uint32',
    rc: 'FullscreenTestRect',
    lParam: 'intptr_t',
  });
  const appBar = shell32.func(
    'uintptr_t __stdcall SHAppBarMessage(uint message, _Inout_ FullscreenTestAppBarData *data)',
  ) as (message: number, data: object) => number | bigint;
  const taskbarState = (value?: number): number =>
    Number(
      appBar(value === undefined ? 4 : 10, {
        cbSize: koffi.sizeof(appBarData),
        hWnd: 0,
        uCallbackMessage: 0,
        uEdge: 0,
        rc: { left: 0, top: 0, right: 0, bottom: 0 },
        lParam: value ?? 0,
      }),
    );
  const originalTaskbarState = taskbarState();
  const changeTaskbar = process.argv.includes('--taskbar-autohide');
  let restoredTaskbarState = originalTaskbarState;
  const getRect = user32.func(
    'bool __stdcall GetWindowRect(intptr_t window, _Out_ FullscreenTestRect *rect)',
  ) as (window: number, rect: Rect) => boolean;
  const getStyle = user32.func(
    'intptr_t __stdcall GetWindowLongPtrW(intptr_t window, int index)',
  ) as (window: number, index: number) => number | bigint;
  const setStyle = user32.func(
    'intptr_t __stdcall SetWindowLongPtrW(intptr_t window, int index, intptr_t value)',
  ) as (window: number, index: number, value: number) => number | bigint;
  const setPosition = user32.func(
    'bool __stdcall SetWindowPos(intptr_t window, intptr_t after, int x, int y, int width, int height, uint flags)',
  ) as (
    window: number,
    after: number,
    x: number,
    y: number,
    width: number,
    height: number,
    flags: number,
  ) => boolean;
  const query = shell32.func('int __stdcall SHQueryUserNotificationState(_Out_ int *state)') as (
    state: number[],
  ) => number;
  const input = createTestInput();
  const restore = user32.func('bool __stdcall SetForegroundWindow(intptr_t window)') as (
    window: number,
  ) => boolean;
  const originalForeground = input.foregroundWindow();
  const originalCursor = input.cursorPos();
  const platform = createWindowsPlatform();
  const display = screen.getPrimaryDisplay();
  const center = {
    x: display.bounds.x + display.bounds.width / 2,
    y: display.bounds.y + display.bounds.height / 2,
  };
  const physical = screen.dipToScreenRect(null, display.bounds);
  const fixture = new BrowserWindow({ width: 800, height: 500, title: 'TTCats #103 临时验证' });
  fixture.setMenu(null);
  const hwnd = Number(fixture.getNativeWindowHandle().readBigUInt64LE());
  const rows: {
    name: string;
    expected: boolean | null;
    state: number;
    className: string;
    style: number;
    bounds: Rect;
    actual: boolean;
    legacy: boolean;
    passed: boolean | null;
  }[] = [];
  const pressed = new Set<number>();
  let errorMessage: string | null = null;
  const key = (vk: number, down: boolean): void => {
    input.key(vk, down);
    if (down) pressed.add(vk);
    else pressed.delete(vk);
  };
  const sample = (name: string, expected: boolean | null): void => {
    const window = input.foregroundWindow();
    const state = [0];
    if (query(state) < 0) throw new Error('实测通知状态查询失败');
    const bounds = { left: 0, top: 0, right: 0, bottom: 0 };
    if (!getRect(window, bounds)) throw new Error('实测窗口位置查询失败');
    const className = input.windowClass(window);
    const style = Number(getStyle(window, -16));
    const covers =
      bounds.left <= physical.x &&
      bounds.top <= physical.y &&
      bounds.right >= physical.x + physical.width &&
      bounds.bottom >= physical.y + physical.height;
    const legacy =
      state[0] === 3 ||
      state[0] === 4 ||
      (state[0] === 2 && covers && !['Progman', 'WorkerW', 'Shell_TrayWnd'].includes(className));
    const actual = platform.isFullscreen(center);
    rows.push({
      name,
      expected,
      state: state[0] ?? 0,
      className,
      style,
      bounds,
      actual,
      legacy,
      passed: expected === null ? null : actual === expected,
    });
  };
  const focusFixture = async (): Promise<void> => {
    fixture.setAlwaysOnTop(true);
    fixture.show();
    fixture.focus();
    await wait(300);
    if (input.foregroundWindow() !== hwnd) {
      const b = fixture.getBounds();
      const point = screen.dipToScreenPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
      if (input.rootWindowAt(point.x, point.y) !== hwnd)
        throw new Error(
          `临时窗口被其他窗口遮住，停止输入模拟：${JSON.stringify({
            hwnd,
            foreground: input.foregroundWindow(),
            b,
            point,
            root: input.rootWindowAt(point.x, point.y),
            rootClass: input.windowClass(input.rootWindowAt(point.x, point.y)),
          })}`,
        );
      input.mouseMove(point.x, point.y);
      input.mouseButton(true);
      input.mouseButton(false);
      key(0x12, true);
      key(0x12, false);
      restore(hwnd);
      fixture.focus();
      await wait(600);
    }
    if (input.foregroundWindow() !== hwnd)
      throw new Error(
        `临时窗口未取得焦点，停止输入模拟：${input.windowClass(input.foregroundWindow())}`,
      );
    fixture.setAlwaysOnTop(false);
  };
  try {
    await fixture.loadURL(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          '<title>TTCats #103 临时验证</title><h1>全屏检测临时窗口</h1><p>测试结束后自动关闭。</p>',
        ),
    );
    fixture.webContents.on('before-input-event', (_event, event) => {
      if (event.type === 'keyDown' && event.key === 'F11')
        fixture.setFullScreen(!fixture.isFullScreen());
    });
    await focusFixture();
    sample('普通窗口', false);
    fixture.maximize();
    await wait(400);
    sample('真实最大化（当前工作区）', false);
    // 不改工作区，给临时窗口设置等价的最大化位和整屏矩形。
    fixture.unmaximize();
    await wait(200);
    if (!setPosition(hwnd, 0, physical.x, physical.y, physical.width, physical.height, 0x14))
      throw new Error('临时最大化窗口扩展失败');
    setStyle(hwnd, -16, Number(getStyle(hwnd, -16)) | 0x01000000);
    await wait(300);
    sample('带标题栏最大化且盖满屏幕（等价几何）', false);
    const maximized = rows.at(-1);
    if (
      !maximized ||
      (maximized.style & 0x01c00000) !== 0x01c00000 ||
      maximized.bounds.left > physical.x ||
      maximized.bounds.top > physical.y ||
      maximized.bounds.right < physical.x + physical.width ||
      maximized.bounds.bottom < physical.y + physical.height
    )
      throw new Error('未构造出带完整标题栏、盖满屏幕的最大化窗口');
    fixture.unmaximize();
    await wait(300);
    if (changeTaskbar) {
      taskbarState(originalTaskbarState | 1);
      await wait(700);
      if ((taskbarState() & 1) === 0) throw new Error('任务栏自动隐藏设置未生效');
      fixture.maximize();
      await wait(500);
      sample('真实任务栏自动隐藏下的最大化窗口', false);
      fixture.unmaximize();
      await wait(300);
    }
    await focusFixture();
    key(0x7a, true);
    key(0x7a, false);
    await wait(600);
    sample('按 F11 进入全屏', true);
    key(0x7a, true);
    key(0x7a, false);
    await wait(400);
    sample('按 F11 退出全屏', false);
    fixture.setKiosk(true);
    await wait(600);
    sample('无边框演示窗口（等价全屏）', true);
    fixture.setKiosk(false);
    await wait(400);
    sample('退出无边框演示窗口', false);
    for (const [name, modifier, trigger] of [
      ['Alt+Tab', 0x12, 0x09],
      ['任务视图', 0x5b, 0x09],
      ['贴靠布局', 0x5b, 0x5a],
      ['表情面板', 0x5b, 0xbe],
      ['剪贴板面板', 0x5b, 0x56],
    ] as const) {
      await focusFixture();
      key(modifier, true);
      key(trigger, true);
      key(trigger, false);
      if (modifier !== 0x12) key(modifier, false);
      for (let i = 0; i < 15; i++) {
        await wait(50);
        sample(name, false);
      }
      key(0x1b, true);
      key(0x1b, false);
      if (pressed.has(modifier)) key(modifier, false);
      await wait(200);
    }
    await focusFixture();
    key(0x5b, true);
    key(0x44, true);
    key(0x44, false);
    key(0x5b, false);
    await wait(300);
    sample('显示桌面', false);
  } catch (error) {
    errorMessage = String(error);
    console.error(error);
    process.exitCode = 1;
  } finally {
    for (const vk of pressed) input.key(vk, false);
    fixture.destroy();
    if (changeTaskbar) {
      taskbarState(originalTaskbarState);
      await wait(500);
      restoredTaskbarState = taskbarState();
      if (restoredTaskbarState !== originalTaskbarState) {
        console.error(
          '任务栏设置没有恢复，原值：',
          originalTaskbarState,
          '现值：',
          restoredTaskbarState,
        );
        process.exitCode = 1;
      }
    }
    input.mouseMove(originalCursor.x, originalCursor.y);
    restore(originalForeground);
    const result = {
      timestamp: new Date().toISOString(),
      machine: process.env['COMPUTERNAME'],
      windows: release(),
      electron: process.versions.electron,
      display: {
        bounds: display.bounds,
        workArea: display.workArea,
        scaleFactor: display.scaleFactor,
      },
      taskbar: { changedWithPermission: changeTaskbar, originalTaskbarState, restoredTaskbarState },
      error: errorMessage,
      sampleCount: rows.length,
      rows,
    };
    writeFileSync(resolve(output), JSON.stringify(result, null, 2) + '\n');
    console.log(
      JSON.stringify(
        {
          output,
          failures: rows.filter((r) => r.passed === false),
          observed: [
            ...new Set(
              rows.map(
                (r) => `${r.name}: ${r.className}, state=${r.state}, fullscreen=${r.actual}`,
              ),
            ),
          ],
        },
        null,
        2,
      ),
    );
    if (rows.some((r) => r.passed === false)) process.exitCode = 1;
    app.exit(Number(process.exitCode ?? 0));
  }
});
