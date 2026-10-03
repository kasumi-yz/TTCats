// #114 核对脚本的结果与回调测量；不启动 Electron，不操作桌面。
import type { WindowInfo } from '../src/main/platform/types';
import type { WindowLedgeUpdate } from '../src/main/window-ledges/tracker';

export type CheckResult = { name: string; status: 'passed' | 'failed'; error?: unknown };

export function errorDetails(error: unknown): unknown {
  if (!(error instanceof Error)) return String(error);
  const output = error as Error & { stderr?: string; stdout?: string };
  return {
    message: error.message,
    stack: error.stack,
    stderr: output.stderr,
    stdout: output.stdout,
    cause: error.cause === undefined ? undefined : errorDetails(error.cause),
    errors: error instanceof AggregateError ? error.errors.map(errorDetails) : undefined,
  };
}

/** 某项失败仍保存并返回，让调用方继续下一项；写盘失败则明确抛出。 */
export function createCheckLog(save: () => void) {
  const entries: CheckResult[] = [];
  return {
    entries,
    async run(name: string, task: () => void | Promise<void>): Promise<void> {
      const entry: CheckResult = { name, status: 'passed' };
      entries.push(entry);
      try {
        await task();
      } catch (error) {
        entry.status = 'failed';
        entry.error = errorDetails(error);
      } finally {
        save();
      }
    },
  };
}

/** PrintWindow 只用于 DPI 与目标显示器一致的 Per-Monitor 窗口。 */
export function captionCaptureMethod(
  window: Pick<WindowInfo, 'dpiAwareness' | 'windowDpi'>,
  scale: number,
): 'PrintWindow' | 'screen' {
  return window.dpiAwareness === 'per-monitor' && window.windowDpi === Math.round(96 * scale)
    ? 'PrintWindow'
    : 'screen';
}

/** 用 onUpdate 到达时刻测量，等待 Promise 不参与延迟数字。 */
export function movementProbe(now: () => number = () => performance.now()) {
  let pending:
    | {
        id: string;
        at: number;
        resolve: (ms: number) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  return {
    update(update: WindowLedgeUpdate): void {
      const receivedAt = now();
      if (
        !pending ||
        update.at < pending.at ||
        !update.moved.some((m) => m.id === pending?.id && Math.abs(m.dx) > 1)
      )
        return;
      clearTimeout(pending.timer);
      pending.resolve(receivedAt - pending.at);
      pending = undefined;
    },
    move(id: string, command: () => void): Promise<number> {
      if (pending) throw new Error('前一次移动测量尚未结束。');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending = undefined;
          reject(new Error('移动后 500 ms 内未收到对应的顶边更新。'));
        }, 500);
        pending = { id, at: now(), resolve, reject, timer };
        try {
          command();
        } catch (error) {
          clearTimeout(timer);
          pending = undefined;
          reject(error instanceof Error ? error : new Error('移动命令失败。', { cause: error }));
        }
      });
    },
    dispose(): void {
      if (!pending) return;
      clearTimeout(pending.timer);
      pending.reject(new Error('移动测量提前结束。'));
      pending = undefined;
    },
  };
}
