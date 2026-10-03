import { describe, expect, it, vi } from 'vitest';
import { STARTUP_QUIET_MS } from '../../shared/core-api';
import type { SilenceReason } from '../../shared/ipc';
import { defaultGameState, GameStateSchema, type DoNotDisturb } from '../../shared/schemas';
import { createGameCore } from './index';

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
// UTC 正午，时区由测试明确传入，不依赖机器时区。
const noon = 12 * hour;
const content = { cats: {}, disabled: [], events: {} };
const utcOffsetMinutes = () => 0;
const random = () => 0.5;
const create = (now = noon, startupQuiet = false) =>
  createGameCore({ content, now, utcOffsetMinutes, startupQuiet, random });
const changed = { stateChanged: true, snapshotChanged: true, stageCommands: [], problems: [] };
const snapshotOnly = { ...changed, stateChanged: false };
const unchanged = { ...snapshotOnly, snapshotChanged: false };

function restore(doNotDisturb: DoNotDisturb, now = noon) {
  return createGameCore({
    content,
    now,
    utcOffsetMinutes,
    random,
    state: { ...defaultGameState([]), doNotDisturb },
  });
}

describe('勿扰模式 DoNotDisturb 的时间和存档', () => {
  it.each([
    ['30m', 30 * minute],
    ['1h', hour],
    ['2h', 2 * hour],
  ] as const)('%s 到点只结束一次，空闲 tick 不重复写备份', (duration, elapsed) => {
    const game = create();
    expect(game.handleCommand({ type: 'doNotDisturb/start', duration }, noon)).toEqual(changed);
    expect(game.snapshot(noon).doNotDisturb).toEqual({ mode: 'timed', until: noon + elapsed });
    expect(game.snapshot(noon).silencedBy).toEqual(['doNotDisturb']);
    expect(game.tick(noon + elapsed - 1)).toEqual(unchanged);
    expect(game.tick(noon + elapsed)).toEqual(changed);
    expect(game.exportState().doNotDisturb).toEqual({ mode: 'off' });
    expect(game.snapshot(noon + elapsed).silencedBy).toEqual([]);
    expect(game.tick(noon + elapsed + 1)).toEqual(unchanged);
  });

  it('直到关掉不因睡眠或快进结束，手动结束重复执行不写备份', () => {
    const game = create();
    expect(game.handleCommand({ type: 'doNotDisturb/end' }, noon)).toEqual(unchanged);
    expect(game.handleCommand({ type: 'doNotDisturb/start', duration: 'untilOff' }, noon)).toEqual(
      changed,
    );
    expect(game.handleCommand({ type: 'doNotDisturb/start', duration: 'untilOff' }, noon)).toEqual(
      unchanged,
    );
    expect(game.tick(noon + 30 * day)).toEqual(unchanged);
    expect(
      game.handleCommand({ type: 'debug/advanceClock', minutes: 10080 }, noon + 30 * day),
    ).toEqual(snapshotOnly);
    expect(game.exportState().doNotDisturb).toEqual({ mode: 'untilOff' });
    expect(game.handleCommand({ type: 'doNotDisturb/end' }, noon + 30 * day)).toEqual(changed);
    expect(game.handleCommand({ type: 'doNotDisturb/end' }, noon + 30 * day)).toEqual(unchanged);
  });

  it('重新开始按当前真实时间重算，快进后不会混入偏移', () => {
    const game = create();
    game.handleCommand({ type: 'doNotDisturb/start', duration: '30m' }, noon);
    game.handleCommand({ type: 'debug/advanceClock', minutes: 10 }, noon);
    expect(
      game.handleCommand({ type: 'doNotDisturb/start', duration: '1h' }, noon + minute),
    ).toEqual(changed);
    expect(game.exportState().doNotDisturb).toEqual({ mode: 'timed', until: noon + minute + hour });
  });

  it.each([noon + 30 * minute - 1, noon + 30 * minute, noon + 8 * hour])(
    '重启时 %i 按真实结束时刻恢复或清除勿扰',
    (restartAt) => {
      const game = create();
      game.handleCommand({ type: 'doNotDisturb/start', duration: '30m' }, noon);
      const restarted = createGameCore({
        content,
        state: game.exportState(),
        now: restartAt,
        utcOffsetMinutes,
        random,
      });
      expect(restarted.snapshot(restartAt).doNotDisturb).toEqual(
        restartAt < noon + 30 * minute
          ? { mode: 'timed', until: noon + 30 * minute }
          : { mode: 'off' },
      );
      expect(restarted.exportState().doNotDisturb).toEqual(
        restarted.snapshot(restartAt).doNotDisturb,
      );
    },
  );

  it('直到关掉重启仍生效，输入和输出对象不能偷偷修改勿扰状态', () => {
    const game = restore({ mode: 'untilOff' });
    expect(game.snapshot(noon).silencedBy).toEqual(['doNotDisturb']);
    const state = {
      ...defaultGameState([]),
      doNotDisturb: { mode: 'timed' as const, until: noon + hour },
    };
    const timed = createGameCore({ content, state, now: noon, utcOffsetMinutes, random });
    state.doNotDisturb.until = 0;
    const exported = timed.exportState();
    if (exported.doNotDisturb.mode === 'timed') exported.doNotDisturb.until = 0;
    const snapshot = timed.snapshot(noon);
    snapshot.doNotDisturb.mode = 'off';
    snapshot.silencedBy.length = 0;
    expect(timed.exportState().doNotDisturb).toEqual({ mode: 'timed', until: noon + hour });
    expect(timed.snapshot(noon).silencedBy).toEqual(['doNotDisturb']);
  });

  it('倒退不提前结束，睡眠跳过到期点后结束，之后倒退不会复活勿扰', () => {
    const game = restore({ mode: 'timed', until: noon + hour });
    expect(game.tick(noon - hour)).toEqual(unchanged);
    expect(game.exportState().doNotDisturb).toEqual({ mode: 'timed', until: noon + hour });
    expect(game.tick(noon + 8 * hour)).toEqual(changed);
    expect(game.tick(noon)).toEqual(unchanged);
    expect(game.exportState().doNotDisturb).toEqual({ mode: 'off' });
  });

  it.each(['advance-first', 'start-first'] as const)(
    '%s：快进前后开始勿扰，导出重建后剩余时间完全相同',
    (order) => {
      const game = create();
      if (order === 'advance-first')
        game.handleCommand({ type: 'debug/advanceClock', minutes: 10080 }, noon);
      game.handleCommand({ type: 'doNotDisturb/start', duration: '30m' }, noon);
      if (order === 'start-first')
        expect(game.handleCommand({ type: 'debug/advanceClock', minutes: 10 }, noon)).toEqual(
          changed,
        );
      const state = game.exportState();
      expect(GameStateSchema.safeParse(state).success).toBe(true);
      const remaining = (order === 'advance-first' ? 30 : 20) * minute;
      expect(state.doNotDisturb).toEqual({ mode: 'timed', until: noon + remaining });
      expect(game.snapshot(noon).doNotDisturb).toEqual(state.doNotDisturb);
      const restarted = createGameCore({
        content,
        state,
        now: noon + minute,
        utcOffsetMinutes,
        random,
      });
      expect(restarted.snapshot(noon + minute).clockOffsetMs).toBe(0);
      expect(restarted.snapshot(noon + minute).doNotDisturb).toEqual(state.doNotDisturb);
      expect(restarted.tick(noon + remaining - 1)).toEqual(unchanged);
      expect(restarted.tick(noon + remaining)).toEqual(changed);
    },
  );

  it('快进到期立刻结束勿扰，累加偏移只发快照且不污染真实时间', () => {
    const game = create();
    game.handleCommand({ type: 'doNotDisturb/start', duration: '30m' }, noon);
    expect(game.handleCommand({ type: 'debug/advanceClock', minutes: 30 }, noon)).toEqual(changed);
    expect(game.handleCommand({ type: 'debug/advanceClock', minutes: 1 }, noon)).toEqual(
      snapshotOnly,
    );
    expect(game.snapshot(noon)).toMatchObject({
      at: noon,
      clockOffsetMs: 31 * minute,
      doNotDisturb: { mode: 'off' },
    });
  });
});

describe('安静时段 QuietHours 和开机静默', () => {
  it.each([
    [23 * hour - 1, false],
    [23 * hour, true],
    [day - 1, true],
    [day, true],
    [day + 8 * hour - 1, true],
    [day + 8 * hour, false],
    [-1, true],
  ])('默认跨午夜时段在 %i 的边界正确', (at, quiet) => {
    expect(create(at).snapshot(at).silencedBy).toEqual(quiet ? ['quietHours'] : []);
  });

  it('白天时段包含开始不包含结束，首尾相等表示关闭，修改立即更新快照', () => {
    const game = create();
    game.handleCommand(
      { type: 'settings/update', patch: { quietHoursStart: '12:00', quietHoursEnd: '13:00' } },
      noon,
    );
    expect(game.snapshot(noon - 1).silencedBy).toEqual([]);
    expect(game.snapshot(noon).silencedBy).toEqual(['quietHours']);
    expect(game.tick(noon + hour - 1)).toEqual(unchanged);
    expect(game.tick(noon + hour)).toEqual(snapshotOnly);
    game.handleCommand({ type: 'settings/update', patch: { quietHoursEnd: '12:00' } }, noon);
    expect(game.snapshot(noon).silencedBy).toEqual([]);
    expect(game.tick(noon + day)).toEqual(unchanged);
  });

  it('进出安静时段及倒退跨边界均通知画面，不写存档；生成快照不吞掉 tick 的通知', () => {
    const game = create(23 * hour - 1);
    const state = game.exportState();
    expect(game.snapshot(23 * hour).silencedBy).toEqual(['quietHours']);
    expect(game.tick(23 * hour)).toEqual(snapshotOnly);
    expect(game.tick(23 * hour + minute)).toEqual(unchanged);
    expect(game.tick(23 * hour - 1)).toEqual(snapshotOnly);
    expect(game.tick(day + 7 * hour)).toEqual(snapshotOnly);
    expect(game.tick(day + 8 * hour)).toEqual(snapshotOnly);
    expect(game.exportState()).toEqual(state);
  });

  it('本地时间使用注入的偏移，并按快进后的日期重新取时区以支持夏令时', () => {
    const offset = vi.fn((at: number) => (at < day ? -300 : -240));
    const game = createGameCore({ content, now: 12 * hour, utcOffsetMinutes: offset, random });
    expect(game.snapshot(12 * hour).silencedBy).toEqual(['quietHours']);
    game.handleCommand({ type: 'debug/advanceClock', minutes: 1440 }, 12 * hour);
    expect(offset).toHaveBeenLastCalledWith(day + 12 * hour);
    expect(game.snapshot(12 * hour).silencedBy).toEqual([]);
    const beijing = createGameCore({
      content,
      now: 15 * hour,
      utcOffsetMinutes: () => 480,
      random,
    });
    expect(beijing.snapshot(15 * hour).silencedBy).toEqual(['quietHours']);
  });

  it('快进进入安静时段立即生效，不必等待下一次 tick', () => {
    const game = create(22 * hour);
    expect(game.handleCommand({ type: 'debug/advanceClock', minutes: 60 }, 22 * hour)).toEqual(
      snapshotOnly,
    );
    expect(game.snapshot(22 * hour).silencedBy).toEqual(['quietHours']);
    expect(game.tick(22 * hour)).toEqual(unchanged);
  });

  it('开机静默持续一分钟，到期后倒退不会复活，调试命令可以重新开始', () => {
    const game = create(noon, true);
    expect(game.snapshot(noon).silencedBy).toEqual(['startupQuiet']);
    expect(game.tick(noon - minute)).toEqual(unchanged);
    expect(game.tick(noon + STARTUP_QUIET_MS - 1)).toEqual(unchanged);
    expect(game.tick(noon + STARTUP_QUIET_MS)).toEqual(snapshotOnly);
    expect(game.tick(noon)).toEqual(unchanged);
    expect(game.handleCommand({ type: 'debug/startupQuiet' }, noon)).toEqual(snapshotOnly);
    expect(game.handleCommand({ type: 'debug/advanceClock', minutes: 1 }, noon)).toEqual(
      snapshotOnly,
    );
    expect(game.snapshot(noon).silencedBy).toEqual([]);
    expect(game.handleCommand({ type: 'debug/startupQuiet' }, noon)).toEqual(snapshotOnly);
    expect(game.tick(noon + STARTUP_QUIET_MS)).toEqual(snapshotOnly);
    const restarted = createGameCore({
      content,
      state: game.exportState(),
      now: noon,
      utcOffsetMinutes,
      random,
    });
    expect(restarted.snapshot(noon).silencedBy).toEqual([]);
  });

  it.each(Array.from({ length: 8 }, (_, mask) => mask))(
    '三种静音原因的组合 %i 全部列出，按固定顺序且相互独立',
    (mask) => {
      const at = mask & 2 ? 23 * hour : noon;
      const game = create(at, Boolean(mask & 4));
      if (mask & 1) game.handleCommand({ type: 'doNotDisturb/start', duration: 'untilOff' }, at);
      const reasons: SilenceReason[] = [];
      if (mask & 1) reasons.push('doNotDisturb');
      if (mask & 2) reasons.push('quietHours');
      if (mask & 4) reasons.push('startupQuiet');
      expect(game.snapshot(at).silencedBy).toEqual(reasons);
      game.handleCommand({ type: 'doNotDisturb/end' }, at);
      expect(game.snapshot(at).silencedBy).toEqual(
        reasons.filter((reason) => reason !== 'doNotDisturb'),
      );
    },
  );

  it('仍有安静时段时，开机静默到期也要通知原因变化', () => {
    const game = create(23 * hour, true);
    expect(game.tick(23 * hour + STARTUP_QUIET_MS)).toEqual(snapshotOnly);
    expect(game.snapshot(23 * hour + STARTUP_QUIET_MS).silencedBy).toEqual(['quietHours']);
  });
});
