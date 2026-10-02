import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
// eslint-disable-next-line no-restricted-imports -- 临时目录仅用于测试。
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow, IpcMain, IpcMainEvent } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../shared/ipc';
import { CURRENT_SAVE_VERSION, GameStateSchema } from '../../shared/schemas/save';
import { defaultSettings } from '../../shared/schemas/settings';
import { zh } from '../../shared/strings.zh-CN';
import { FileLog } from '../log';
import { SaveStore } from '../save';
import {
  attachCrashCommand,
  attachRecovery,
  LOAD_FAILURE_GRACE_MS,
  type RecoveryOptions,
} from './index';

const native = vi.hoisted(() => ({ showMessageBox: vi.fn(), openPath: vi.fn() }));
vi.mock('electron', () => ({ dialog: native, shell: native }));
const directories: string[] = [];
const disposers: (() => void)[] = [];

afterEach(() => {
  disposers.splice(0).forEach((dispose) => {
    dispose();
  });
  vi.useRealTimers();
  vi.clearAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true });
});

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}

function setup(extra: Partial<RecoveryOptions> = {}) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'ttcats-recovery-test-'));
  directories.push(directory);
  const log = new FileLog({ directory: join(directory, 'logs') });
  const save = new SaveStore({
    directory,
    currentVersion: CURRENT_SAVE_VERSION,
    schema: GameStateSchema,
    defaultState: () => ({ settings: defaultSettings([]) }),
    now: () => 1000,
    log: (message) => {
      log.write(message);
    },
  });
  save.requestSave({ settings: defaultSettings(['backup-cat']) });
  save.flush();
  save.requestSave({ settings: defaultSettings(['active-cat']) });
  save.flush();
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isLoadingMainFrame: vi.fn(() => false),
    executeJavaScript: vi.fn(() => Promise.resolve(0)),
    forcefullyCrashRenderer: vi.fn(() =>
      contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 }),
    ),
  });
  const overlay = Object.assign(new EventEmitter(), {
    webContents: contents,
    isDestroyed: () => false,
    setIgnoreMouseEvents: vi.fn(),
    hide: vi.fn(),
  });
  const applySafeMode = vi.fn<RecoveryOptions['applySafeMode']>();
  const reload = vi.fn<RecoveryOptions['reload']>();
  const notify = vi.fn<NonNullable<RecoveryOptions['notify']>>();
  let now = 10000;
  let monotonic = 10000;
  const options: RecoveryOptions = {
    overlay: overlay as unknown as BrowserWindow,
    save,
    log,
    defaultState: () => ({ settings: defaultSettings([]) }),
    activeCats: () => ['active-cat', 'other-cat'],
    catName: (id) => (id === 'active-cat' ? '测试猫' : '另一只测试猫'),
    now: () => now,
    monotonicNow: () => monotonic,
    applySafeMode,
    reload,
    notify,
    ...extra,
  };
  const recovery = attachRecovery(options);
  disposers.push(recovery.dispose);
  return {
    directory,
    contents,
    overlay,
    save,
    applySafeMode,
    reload,
    notify,
    recovery,
    setNow: (time: number) => {
      now = time;
      monotonic = time;
    },
    setWallTime: (time: number) => {
      now = time;
    },
    setMonotonic: (time: number) => {
      monotonic = time;
    },
  };
}

describe('故障恢复保留存档并停止不安全的重试', () => {
  it('前三次重载，第四次回退真实备份并保守停用活动猫咪包，绝不改原存档', async () => {
    const onSafeMode = vi.fn();
    const target = setup({ onSafeMode });
    const original = fs.readFileSync(target.save.file, 'utf8');
    for (let index = 0; index < 4; index++) {
      target.recovery.crash();
      await settle();
    }
    expect(target.reload).toHaveBeenCalledTimes(3);
    expect(onSafeMode).toHaveBeenCalledOnce();
    expect(onSafeMode.mock.invocationCallOrder[0]).toBeLessThan(
      target.applySafeMode.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(target.applySafeMode).toHaveBeenCalledWith({
      state: { settings: defaultSettings(['backup-cat']) },
      disabledCats: ['active-cat', 'other-cat'],
      source: 'backup',
    });
    expect(target.notify).toHaveBeenCalledWith(expect.stringContaining('进入安全模式'));
    expect(target.overlay.hide).toHaveBeenCalledOnce();
    expect(fs.readFileSync(target.save.file, 'utf8')).toBe(original);
    target.recovery.crash();
    await settle();
    expect(target.contents.forcefullyCrashRenderer).toHaveBeenCalledTimes(4);
  });

  it('有明确且属于活动猫的错误来源时，仅停用该猫咪包', async () => {
    const target = setup({ faultedCat: () => 'other-cat' });
    for (let index = 0; index < 4; index++) {
      target.recovery.crash();
      await settle();
    }
    expect(target.applySafeMode.mock.calls[0]?.[0].disabledCats).toEqual(['other-cat']);
    expect(target.notify).toHaveBeenCalledWith(expect.stringContaining('另一只测试猫'));
    expect(target.notify.mock.calls[0]?.[0]).not.toContain('无法确定故障来源');
    expect(target.notify.mock.calls[0]?.[0]).toContain('桌面上的猫不会再出现');
  });

  it('没有备份时使用默认设置并说明原因，不能重新读故障主存档', async () => {
    const target = setup();
    for (const name of fs
      .readdirSync(target.directory)
      .filter((name) => name.startsWith('save.backup.')))
      fs.unlinkSync(join(target.directory, name));
    for (let index = 0; index < 4; index++) {
      target.recovery.crash();
      await settle();
    }
    expect(target.applySafeMode.mock.calls[0]?.[0].source).toBe('default');
    expect(target.applySafeMode.mock.calls[0]?.[0].state.settings.visibleCats).toEqual([]);
    expect(target.notify).toHaveBeenCalledWith(expect.stringContaining('原存档仍保留'));
  });

  it('重载期间新渲染进程立即崩溃，也必须计入额度', async () => {
    const reload = vi.fn(() => Promise.resolve());
    const target = setup({ reload });
    for (let index = 0; index < 4; index++) target.recovery.crash();
    await settle();
    expect(target.reload).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(3);
    expect(target.recovery.getState().safeMode).toBe(true);
  });

  it('无响应等待按经过时间计算；恢复响应会取消，持续无响应仅计一次', async () => {
    vi.useFakeTimers();
    const target = setup({ unresponsiveMs: 1000 });
    target.overlay.emit('unresponsive');
    target.overlay.emit('responsive');
    target.setNow(11000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(target.contents.forcefullyCrashRenderer).not.toHaveBeenCalled();
    target.overlay.emit('unresponsive');
    target.overlay.emit('unresponsive');
    target.setNow(11500);
    await vi.advanceTimersByTimeAsync(1000);
    expect(target.contents.forcefullyCrashRenderer).not.toHaveBeenCalled();
    target.setNow(12000);
    await vi.advanceTimersByTimeAsync(500);
    await settle();
    expect(target.contents.forcefullyCrashRenderer).toHaveBeenCalledOnce();
    expect(target.recovery.getState().failures).toEqual([12000]);
  });

  it('重载失败时停止自动尝试并提示，不静默卡住桌面', async () => {
    vi.useFakeTimers();
    const onSafeMode = vi.fn();
    const target = setup({ reload: () => Promise.reject(new Error('load failed')), onSafeMode });
    target.recovery.crash();
    await settle();
    expect(target.notify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(LOAD_FAILURE_GRACE_MS - 1);
    expect(target.notify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(target.recovery.getState().safeMode).toBe(true);
    expect(onSafeMode).toHaveBeenCalledOnce();
    expect(target.overlay.setIgnoreMouseEvents).toHaveBeenCalledWith(true);
    expect(target.notify).toHaveBeenCalledWith(zh.recovery.failed);
  });

  it('原生无响应事件缺失时，主进程独立检查仍能恢复卡死的桌面层', async () => {
    vi.useFakeTimers();
    const target = setup({ unresponsiveMs: 1000 });
    target.contents.executeJavaScript.mockImplementation(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(1000);
    target.setNow(11000);
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(target.contents.forcefullyCrashRenderer).toHaveBeenCalledOnce();
    expect(target.reload).toHaveBeenCalledOnce();
    expect(target.recovery.getState().failures).toHaveLength(1);
  });

  it('重载期间再崩溃导致加载 reject 时，仍使用剩余重试额度', async () => {
    vi.useFakeTimers();
    let rejectLoad: ((error: Error) => void) | undefined;
    const reload = vi
      .fn<RecoveryOptions['reload']>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectLoad = reject;
          }),
      )
      .mockResolvedValue(undefined);
    const target = setup({ reload });
    target.recovery.crash();
    await settle();
    rejectLoad?.(new Error('renderer died during load'));
    await settle();
    expect(target.notify).not.toHaveBeenCalled();
    // Windows Electron 的真实顺序：loadURL 先 reject，几毫秒后才报告进程崩溃。
    setTimeout(
      () => target.contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 }),
      5,
    );
    await vi.advanceTimersByTimeAsync(5);
    await settle();
    expect(reload).toHaveBeenCalledTimes(2);
    expect(target.recovery.getState().safeMode).toBe(false);
    expect(target.applySafeMode).not.toHaveBeenCalled();
  });

  it('强制崩溃没有产生退出事件时，两秒后仍能继续调试和检测卡死', async () => {
    vi.useFakeTimers();
    const target = setup({ unresponsiveMs: 1000 });
    target.contents.forcefullyCrashRenderer.mockImplementationOnce(() => false);
    target.recovery.crash();
    target.recovery.crash();
    expect(target.contents.forcefullyCrashRenderer).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2000);
    target.recovery.crash();
    await settle();
    expect(target.reload).toHaveBeenCalledOnce();
    target.contents.executeJavaScript.mockImplementation(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(1000);
    target.setMonotonic(11000);
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(target.reload).toHaveBeenCalledTimes(2);
  });

  it('慢加载使用独立长超时，不能把开机加载当成画面线程卡死', async () => {
    vi.useFakeTimers();
    const target = setup({ unresponsiveMs: 1000, loadingTimeoutMs: 20000 });
    target.contents.isLoadingMainFrame.mockReturnValue(true);
    target.contents.executeJavaScript.mockImplementation(() => new Promise(() => {}));
    for (let second = 1; second <= 12; second++) {
      target.setMonotonic(10000 + second * 1000);
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(target.contents.executeJavaScript).not.toHaveBeenCalled();
    expect(target.contents.forcefullyCrashRenderer).not.toHaveBeenCalled();
    for (let second = 13; second <= 21; second++) {
      target.setMonotonic(10000 + second * 1000);
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(target.contents.forcefullyCrashRenderer).toHaveBeenCalledOnce();
  });

  it('墙上时钟回拨和主进程长暂停都不能让健康桌面层被立即终止', async () => {
    vi.useFakeTimers();
    const target = setup({ unresponsiveMs: 1000 });
    target.contents.executeJavaScript.mockImplementation(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(1000);
    target.setWallTime(100);
    await vi.advanceTimersByTimeAsync(1000);
    expect(target.contents.forcefullyCrashRenderer).not.toHaveBeenCalled();
    target.setMonotonic(100000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(target.contents.forcefullyCrashRenderer).not.toHaveBeenCalled();
  });

  it('退出时即使旧重载随后失败，也不弹提示或重新启动', async () => {
    let rejectLoad: ((error: Error) => void) | undefined;
    const target = setup({
      reload: () =>
        new Promise<void>((_resolve, reject) => {
          rejectLoad = reject;
        }),
    });
    target.recovery.crash();
    await settle();
    target.recovery.dispose();
    rejectLoad?.(new Error('closed during load'));
    await settle();
    expect(target.notify).not.toHaveBeenCalled();
  });

  it('正常退出和解除监听后不触发恢复', async () => {
    const target = setup();
    target.contents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 });
    target.recovery.dispose();
    target.recovery.crash();
    target.contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    await settle();
    expect(target.reload).not.toHaveBeenCalled();
  });

  it('默认原生中文提示提供打开日志文件夹按钮', async () => {
    native.showMessageBox.mockResolvedValue({ response: 0 });
    native.openPath.mockResolvedValue('');
    const target = setup({ notify: undefined });
    for (let index = 0; index < 4; index++) {
      target.recovery.crash();
      await settle();
    }
    expect(native.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ buttons: [zh.recovery.openLogs, zh.recovery.close] }),
    );
    expect(native.openPath).toHaveBeenCalledWith(join(target.directory, 'logs'));
  });
});

describe('调试台崩溃命令只接受可信主框架', () => {
  it('拒绝未知窗口、子框架和其他命令，解除后不再崩溃', () => {
    const ipc = new EventEmitter();
    const crash = vi.fn();
    const mainFrame = {};
    const detach = attachCrashCommand(ipc as unknown as IpcMain, (id) => id === 1, crash);
    const event = {
      sender: { id: 1, mainFrame },
      senderFrame: mainFrame,
    } as unknown as IpcMainEvent;
    const send = (source: unknown, command: unknown): void => {
      ipc.emit(IPC_CHANNELS.command, source, command);
    };
    send(event, { type: 'cat/sleep' });
    send(event, null);
    send({ ...event, senderFrame: {} }, { type: 'debug/crashOverlay' });
    send({ ...event, sender: { id: 2, mainFrame } }, { type: 'debug/crashOverlay' });
    expect(crash).not.toHaveBeenCalled();
    send(event, { type: 'debug/crashOverlay' });
    expect(crash).toHaveBeenCalledOnce();
    detach();
    send(event, { type: 'debug/crashOverlay' });
    expect(crash).toHaveBeenCalledOnce();
  });
});
