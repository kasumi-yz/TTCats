import { STARTUP_QUIET_MS, type CreateGameCore, type GameOutput } from '../../shared/core-api';
import type { SilenceReason, StageCommand } from '../../shared/ipc';
import {
  defaultSettings,
  DO_NOT_DISTURB_DURATION_MS,
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

export const createGameCore: CreateGameCore = ({
  content,
  state,
  now,
  utcOffsetMinutes,
  startupQuiet,
}) => {
  let settings = state ? copySettings(state.settings) : defaultSettings(Object.keys(content.cats));
  // 始终保存真实结束时刻；快进直接减少它，重启清零偏移也不会延长勿扰。
  let doNotDisturb: DoNotDisturb = state ? { ...state.doNotDisturb } : { mode: 'off' };
  if (doNotDisturb.mode === 'timed' && now >= doNotDisturb.until) doNotDisturb = { mode: 'off' };
  let hideAll = false;
  let clockOffsetMs = 0;
  let startupQuietUntil = startupQuiet ? now + STARTUP_QUIET_MS : undefined;
  let revision = 0;
  let silencedBy = silenceReasons(now);

  function silenceReasons(now: number): SilenceReason[] {
    const at = now + clockOffsetMs;
    const localMinutes = (((Math.floor(at / 60_000) + utcOffsetMinutes(at)) % 1440) + 1440) % 1440;
    const minutes = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
    const start = minutes(settings.quietHoursStart);
    const end = minutes(settings.quietHoursEnd);
    const quietHours =
      start < end
        ? localMinutes >= start && localMinutes < end
        : start > end && (localMinutes >= start || localMinutes < end);
    const reasons: SilenceReason[] = [];
    if (doNotDisturb.mode !== 'off') reasons.push('doNotDisturb');
    if (quietHours) reasons.push('quietHours');
    if (startupQuietUntil !== undefined && at < startupQuietUntil) reasons.push('startupQuiet');
    return reasons;
  }

  function finish(result: GameOutput, now: number): GameOutput {
    if (startupQuietUntil !== undefined && now + clockOffsetMs >= startupQuietUntil) {
      startupQuietUntil = undefined;
    }
    const next = silenceReasons(now);
    result.snapshotChanged ||= result.stateChanged || !sameValue(next, silencedBy);
    silencedBy = next;
    return result;
  }

  function tick(now: number): GameOutput {
    const result = output();
    if (doNotDisturb.mode === 'timed' && now >= doNotDisturb.until) {
      doNotDisturb = { mode: 'off' };
      result.stateChanged = true;
    }
    return finish(result, now);
  }

  function setDoNotDisturb(next: DoNotDisturb, now: number): GameOutput {
    const result = output();
    result.stateChanged = !sameValue(doNotDisturb, next);
    doNotDisturb = next;
    return finish(result, now);
  }

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
    handleCommand(command, now) {
      if (command.type === 'settings/update') {
        const result = updateSettings(command.patch);
        return result.problems.length > 0 ? result : finish(result, now);
      }

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
        const result = output();
        if (hideAll) {
          hideAll = false;
          result.snapshotChanged = true;
          result.stageCommands.push({ type: 'cat/entrance' });
        }
        if (cats.length === 0) return result;
        result.stageCommands.push(
          command.to === undefined
            ? { type: 'cat/summon', cats }
            : { type: 'cat/summon', cats, to: { ...command.to } },
        );
        return result;
      }

      if (command.type === 'debug/entrance') return output([{ type: 'cat/entrance' }]);

      if (command.type === 'doNotDisturb/start') {
        return setDoNotDisturb(
          command.duration === 'untilOff'
            ? { mode: 'untilOff' }
            : { mode: 'timed', until: now + DO_NOT_DISTURB_DURATION_MS[command.duration] },
          now,
        );
      }
      if (command.type === 'doNotDisturb/end') return setDoNotDisturb({ mode: 'off' }, now);
      if (command.type === 'hideAll/toggle') {
        hideAll = !hideAll;
        return { ...output(hideAll ? [] : [{ type: 'cat/entrance' }]), snapshotChanged: true };
      }
      if (command.type === 'debug/advanceClock') {
        const elapsed = command.minutes * 60_000;
        clockOffsetMs += elapsed;
        const timed = doNotDisturb.mode === 'timed';
        if (doNotDisturb.mode === 'timed')
          doNotDisturb = { ...doNotDisturb, until: doNotDisturb.until - elapsed };
        const result = tick(now);
        result.stateChanged ||= timed;
        result.snapshotChanged = true;
        return result;
      }
      if (command.type === 'debug/startupQuiet') {
        startupQuietUntil = now + clockOffsetMs + STARTUP_QUIET_MS;
        return finish(output(), now);
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

    tick,

    snapshot(now) {
      return {
        revision: ++revision,
        at: now,
        settings: copySettings(settings),
        doNotDisturb: { ...doNotDisturb },
        hideAll,
        silencedBy: silenceReasons(now),
        clockOffsetMs,
      };
    },

    exportState() {
      return { settings: copySettings(settings), doNotDisturb: { ...doNotDisturb } };
    },
  };
};
