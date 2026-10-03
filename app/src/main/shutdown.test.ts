import type { Event } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../shared/strings.zh-CN';
import { attachShutdown } from './shutdown';

const mock = vi.hoisted(() => ({
  listeners: new Map<string, (event: Event) => void>(),
  quit: vi.fn(),
  showMessageBox: vi.fn(),
}));
vi.mock('electron', () => ({
  app: {
    on: (name: string, listener: (event: Event) => void) => mock.listeners.set(name, listener),
    quit: mock.quit,
  },
  dialog: { showMessageBox: mock.showMessageBox },
}));

function setup(flush = vi.fn(), finishQuit?: () => void) {
  const calls: string[] = [];
  const report = vi.fn();
  const disposeOverlay = vi.fn(() => {
    calls.push('overlay');
    return Promise.resolve();
  });
  const detachMainLog = vi.fn(() => {
    calls.push('log');
  });
  const shutdown = attachShutdown({
    flush,
    report,
    steps: [
      () => {
        calls.push('first');
      },
      () => {
        calls.push('second');
      },
    ],
    disposeOverlay,
    detachMainLog,
    ...(finishQuit ? { finishQuit } : {}),
  });
  const requestQuit = () => {
    const preventDefault = vi.fn();
    mock.listeners.get('before-quit')?.({ preventDefault } as unknown as Event);
    return preventDefault;
  };
  return { calls, flush, report, shutdown, requestQuit, disposeOverlay, detachMainLog };
}

describe('主进程退出流程', () => {
  beforeEach(() => {
    mock.listeners.clear();
    vi.resetAllMocks();
  });

  it('已下载更新也必须先保存并释放桌面层，再交给更新模块安装', async () => {
    const install = vi.fn();
    const { calls, requestQuit } = setup(vi.fn(), () => {
      calls.push('install');
      install();
    });
    requestQuit();
    expect(install).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(install).toHaveBeenCalledOnce();
    });
    expect(calls).toEqual(['first', 'second', 'overlay', 'log', 'install']);
    expect(mock.quit).not.toHaveBeenCalled();
  });

  it('先保存，再按注册顺序清理，最后释放桌面层和日志；重复退出不重复执行', async () => {
    const { flush, calls, shutdown, requestQuit } = setup();
    flush.mockImplementation(() => {
      calls.push('flush');
    });
    expect(requestQuit()).toHaveBeenCalledOnce();
    expect(shutdown.quitting).toBe(true);
    expect(shutdown.closing).toBe(true);
    expect(requestQuit()).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(mock.quit).toHaveBeenCalledOnce();
    });
    expect(flush).toHaveBeenCalledOnce();
    expect(calls).toEqual(['flush', 'first', 'second', 'overlay', 'log']);
    expect(mock.showMessageBox).not.toHaveBeenCalled();
  });

  it('保存失败可以重试；等待选择时封住新命令，不能并行执行另一轮退出', async () => {
    let choose!: (result: { response: number }) => void;
    mock.showMessageBox.mockImplementation(
      () =>
        new Promise((resolve) => {
          choose = resolve;
        }),
    );
    const error = new Error('存档目录不可写');
    const flush = vi.fn().mockImplementationOnce(() => {
      throw error;
    });
    const { calls, report, shutdown, requestQuit } = setup(flush);
    requestQuit();
    expect(shutdown.quitting).toBe(true);
    expect(shutdown.closing).toBe(false);
    expect(calls).toEqual([]);
    expect(requestQuit()).toHaveBeenCalledOnce();
    expect(mock.showMessageBox).toHaveBeenCalledOnce();
    choose({ response: 0 });
    await vi.waitFor(() => {
      expect(mock.quit).toHaveBeenCalledOnce();
    });
    expect(flush).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenCalledExactlyOnceWith(error);
    expect(calls).toEqual(['first', 'second', 'overlay', 'log']);
  });

  it('用户选择不保存时记录中文原因并照常退出', async () => {
    mock.showMessageBox.mockResolvedValue({ response: 1 });
    const flush = vi.fn(() => {
      throw new Error('存档目录不可写');
    });
    const { calls, report, requestQuit } = setup(flush);
    requestQuit();
    await vi.waitFor(() => {
      expect(mock.quit).toHaveBeenCalledOnce();
    });
    expect(flush).toHaveBeenCalledOnce();
    expect(mock.showMessageBox).toHaveBeenCalledExactlyOnceWith({
      type: 'error',
      message: zh.integration.saveFailed,
      buttons: [zh.integration.retrySave, zh.integration.quitWithoutSaving],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    expect(report).toHaveBeenLastCalledWith(zh.integration.saveAbandoned);
    expect(calls).toEqual(['first', 'second', 'overlay', 'log']);
  });

  it('桌面层清理失败也释放日志并退出，同时报告错误', async () => {
    const { disposeOverlay, detachMainLog, report, requestQuit } = setup();
    const error = new Error('桌面层清理失败');
    disposeOverlay.mockRejectedValue(error);
    requestQuit();
    await vi.waitFor(() => {
      expect(report).toHaveBeenCalledWith(error);
    });
    expect(detachMainLog).toHaveBeenCalledOnce();
    expect(mock.quit).toHaveBeenCalledOnce();
  });
});
