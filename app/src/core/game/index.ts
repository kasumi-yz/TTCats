import type { CreateGameCore, GameOutput } from '../../shared/core-api';
import type { StageCommand } from '../../shared/ipc';
import { defaultSettings, SettingsSchema, validateWith, type Settings } from '../../shared/schemas';
import { zh } from '../../shared/strings.zh-CN';

function copySettings(settings: Settings): Settings {
  return { ...settings, visibleCats: [...settings.visibleCats] };
}

function output(stageCommands: StageCommand[] = [], problems: string[] = []): GameOutput {
  return { stageCommands, stateChanged: false, problems };
}

export const createGameCore: CreateGameCore = ({ content, state }) => {
  let settings = state ? copySettings(state.settings) : defaultSettings(Object.keys(content.cats));
  let revision = 0;

  function updateSettings(patch: Partial<Settings>): GameOutput {
    const result = validateWith(SettingsSchema, { ...settings, ...patch });
    if (!result.ok) return output([], result.problems);
    const next = result.value;
    const stateChanged =
      next.activityLevel !== settings.activityLevel ||
      next.scale !== settings.scale ||
      next.floorDepth !== settings.floorDepth ||
      next.showInScreenCapture !== settings.showInScreenCapture ||
      next.visibleCats.length !== settings.visibleCats.length ||
      next.visibleCats.some((cat, i) => cat !== settings.visibleCats[i]);
    settings = next;
    return { stageCommands: [], stateChanged, problems: [] };
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

    snapshot(now) {
      return { revision: ++revision, at: now, settings: copySettings(settings) };
    },

    exportState() {
      return { settings: copySettings(settings) };
    },
  };
};
