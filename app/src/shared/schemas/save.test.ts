import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { zh } from '../strings.zh-CN';
import {
  DO_NOT_DISTURB_DURATION_MS,
  DoNotDisturbDurationSchema,
  DoNotDisturbSchema,
} from './do-not-disturb';
import { CURRENT_SAVE_VERSION, defaultGameState, GameStateSchema, SAVE_MIGRATIONS } from './save';
import { DEFAULT_HIDE_ALL_SHORTCUT, defaultSettings, SettingsSchema } from './settings';
import { validateWith } from './validate';

function problemsOf(schema: z.ZodType, data: unknown): string[] {
  const result = validateWith(schema, data);
  return result.ok ? [] : result.problems;
}

/** M1（存档版本 1）写出的状态：只有 settings，设置只有 5 项。 */
function v1State() {
  return {
    settings: {
      visibleCats: ['doudou', 'test-b'],
      activityLevel: 'lively',
      scale: 1.4,
      floorDepth: 0.2,
      showInScreenCapture: true,
    },
  };
}

/** 把版本 from 的状态一步步迁移到当前版本（和 SaveStore 的做法一样）。 */
function migrate(state: unknown, from: number): unknown {
  let result = state;
  for (let version = from; version < CURRENT_SAVE_VERSION; version++) {
    const step = SAVE_MIGRATIONS[version];
    if (step === undefined) throw new Error(`缺少版本 ${version} 的迁移步骤`);
    result = step(result);
  }
  return result;
}

describe('存档迁移', () => {
  it('每个旧版本都有升到下一版的迁移步骤', () => {
    expect(CURRENT_SAVE_VERSION).toBe(2);
    for (let version = 1; version < CURRENT_SAVE_VERSION; version++) {
      expect(SAVE_MIGRATIONS[version]).toBeTypeOf('function');
    }
  });

  it('版本 1 升到 2：原来的设置不变，补上新设置的默认值，勿扰为没开', () => {
    const migrated = migrate(v1State(), 1);
    expect(problemsOf(GameStateSchema, migrated)).toEqual([]);
    expect(migrated).toEqual({
      settings: {
        ...v1State().settings,
        purrEnabled: true,
        purrVolume: 0.6,
        meowEnabled: true,
        meowVolume: 0.3,
        quietHoursStart: '23:00',
        quietHoursEnd: '08:00',
        hideAllShortcut: 'CommandOrControl+Alt+Shift+H',
        launchAtLogin: true,
        autoUpdate: true,
        display: null,
      },
      doNotDisturb: { mode: 'off' },
    });
  });

  it('迁移补上的值和现在的默认设置一样', () => {
    const migrated = GameStateSchema.parse(migrate(v1State(), 1));
    expect(migrated.settings).toEqual({
      ...defaultSettings(v1State().settings.visibleCats),
      ...v1State().settings,
    });
    expect(migrated.doNotDisturb).toEqual(defaultGameState([]).doNotDisturb);
  });

  it('迁移是纯函数，不改传进来的对象', () => {
    const input = v1State();
    migrate(input, 1);
    expect(input).toEqual(v1State());
  });

  it.each([null, 'text', [], {}, { settings: null }, { settings: [] }])(
    '版本 1 的状态格式不对时抛出中文错误：%j',
    (state) => {
      expect(() => SAVE_MIGRATIONS[1]?.(state)).toThrow(zh.interfaces.migrationBadShape(1));
    },
  );

  it('版本 1 的设置本身不合法时，迁移后的校验会指出字段', () => {
    const state = v1State();
    const broken = { ...state, settings: { ...state.settings, scale: 9 } };
    expect(problemsOf(GameStateSchema, migrate(broken, 1))).toEqual([
      expect.stringContaining('settings.scale（缩放）'),
    ]);
  });
});

describe('M2 的设置项', () => {
  it('默认值：声音都开着、喵叫比呼噜轻，安静时段 23:00～08:00，开机启动和自动更新都开，主显示器', () => {
    const settings = defaultSettings(['test-a']);
    expect(problemsOf(SettingsSchema, settings)).toEqual([]);
    expect(settings).toMatchObject({
      purrEnabled: true,
      meowEnabled: true,
      quietHoursStart: '23:00',
      quietHoursEnd: '08:00',
      hideAllShortcut: DEFAULT_HIDE_ALL_SHORTCUT,
      launchAtLogin: true,
      autoUpdate: true,
      display: null,
    });
    expect(settings.meowVolume).toBeLessThan(settings.purrVolume);
  });

  it.each([
    [{ purrEnabled: 'yes' }, 'purrEnabled（呼噜开关）'],
    [{ purrVolume: -0.1 }, 'purrVolume（呼噜音量）'],
    [{ meowEnabled: 1 }, 'meowEnabled（喵叫开关）'],
    [{ meowVolume: 1.01 }, 'meowVolume（喵叫音量）'],
    [{ quietHoursStart: '7:00' }, 'quietHoursStart（安静时段开始）'],
    [{ quietHoursEnd: '24:00' }, 'quietHoursEnd（安静时段结束）'],
    [{ hideAllShortcut: 'Ctrl+' }, 'hideAllShortcut（一键隐藏快捷键）'],
    [{ launchAtLogin: null }, 'launchAtLogin（开机启动）'],
    [{ autoUpdate: 'off' }, 'autoUpdate（自动更新）'],
    [{ display: { id: 1, label: 'x', width: 0, height: 1 } }, 'display.width（宽度）'],
    [{ display: { id: 1, width: 10, height: 10 } }, 'display.label（显示器名字）'],
    [{ display: 'primary' }, 'display（显示器）'],
  ])('%j 不合法，中文报错说清楚是哪个字段', (patch, field) => {
    const problems = problemsOf(SettingsSchema, { ...defaultSettings([]), ...patch });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(field);
    expect(problems[0]).toMatch(/[一-鿿]/u);
  });

  it('快捷键的报错说明了原因', () => {
    expect(
      problemsOf(SettingsSchema, { ...defaultSettings([]), hideAllShortcut: 'Ctrl+Shift+F10' }),
    ).toEqual([
      `字段 hideAllShortcut（一键隐藏快捷键） 不对：${zh.validation.acceleratorReserved}`,
    ]);
    expect(
      problemsOf(SettingsSchema, { ...defaultSettings([]), hideAllShortcut: 'Shift+H' }),
    ).toEqual([
      `字段 hideAllShortcut（一键隐藏快捷键） 不对：${zh.validation.acceleratorNeedsModifier}`,
    ]);
  });

  it('安静时段可以跨午夜，也可以开始等于结束（表示没有安静时段）', () => {
    for (const [start, end] of [
      ['22:30', '06:00'],
      ['13:00', '14:00'],
      ['00:00', '00:00'],
    ]) {
      expect(
        problemsOf(SettingsSchema, {
          ...defaultSettings([]),
          quietHoursStart: start,
          quietHoursEnd: end,
        }),
      ).toEqual([]);
    }
  });

  it('选了某块显示器时记下 id、型号名和分辨率', () => {
    expect(
      problemsOf(SettingsSchema, {
        ...defaultSettings([]),
        display: { id: 2_779_098_405, label: 'DELL U3423WE', width: 3440, height: 1440 },
      }),
    ).toEqual([]);
  });
});

describe('勿扰模式', () => {
  it.each([{ mode: 'off' }, { mode: 'timed', until: 1_800_000_000_000 }, { mode: 'untilOff' }])(
    '%j 合法',
    (state) => {
      expect(problemsOf(DoNotDisturbSchema, state)).toEqual([]);
    },
  );

  it.each([
    [{ mode: 'timed' }, 'until（结束时间）'],
    [{ mode: 'timed', until: Infinity }, 'until（结束时间）'],
    [{ mode: 'off', until: 1 }, 'until'],
    [{ mode: 'paused' }, 'mode（模式）'],
  ])('%j 不合法，中文报错说清楚是哪个字段', (state, field) => {
    const problems = problemsOf(DoNotDisturbSchema, state);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(field);
  });

  it('存档里缺了勿扰状态时报出字段', () => {
    expect(problemsOf(GameStateSchema, { settings: defaultSettings([]) })).toEqual([
      '缺少必填字段 doNotDisturb（勿扰模式）',
    ]);
  });

  it('可选时长：30 分钟、1 小时、2 小时、直到关掉', () => {
    expect(DoNotDisturbDurationSchema.options).toEqual(['30m', '1h', '2h', 'untilOff']);
    expect(DO_NOT_DISTURB_DURATION_MS).toEqual({
      '30m': 1_800_000,
      '1h': 3_600_000,
      '2h': 7_200_000,
    });
  });

  it('默认状态能通过校验，勿扰没开', () => {
    const state = defaultGameState(['test-a']);
    expect(problemsOf(GameStateSchema, state)).toEqual([]);
    expect(state.doNotDisturb).toEqual({ mode: 'off' });
  });
});
