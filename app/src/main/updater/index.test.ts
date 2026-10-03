import { EventEmitter } from 'node:events';
import type { AppUpdater } from 'electron-updater';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zh } from '../../shared/strings.zh-CN';
import { createUpdater, UPDATE_TIMING } from './index';

const quit = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ app: { quit } }));
vi.mock('electron-updater', () => ({ default: { autoUpdater: {} } }));

function setup(packaged = true, enabled = true) {
  const engine = Object.assign(new EventEmitter(), {
    checkForUpdates: vi.fn().mockResolvedValue(null),
    quitAndInstall: vi.fn(),
    autoDownload: false,
    autoInstallOnAppQuit: true,
    autoRunAppAfterInstall: true,
  });
  const publish = vi.fn();
  const report = vi.fn();
  const requestQuit = vi.fn();
  const updates = createUpdater({
    packaged,
    enabled,
    engine: engine as unknown as AppUpdater,
    publish,
    report,
    quit: requestQuit,
    now: Date.now,
  });
  return { engine, updates, publish, report, requestQuit };
}

describe('后台更新', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    quit.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('开发版绝不检查；安装版避开入场，之后每四小时检查', async () => {
    const dev = setup(false);
    await dev.updates.check();
    dev.updates.setEnabled(false);
    expect(dev.updates.status.state).toBe('unsupported');
    const { engine, updates } = setup();
    await vi.advanceTimersByTimeAsync(UPDATE_TIMING.startupMs - 1);
    expect(engine.checkForUpdates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(engine.checkForUpdates).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(UPDATE_TIMING.intervalMs);
    expect(engine.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(dev.engine.checkForUpdates).not.toHaveBeenCalled();
    updates.dispose();
    dev.updates.dispose();
  });

  it('关闭开关停止定时检查，但手动检查仍有效；打开后重新安排', async () => {
    const { engine, updates } = setup();
    updates.setEnabled(false);
    await vi.advanceTimersByTimeAsync(UPDATE_TIMING.intervalMs);
    expect(engine.checkForUpdates).not.toHaveBeenCalled();
    expect(updates.status.state).toBe('off');
    engine.checkForUpdates.mockImplementation(() => {
      engine.emit('update-not-available');
      return Promise.resolve(null);
    });
    await updates.check();
    expect(engine.checkForUpdates).toHaveBeenCalledOnce();
    expect(updates.status.state).toBe('off');
    updates.setEnabled(true);
    await vi.advanceTimersByTimeAsync(UPDATE_TIMING.startupMs);
    expect(engine.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(updates.status).toEqual({ state: 'idle', checkedAt: Date.now() });
    updates.dispose();
  });

  it('下载期间禁止重复检查；下载完成才出现托盘更新项，关开关不丢已下载版本', async () => {
    const { engine, updates, publish } = setup();
    let finish!: () => void;
    engine.checkForUpdates.mockResolvedValue({
      downloadPromise: new Promise<void>((resolve) => {
        finish = resolve;
      }),
    });
    const checking = updates.check();
    expect(updates.status.state).toBe('checking');
    engine.emit('update-available', { version: '0.2.1' });
    engine.emit('download-progress', { percent: 45 });
    expect(updates.status).toEqual({ state: 'downloading', version: '0.2.1', percent: 45 });
    expect(updates.menuSection()).toEqual([]);
    await updates.check();
    expect(engine.checkForUpdates).toHaveBeenCalledOnce();
    engine.emit('update-downloaded', { version: '0.2.1' });
    finish();
    await checking;
    updates.setEnabled(false);
    expect(updates.status).toEqual({ state: 'downloaded', version: '0.2.1' });
    expect(updates.menuSection()[0]?.label).toBe(zh.updater.install('0.2.1'));
    expect(publish).toHaveBeenLastCalledWith(updates.status);
    updates.dispose();
  });

  it('检查或下载失败显示中文并记录错误，下一次仍能重试', async () => {
    const { engine, updates, report } = setup();
    engine.checkForUpdates.mockRejectedValueOnce(new Error('offline'));
    await updates.check();
    expect(updates.status).toEqual({
      state: 'error',
      message: zh.updater.retryLater,
      at: Date.now(),
    });
    engine.checkForUpdates.mockResolvedValueOnce({
      downloadPromise: Promise.reject(new Error('download')),
    });
    await updates.check();
    expect(report).toHaveBeenCalledWith(zh.updater.failed('Error: download'));
    engine.checkForUpdates.mockImplementation(() => {
      engine.emit('update-not-available');
      return Promise.resolve(null);
    });
    await updates.check();
    expect(updates.status.state).toBe('idle');
    updates.dispose();
  });

  it('按钮先请求正式保存退出；清理完才安装，普通退出不自动重启', () => {
    const { engine, updates, requestQuit } = setup();
    updates.requestInstall();
    expect(requestQuit).not.toHaveBeenCalled();
    engine.emit('update-downloaded', { version: '0.2.1' });
    updates.requestInstall();
    expect(requestQuit).toHaveBeenCalledOnce();
    expect(engine.quitAndInstall).not.toHaveBeenCalled();
    updates.dispose();
    updates.finishQuit();
    expect(engine.quitAndInstall).toHaveBeenCalledWith(true, true);
    const normal = setup();
    normal.engine.emit('update-downloaded', { version: '0.2.1' });
    normal.updates.dispose();
    normal.updates.finishQuit();
    expect(normal.engine.quitAndInstall).toHaveBeenCalledWith(true, false);
    expect(normal.engine.autoInstallOnAppQuit).toBe(false);
  });

  it('退出后停止定时器，晚到的下载消息不再推送面板', async () => {
    const { engine, updates, publish } = setup();
    updates.dispose();
    await vi.advanceTimersByTimeAsync(UPDATE_TIMING.intervalMs);
    engine.emit('update-downloaded', { version: '0.2.1' });
    engine.emit('error', new Error('late'));
    expect(engine.checkForUpdates).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});
