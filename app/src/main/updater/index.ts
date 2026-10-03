import { app, type MenuItemConstructorOptions } from 'electron';
import updater from 'electron-updater';
import type { AppUpdater } from 'electron-updater';
import type { UpdateStatus } from '../../shared/ipc';
import { zh } from '../../shared/strings.zh-CN';

export const UPDATE_TIMING = { startupMs: 60_000, intervalMs: 4 * 60 * 60_000 };

export function createUpdater(options: {
  packaged: boolean;
  enabled: boolean;
  engine?: AppUpdater;
  now?: () => number;
  publish: (status: UpdateStatus) => void;
  report: (error: unknown) => void;
  quit: () => void;
}) {
  const engine = options.engine ?? updater.autoUpdater;
  const now = options.now ?? Date.now;
  let enabled = options.enabled;
  let status: UpdateStatus = !options.packaged
    ? { state: 'unsupported' }
    : enabled
      ? { state: 'idle', checkedAt: null }
      : { state: 'off' };
  let checkedAt: number | null = null;
  let busy = false;
  let disposed = false;
  let restart = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const setStatus = (next: UpdateStatus): void => {
    if (disposed) return;
    status = next;
    options.publish(next);
  };
  const fail = (error: unknown): void => {
    options.report(zh.updater.failed(String(error)));
    setStatus({ state: 'error', message: zh.updater.retryLater, at: now() });
  };
  const check = async (): Promise<void> => {
    if (!options.packaged || disposed || busy || status.state === 'downloaded') return;
    busy = true;
    setStatus({ state: 'checking' });
    try {
      const result = await engine.checkForUpdates();
      // 下载 rejection 也必须被消费，不能变成主进程的未处理异常。
      await result?.downloadPromise;
    } catch (error) {
      fail(error);
    } finally {
      busy = false;
    }
  };
  const schedule = (delay: number): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (!options.packaged || !enabled || disposed) return;
    timer = setTimeout(() => {
      void check();
      schedule(UPDATE_TIMING.intervalMs);
    }, delay);
  };
  const noUpdate = (): void => {
    checkedAt = now();
    setStatus(enabled ? { state: 'idle', checkedAt } : { state: 'off' });
  };
  const available = (info: { version: string }): void => {
    setStatus({ state: 'downloading', version: info.version, percent: 0 });
  };
  const progress = (info: { percent: number }): void => {
    if (status.state === 'downloading')
      setStatus({ ...status, percent: Math.max(0, Math.min(100, info.percent)) });
  };
  const downloaded = (info: { version: string }): void => {
    setStatus({ state: 'downloaded', version: info.version });
  };
  engine.autoDownload = true;
  // 安装由正式退出流程在保存和清理完成后发起。
  engine.autoInstallOnAppQuit = false;
  engine.autoRunAppAfterInstall = false;
  engine.logger = {
    info: (message: unknown) => {
      options.report(String(message));
    },
    warn: (message: unknown) => {
      options.report(String(message));
    },
    error: (message: unknown) => {
      options.report(String(message));
    },
  };
  engine.on('update-not-available', noUpdate);
  engine.on('update-available', available);
  engine.on('download-progress', progress);
  engine.on('update-downloaded', downloaded);
  engine.on('error', fail);
  schedule(UPDATE_TIMING.startupMs);
  return {
    get status() {
      return status;
    },
    check,
    setEnabled(value: boolean): void {
      if (enabled === value) return;
      enabled = value;
      if (!options.packaged || disposed) return;
      schedule(UPDATE_TIMING.startupMs);
      if (!busy && status.state !== 'downloaded')
        setStatus(enabled ? { state: 'idle', checkedAt } : { state: 'off' });
    },
    requestInstall(): void {
      if (disposed || status.state !== 'downloaded') return;
      restart = true;
      options.quit();
    },
    finishQuit(): void {
      if (status.state === 'downloaded') engine.quitAndInstall(true, restart);
      // 安装启动失败时，仍然允许正常退出；错误由 engine 的 error 事件记录。
      app.quit();
    },
    menuSection: (): MenuItemConstructorOptions[] =>
      status.state === 'downloaded'
        ? [
            {
              id: 'update-install',
              label: zh.updater.install(status.version),
              click: () => {
                restart = true;
                options.quit();
              },
            },
          ]
        : [],
    dispose(): void {
      disposed = true;
      if (timer) clearTimeout(timer);
      engine.removeListener('update-not-available', noUpdate);
      engine.removeListener('update-available', available);
      engine.removeListener('download-progress', progress);
      engine.removeListener('update-downloaded', downloaded);
      // 保留 error 监听器，接住仍在下载的请求以及安装启动失败。
    },
  };
}
