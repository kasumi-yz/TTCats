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
  /** 短超时使用单调时钟，不随用户修改系统时间跳变。 */
  monotonicNow?: () => number;
  /** 无备份时使用经 schema 校验的默认状态，不重新加载可能导致故障的主存档。 */
  defaultState: () => GameState;
  activeCats: () => readonly string[];
  catName: (id: string) => string;
  /** 仅传入内容加载/播放错误明确关联的猫 id；不能凭“最近选中的猫”猜测。 */
  faultedCat?: () => string | undefined;
  /** 主进程替换游戏状态，过滤内容目录并停止旧的自动存档任务。不能由渲染进程执行。 */
  applySafeMode: (result: SafeModeState) => void | Promise<void>;
  /** 先停止正常运行；读备份或重载失败时也必须封住所有显示入口和正常写盘。 */
  onSafeMode?: () => void;
  /** 与正式入口使用相同的桌面层加载函数。 */
  reload: () => void | Promise<void>;
  /** 安全模式提示框里"导出诊断信息"按钮的处理（D13）。 */
  exportDiagnostics?: () => Promise<void>;
  /** 默认显示原生中文提示；测试可以替换以免阻塞自动化。 */
  notify?: (message: string) => void | Promise<void>;
  unresponsiveMs?: number;
  loadingTimeoutMs?: number;
}

export const LOAD_FAILURE_GRACE_MS = 500;

/** 一个桌面层一个控制器。进入安全模式后停止重试，不自动重启整个程序。 */
export function attachRecovery(options: RecoveryOptions): {
  crash: () => void;
  dispose: () => void;
  getState: () => RetryState;
} {
  const { overlay, log } = options;
  const contents = overlay.webContents;
  const now = options.now ?? Date.now;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const timeoutMs = options.unresponsiveMs ?? 10000;
  const loadingTimeoutMs = options.loadingTimeoutMs ?? 120000;
  if (![timeoutMs, loadingTimeoutMs].every((value) => Number.isFinite(value) && value >= 0))
    throw new Error(zh.recovery.invalidTimeout);
  let state: RetryState = { failures: [], safeMode: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let recovering = false;
  let recoveryTask = Promise.resolve();
  let failuresReceived = 0;
  let probeStarted: number | undefined;
  let probeGeneration = 0;
  let terminating = false;
  let terminationTimer: ReturnType<typeof setTimeout> | undefined;
  let finishGrace: (() => void) | undefined;
  let loadingStarted: number | undefined;
  let lastProbeAt = monotonicNow();
  const detachLog = attachRendererLog(contents, 'overlay', log);

  const clearTimer = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const clearTermination = (): void => {
    if (terminationTimer !== undefined) clearTimeout(terminationTimer);
    terminationTimer = undefined;
    terminating = false;
  };
  const waitForCrash = (): Promise<void> =>
    new Promise((resolve) => {
      if (disposed) {
        resolve();
        return;
      }
      const done = (): void => {
        clearTimeout(graceTimer);
        contents.removeListener('render-process-gone', done);
        finishGrace = undefined;
        resolve();
      };
      const graceTimer = setTimeout(done, LOAD_FAILURE_GRACE_MS);
      finishGrace = done;
      contents.once('render-process-gone', done);
    });
  const notify =
    options.notify ??
    (async (message: string): Promise<void> => {
      const exportDiagnostics = options.exportDiagnostics;
      const buttons = [zh.recovery.openLogs, zh.recovery.close];
      if (exportDiagnostics) buttons.unshift(zh.recovery.exportDiagnostics);
      const result = await dialog.showMessageBox({
        type: 'warning',
        title: zh.recovery.safeModeTitle,
        message,
        buttons,
        // 有导出按钮时默认导出：D13 要求进入安全模式时提示用户导出诊断信息。
        defaultId: exportDiagnostics ? 0 : buttons.length - 1,
        cancelId: buttons.length - 1,
      });
      const choice = buttons[result.response];
      if (choice === zh.recovery.exportDiagnostics) await exportDiagnostics?.();
      else if (choice === zh.recovery.openLogs) {
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
          // Electron 可先 reject、几毫秒后才报告进程崩溃；等待事件，不能提前耗尽额度。
          if (failuresReceived <= received) await waitForCrash();
          if (failuresReceived <= received) throw error;
        }
        return;
      }
      overlay.hide();
      options.onSafeMode?.();
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
      const message = zh.recovery.safeMode(
        disabledCats.map(options.catName),
        backup !== null,
        faulted !== undefined && active.includes(faulted),
      );
      log.report(message);
      await notify(message);
    } catch (error) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- await 期间 dispose 会改变闭包变量，TypeScript 不跟踪异步变化。
      if (disposed) return;
      // 恢复失败不能继续循环崩溃或悄悄写默认存档。隐藏桌面层，保留磁盘原件。
      state = { ...state, safeMode: true };
      options.onSafeMode?.();
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
    loadingStarted = undefined;
    clearTermination();
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
    // 已死亡或尚未生成的新进程可能不产生退出事件；不能永久锁住调试命令和检查器。
    terminationTimer = setTimeout(() => {
      clearTermination();
      probeGeneration++;
      probeStarted = undefined;
    }, 2000);
    contents.forcefullyCrashRenderer();
  };
  const onUnresponsive = (): void => {
    if (timer !== undefined || disposed || state.safeMode) return;
    const started = monotonicNow();
    const limit = contents.isLoadingMainFrame() ? loadingTimeoutMs : timeoutMs;
    const check = (): void => {
      timer = undefined;
      if (disposed || state.safeMode || overlay.isDestroyed()) return;
      const elapsed = monotonicNow() - started;
      if (elapsed > limit + 2000) {
        // 主进程本身暂停了很久（例如系统睡眠），给渲染进程一次重新响应的机会。
        onUnresponsive();
      } else if (elapsed < limit) {
        timer = setTimeout(check, limit - elapsed);
      } else {
        log.report(zh.recovery.unresponsive);
        // 统一由 render-process-gone 计数，避免无响应与崩溃各算一次。
        terminate();
      }
    };
    timer = setTimeout(check, limit);
  };
  // 原生 unresponsive 通知可能延迟或缺失。由主进程独立检查 JS 线程，隐藏时也有效。
  const probeTimer = setInterval(() => {
    if (disposed || state.safeMode || contents.isDestroyed() || terminating) return;
    const current = monotonicNow();
    const paused = current - lastProbeAt > 2000;
    lastProbeAt = current;
    if (paused || contents.isLoadingMainFrame()) {
      probeGeneration++;
      probeStarted = undefined;
      if (paused || loadingStarted === undefined) loadingStarted = current;
      if (!paused && current - loadingStarted >= loadingTimeoutMs) {
        log.report(zh.recovery.unresponsive);
        terminate();
      }
      return;
    }
    loadingStarted = undefined;
    if (probeStarted !== undefined) {
      const elapsed = current - probeStarted;
      if (elapsed >= timeoutMs) {
        log.report(zh.recovery.unresponsive);
        terminate();
      }
      return;
    }
    probeStarted = current;
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
    clearTermination();
    finishGrace?.();
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
