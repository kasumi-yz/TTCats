import type { WindowInfo } from '../platform/types';
import { computeLedges, type Ledge, type LedgeScreen } from './compute';

export interface WindowLedgeUpdate {
  at: number;
  windows: WindowInfo[];
  ledges: Ledge[];
  /** 位移是桌面层 CSS 像素，时间是两次实际采样间隔；快速移动的玩法阈值归 #115。 */
  moved: { id: string; dx: number; dy: number; elapsedMs: number }[];
  /** 不再可站立（关闭、隐藏、最小化、最大化等）的窗口。 */
  unavailable: { id: string; reason: string }[];
}

export const WINDOW_LEDGE_ACTIVE_MS = 33;
export const WINDOW_LEDGE_IDLE_MS = 1000;

/** #116 接线时由主进程控制模式和占用状态。地板模式不读窗口，也不创建定时器。 */
export function createWindowLedgeTracker(options: {
  readWindows: () => WindowInfo[];
  screen: () => LedgeScreen;
  onUpdate: (update: WindowLedgeUpdate) => void;
  onError: (error: unknown) => void;
  now?: () => number;
}) {
  const now = options.now ?? (() => performance.now());
  let mode = false,
    occupied = false,
    disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let previous: WindowLedgeUpdate | undefined;
  const clear = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const sample = (): void => {
    const screen = options.screen();
    const at = now();
    const windows = options.readWindows();
    const ledges = computeLedges(windows, screen);
    const before = new Map(previous?.windows.map((w) => [w.id, w]));
    const current = new Map(windows.map((w) => [w.id, w]));
    const moved: WindowLedgeUpdate['moved'] = [];
    const unavailable: WindowLedgeUpdate['unavailable'] = [];
    for (const [id, old] of before) {
      const next = current.get(id);
      if (old.eligible && (!next || !next.eligible || next.pid !== old.pid))
        unavailable.push({ id, reason: next?.pid !== old.pid ? 'closed' : next.reason });
      if (next?.eligible && old.eligible && next.pid === old.pid && previous) {
        const dx = (next.bounds.left - old.bounds.left) / screen.scaleFactor;
        const dy = (next.bounds.top - old.bounds.top) / screen.scaleFactor;
        if (dx || dy) moved.push({ id, dx, dy, elapsedMs: at - previous.at });
      }
    }
    previous = { at, windows, ledges, moved, unavailable };
    options.onUpdate(previous);
  };
  const tick = (): void => {
    timer = undefined;
    if (!mode || disposed) return;
    try {
      sample();
    } catch (error) {
      // 查询失败也清掉旧顶边，不能让猫继续站在不可信的窗口上。
      const unavailable =
        previous?.windows
          .filter((w) => w.eligible)
          .map((w) => ({ id: w.id, reason: 'query-failed' })) ?? [];
      previous = undefined;
      options.onUpdate({ at: now(), windows: [], ledges: [], moved: [], unavailable });
      options.onError(error);
    } finally {
      schedule();
    }
  };
  const schedule = (): void => {
    if (mode && !disposed && timer === undefined)
      timer = setTimeout(tick, occupied ? WINDOW_LEDGE_ACTIVE_MS : WINDOW_LEDGE_IDLE_MS);
  };
  return {
    setMode(windowMode: boolean, catsOnLedges = false): void {
      if (disposed) throw new Error('窗口顶边读取器已经关闭。');
      if (mode === windowMode && occupied === catsOnLedges) return;
      clear();
      mode = windowMode;
      occupied = catsOnLedges;
      if (mode) tick();
      else {
        previous = undefined;
        options.onUpdate({ at: now(), windows: [], ledges: [], moved: [], unavailable: [] });
      }
    },
    /** 调试或屏幕配置改变时立即读取一次，地板模式下仍然不读。 */
    refresh(): void {
      if (mode && !disposed) {
        clear();
        tick();
      }
    },
    dispose(): void {
      clear();
      disposed = true;
      previous = undefined;
    },
  };
}
