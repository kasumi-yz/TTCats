import { createGameCore } from '../core/game';
import { isDeepStrictEqual } from 'node:util';
import type { ContentCatalog, GameOutput } from '../shared/core-api';
import type { Fact, GameCommand, StateSnapshot } from '../shared/ipc';
import type { GameState } from '../shared/schemas';
import { zh } from '../shared/strings.zh-CN';
import type { SafeModeState } from './recovery';
import type { SaveStore } from './save';

/** 生命周期跨越 core/game 重建；快照版本和正常存档不能随安全模式回退。 */
export function createGameSession(options: {
  content: ContentCatalog;
  state: GameState;
  save: SaveStore<GameState>;
  now: () => number;
  publish: (snapshot: StateSnapshot) => void;
  log: (message: string) => void;
}) {
  const { content, save, now, publish, log } = options;
  // 安静时段按本地时间算；core/game 不读时区（硬性规则 1）。
  const utcOffsetMinutes = (at: number): number => -new Date(at).getTimezoneOffset();
  let game = createGameCore({ content, state: options.state, now: now(), utcOffsetMinutes });
  let revision = 0;
  let safeMode = false;
  const snapshot = (): StateSnapshot => ({ ...game.snapshot(now()), revision: ++revision });
  const persist = (): void => {
    if (!safeMode && !save.readOnly) save.requestSave(game.exportState());
  };
  // 构造时可能清除过期勿扰；只写回真正变过的状态，避免每次启动挤掉备份。
  if (!isDeepStrictEqual(game.exportState(), options.state)) persist();
  const accept = (result: GameOutput): GameOutput => {
    result.problems.forEach(log);
    if (result.stateChanged) persist();
    if (result.snapshotChanged) publish(snapshot());
    return result;
  };
  return {
    snapshot,
    get safeMode() {
      return safeMode;
    },
    suspendSaving(): void {
      safeMode = true;
    },
    command(command: GameCommand): GameOutput {
      return accept(game.handleCommand(command, now()));
    },
    tick(): GameOutput {
      return accept(game.tick(now()));
    },
    fact(fact: Fact): GameOutput {
      return accept(game.handleFact(fact, now()));
    },
    applySafeMode(result: SafeModeState): void {
      safeMode = true;
      // 备份已由恢复模块读出。仅完成原实例排队的正常状态，绝不提交回退状态。
      try {
        save.flush();
      } catch (error) {
        log(String(error));
      }
      for (const id of result.disabledCats) {
        const name = content.cats[id]?.cat.name ?? id;
        const problem = zh.integration.disabledPack(name);
        content.cats = Object.fromEntries(
          Object.entries(content.cats).filter(([cat]) => cat !== id),
        );
        content.disabled.push({ cat: id, problems: [problem] });
        log(problem);
      }
      game = createGameCore({ content, state: result.state, now: now(), utcOffsetMinutes });
      publish(snapshot());
    },
    flush(): void {
      save.flush();
    },
  };
}
