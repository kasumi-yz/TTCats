import type { CreateGameCore, GameOutput } from '../../shared/core-api';
import type { StageCommand } from '../../shared/ipc';
import {
  defaultSettings,
  SettingsSchema,
  validateWith,
  type DoNotDisturb,
  type Settings,
} from '../../shared/schemas';
import { zh } from '../../shared/strings.zh-CN';

function copySettings(settings: Settings): Settings {
  return {
    ...settings,
    visibleCats: [...settings.visibleCats],
    display: settings.display && { ...settings.display },
  };
}

/** 设置项的值只有 JSON 能表示的类型（数组、对象、基本类型），按内容比较。 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every(
      (key) =>
        Object.hasOwn(b, key) &&
        sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    )
  );
}

function output(stageCommands: StageCommand[] = [], problems: string[] = []): GameOutput {
  return { stageCommands, stateChanged: false, snapshotChanged: false, problems };
}

export const createGameCore: CreateGameCore = ({ content, state }) => {
  let settings = state ? copySettings(state.settings) : defaultSettings(Object.keys(content.cats));
  // 勿扰模式的规则在 #58 里做；在那之前原样保留存档里的状态，不丢数据。
  const doNotDisturb: DoNotDisturb = state ? { ...state.doNotDisturb } : { mode: 'off' };
  let revision = 0;

  function updateSettings(patch: Partial<Settings>): GameOutput {
    const result = validateWith(SettingsSchema, { ...settings, ...patch });
    if (!result.ok) return output([], result.problems);
    const next = result.value;
    const stateChanged = Object.entries(next).some(
      ([key, value]) => !sameValue(value, settings[key as keyof Settings]),
    );
    settings = next;
    return { stageCommands: [], stateChanged, snapshotChanged: stateChanged, problems: [] };
  }

  function catProblem(cat: string, mustBeVisible: boolean): string[] {
    if (!Object.hasOwn(content.cats, cat)) return [zh.game.catUnavailable(cat)];
    if (mustBeVisible && !settings.visibleCats.includes(cat)) return [zh.game.catHidden(cat)];
    return [];
  }

  return {
    handleCommand(command) {
      if (command.type === 'settings/update') return updateSettings(command.patch);

      if (command.type === 'cat/setVisible') {
        const problems = catProblem(command.cat, false);
        if (problems.length > 0) return output([], problems);
        const visibleCats = command.visible
          ? settings.visibleCats.includes(command.cat)
            ? settings.visibleCats
            : [...settings.visibleCats, command.cat]
          : settings.visibleCats.filter((cat) => cat !== command.cat);
        return updateSettings({ visibleCats });
      }

      if (command.type === 'cat/summon') {
        if (command.cat !== undefined) {
          const problems = catProblem(command.cat, true);
          if (problems.length > 0) return output([], problems);
        }
        const cats =
          command.cat === undefined
            ? [...new Set(settings.visibleCats.filter((cat) => Object.hasOwn(content.cats, cat)))]
            : [command.cat];
        if (cats.length === 0) return output();
        return output([
          command.to === undefined
            ? { type: 'cat/summon', cats }
            : { type: 'cat/summon', cats, to: { ...command.to } },
        ]);
      }

      if (command.type === 'debug/entrance') return output([{ type: 'cat/entrance' }]);

      // M2 的勿扰模式、一键隐藏、快进时钟、开机静默在 #58 里实现，在那之前先一律拒绝。
      if (
        command.type === 'doNotDisturb/start' ||
        command.type === 'doNotDisturb/end' ||
        command.type === 'hideAll/toggle' ||
        command.type === 'debug/advanceClock' ||
        command.type === 'debug/startupQuiet'
      ) {
        return output([], [zh.interfaces.commandNotReady(command.type)]);
      }

      const problems = catProblem(command.cat, true);
      if (problems.length > 0) return output([], problems);
      if (command.type === 'debug/playClip') {
        const available = content.cats[command.cat]?.clips.some(
          (clip) =>
            clip.name === command.clip &&
            (command.variant === undefined || clip.variant === command.variant),
        );
        if (!available) {
          return output([], [zh.game.clipUnavailable(command.cat, command.clip, command.variant)]);
        }
      }
      return output([{ ...command }]);
    },

    // M1 的互动事实不改变设置；需求和亲密度到第二阶段再实现。
    handleFact() {
      return output();
    },

    // 随时间变化的规则（勿扰到点、安静时段、开机静默）在 #58 里实现。
    tick() {
      return output();
    },

    snapshot(now) {
      return {
        revision: ++revision,
        at: now,
        settings: copySettings(settings),
        doNotDisturb: { ...doNotDisturb },
        hideAll: false,
        silencedBy: [],
        clockOffsetMs: 0,
      };
    },

    exportState() {
      return { settings: copySettings(settings), doNotDisturb: { ...doNotDisturb } };
    },
  };
};
