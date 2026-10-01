import { dialog, shell, type BrowserWindow, type IpcMain, type IpcMainEvent } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc';
import { GameStateSchema, type GameState } from '../../shared/schemas/save';
import { zh } from '../../shared/strings.zh-CN';
import type { SaveStore } from '../save';
import { attachRendererLog, type FileLog } from '../log';
import { recordFailure, type RetryState } from './retry';

export interface SafeModeState {
  state: GameState;
  disabledCats: readonly string[];
  source: 'backup' | 'default';
}

export interface RecoveryOptions {
  overlay: BrowserWindow;
  save: SaveStore<GameState>;
  log: FileLog;
  now?: () => number;
  /** 无备份时使用经 schema 校验的默认状态，不重新加载可能导致故障的主存档。 */
  defaultState: () => GameState;
  activeCats: () => readonly string[];
  /** 仅传入内容加载/播放错误明确关联的猫 id；不能凭“最近选中的猫”猜测。 */
  faultedCat?: () => string | undefined;
  /** 主进程替换游戏状态，过滤内容目录并停止旧的自动存档任务。不能由渲染进程执行。 */
  applySafeMode: (result: SafeModeState) => void | Promise<void>;
  /** 与正式入口使用相同的桌面层加载函数。 */
  reload: () => void | Promise<void>;
  /** 默认显示原生中文提示；测试可以替换以免阻塞自动化。 */
  notify?: (message: string) => void | Promise<void>;
  unresponsiveMs?: number;
}

/** 一个桌面层一个控制器。进入安全模式后停止重试，不自动重启整个程序。 */
export function attachRecovery(options: RecoveryOptions): {
  crash: () => void;
  dispose: () => void;
  getState: () => RetryState;
} {
  const { overlay, log } = options;
  const contents = overlay.webContents;
  const now = options.now ?? Date.now;
  const timeoutMs = options.unresponsiveMs ?? 10000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error(zh.recovery.invalidTimeout);
  let state: RetryState = { failures: [], safeMode: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let recovering = false;
  let recoveryTask = Promise.resolve();
  let failuresReceived = 0;
  let probeStarted: number | undefined;
  let probeGeneration = 0;
  let terminating = false;
  const detachLog = attachRendererLog(contents, 'overlay', log);

  const clearTimer = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const notify =
    options.notify ??
    (async (message: string): Promise<void> => {
      const result = await dialog.showMessageBox({
        type: 'warning',
        title: zh.recovery.safeModeTitle,
        message,
        buttons: [zh.recovery.openLogs, zh.recovery.close],
        defaultId: 1,
        cancelId: 1,
      });
      if (result.response === 0) {
        const error = await shell.openPath(log.directory);
        if (error !== '') throw new Error(error);
      }
    });
  const recover = async (failedAt: number, received: number): Promise<void> => {
    if (disposed || state.safeMode || recovering || overlay.isDestroyed()) return;
    recovering = true;
    clearTimer();
    try {
      state = recordFailure(state, failedAt);
      // 先释放桌面层对鼠标的拦截；窗口卡死时也不能挡住用户操作。
      overlay.setIgnoreMouseEvents(true);
      if (!state.safeMode) {
        log.report(zh.recovery.retry(state.failures.length));
        try {
          await options.reload();
        } catch (error) {
          // 新渲染进程再次崩溃会让 loadURL reject；该故障已经排队，不能提前耗尽额度。
          if (failuresReceived <= received) throw error;
        }
        return;
      }
      overlay.hide();
      const active = [...new Set(options.activeCats())];
      const faulted = options.faultedCat?.();
      const disabledCats = faulted !== undefined && active.includes(faulted) ? [faulted] : active;
      const backup = options.save.loadLatestBackup();
      const restored = backup?.state ?? GameStateSchema.parse(options.defaultState());
      await options.applySafeMode({
        state: restored,
        disabledCats,
        source: backup === null ? 'default' : 'backup',
      });
      const message = zh.recovery.safeMode(disabledCats, backup !== null);
      log.report(message);
      await notify(message);
    } catch (error) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- await 期间 dispose 会改变闭包变量，TypeScript 不跟踪异步变化。
      if (disposed) return;
      // 恢复失败不能继续循环崩溃或悄悄写默认存档。隐藏桌面层，保留磁盘原件。
      state = { ...state, safeMode: true };
      if (!overlay.isDestroyed()) {
        overlay.setIgnoreMouseEvents(true);
        overlay.hide();
      }
      log.report(error instanceof Error ? (error.stack ?? error.message) : String(error));
      await Promise.resolve()
        .then(() => notify(zh.recovery.failed))
        .catch((cause: unknown) => {
          log.report(String(cause));
        });
    } finally {
      recovering = false;
    }
  };
  const onGone = (_event: Electron.Event, details: Electron.RenderProcessGoneDetails): void => {
    clearTimer();
    probeGeneration++;
    probeStarted = undefined;
    terminating = false;
    // 新页面可能在 load Promise 完成前就再次崩溃；排队处理，不能丢掉这次故障。
    if (details.reason !== 'clean-exit') {
      const failedAt = now();
      const received = ++failuresReceived;
      recoveryTask = recoveryTask.then(() => recover(failedAt, received));
    }
  };
  const terminate = (): void => {
    if (disposed || state.safeMode || terminating || contents.isDestroyed()) return;
    terminating = true;
    contents.forcefullyCrashRenderer();
  };
  const onUnresponsive = (): void => {
    if (timer !== undefined || disposed || state.safeMode) return;
    const started = now();
    const check = (): void => {
      timer = undefined;
      if (disposed || state.safeMode || overlay.isDestroyed()) return;
      const elapsed = now() - started;
      if (elapsed < timeoutMs && elapsed >= 0) {
        timer = setTimeout(check, timeoutMs - elapsed);
      } else {
        log.report(zh.recovery.unresponsive);
        // 统一由 render-process-gone 计数，避免无响应与崩溃各算一次。
        terminate();
      }
    };
    timer = setTimeout(check, timeoutMs);
  };
  // 原生 unresponsive 通知可能延迟或缺失。由主进程独立检查 JS 线程，隐藏时也有效。
  const probeTimer = setInterval(() => {
    if (disposed || state.safeMode || contents.isDestroyed() || terminating) return;
    if (probeStarted !== undefined) {
      const elapsed = now() - probeStarted;
      if (elapsed >= timeoutMs || elapsed < 0) {
        log.report(zh.recovery.unresponsive);
        terminate();
      }
      return;
    }
    probeStarted = now();
    const generation = ++probeGeneration;
    const completed = (): void => {
      if (generation === probeGeneration) probeStarted = undefined;
    };
    // 导航会让调用 reject；下一轮再试。执行结果不用渲染进程提供的数据。
    void contents.executeJavaScript('0').then(completed, completed);
  }, 1000);
  const dispose = (): void => {
    disposed = true;
    clearTimer();
    clearInterval(probeTimer);
    probeGeneration++;
    detachLog();
    contents.removeListener('render-process-gone', onGone);
    overlay.removeListener('unresponsive', onUnresponsive);
    overlay.removeListener('responsive', clearTimer);
    overlay.removeListener('closed', dispose);
  };
  contents.on('render-process-gone', onGone);
  overlay.on('unresponsive', onUnresponsive);
  overlay.on('responsive', clearTimer);
  overlay.on('closed', dispose);
  return {
    getState: () => state,
    dispose,
    crash: terminate,
  };
}

/** 仅接收主进程登记过的面板/桌面层，且只处理 #18 已定义的调试命令。 */
export function attachCrashCommand(
  ipc: IpcMain,
  allowedSender: (id: number) => boolean,
  crash: () => void,
): () => void {
  const listener = (event: IpcMainEvent, command: unknown): void => {
    if (event.senderFrame !== event.sender.mainFrame || !allowedSender(event.sender.id)) return;
    if (
      typeof command === 'object' &&
      command !== null &&
      'type' in command &&
      command.type === 'debug/crashOverlay'
    )
      crash();
  };
  ipc.on(IPC_CHANNELS.command, listener);
  return () => {
    ipc.removeListener(IPC_CHANNELS.command, listener);
  };
}
