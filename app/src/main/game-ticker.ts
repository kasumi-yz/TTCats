import type { createGameSession } from './game-session';
import type { MainFeature } from './features';

/**
 * 每秒推进游戏的计时器，全程序只有这一份（#98）。
 * 定时器只唤醒；core/game 按传入的真实时间结束勿扰、静默并推送快照。
 */
export function createGameTicker(options: {
  session: ReturnType<typeof createGameSession>;
  stopping: () => boolean;
  report: (error: unknown) => void;
}) {
  const { session } = options;
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    start(): void {
      if (timer) return;
      timer = setInterval(() => {
        if (options.stopping() || session.safeMode) return;
        try {
          session.tick();
        } catch (error) {
          options.report(error);
        }
      }, 1000);
    },
    dispose(): void {
      clearInterval(timer);
    },
  } satisfies MainFeature;
}
