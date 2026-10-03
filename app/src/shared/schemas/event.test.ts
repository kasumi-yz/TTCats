import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { zh } from '../strings.zh-CN';
import { EventSchema, EventStepSchema, EventTriggerSchema, type EventConfig } from './event';
import { validateWith } from './validate';

function problemsOf(schema: z.ZodType, data: unknown): string[] {
  const result = validateWith(schema, data);
  return result.ok ? [] : result.problems;
}

const base = { schemaVersion: 1 as const, requiredClips: [] };

/**
 * #109 要做的全部事件，用定稿的格式各写一份，证明格式够用。真正的配置、冷却和文字由 #109 定。
 */
const EXAMPLES: EventConfig[] = [
  {
    ...base,
    id: 'good-morning',
    name: '早安',
    trigger: { type: 'firstLaunchOfDay' },
    cooldownMinutes: 0,
    cats: { pick: 'all' },
    steps: [
      { do: 'wait', minMs: 0, maxMs: 3000 },
      { do: 'goToPose', pose: 'sit' },
      { do: 'playClip', clip: 'yawn' },
      { do: 'sound', slot: 'meow' },
      { do: 'bubble', texts: ['早上好～', '早呀'], durationMs: 4000 },
    ],
  },
  {
    ...base,
    id: 'late-night-sleepy',
    name: '深夜犯困',
    trigger: { type: 'timeOfDay', from: '23:00', to: '05:00' },
    cooldownMinutes: 360,
    cats: { pick: 'weighted', by: 'activity', prefer: 'low', min: 1, max: 1 },
    steps: [
      { do: 'goToPose', pose: 'sit' },
      { do: 'playClip', clip: 'yawn' },
      { do: 'wait', minMs: 3000, maxMs: 8000 },
      { do: 'goToPose', pose: 'sleep' },
      { do: 'wait', minMs: 60_000, maxMs: 120_000 },
    ],
  },
  {
    ...base,
    id: 'parkour',
    name: '跑酷',
    trigger: { type: 'random', perHour: 0.3 },
    cooldownMinutes: 45,
    cats: { pick: 'weighted', by: 'activity', prefer: 'high', min: 1, max: 1 },
    requiredClips: ['run'],
    steps: [
      { do: 'goToPose', pose: 'stand' },
      { do: 'moveTo', target: 'oppositeSide', gait: 'run' },
      { do: 'moveTo', target: 'oppositeSide', gait: 'run' },
      { do: 'playClip', clip: 'stretch' },
    ],
  },
  {
    ...base,
    id: 'chase-bug',
    name: '追飞虫',
    trigger: { type: 'random', perHour: 0.3 },
    cooldownMinutes: 60,
    cats: { pick: 'weighted', by: 'activity', prefer: 'high', min: 1, max: 1 },
    requiredClips: ['stalk', 'pounce'],
    steps: [
      { do: 'goToPose', pose: 'stand' },
      { do: 'effect', effect: 'bug', durationMs: 12_000 },
      { do: 'face', target: 'effect' },
      { do: 'playClip', clip: 'stalk' },
      { do: 'wait', minMs: 1500, maxMs: 3000 },
      { do: 'face', target: 'effect' },
      { do: 'playClip', clip: 'pounce' },
    ],
  },
  {
    ...base,
    id: 'user-away',
    name: '你离开了',
    trigger: { type: 'userState', state: 'away' },
    cooldownMinutes: 0,
    cats: { pick: 'all' },
    steps: [
      { do: 'wait', minMs: 0, maxMs: 20_000 },
      { do: 'goToPose', pose: 'sleep' },
      { do: 'stay' },
    ],
  },
  {
    ...base,
    id: 'user-back',
    name: '你回来了',
    trigger: { type: 'userState', state: 'back' },
    cooldownMinutes: 0,
    cats: { pick: 'all' },
    steps: [
      { do: 'wait', minMs: 0, maxMs: 2000 },
      { do: 'goToPose', pose: 'stand' },
      { do: 'moveTo', target: 'pointer', gait: 'walk' },
      { do: 'sound', slot: 'meow' },
      { do: 'bubble', texts: ['你回来啦'], durationMs: 3000 },
      { do: 'goToPose', pose: 'sit' },
    ],
  },
  {
    ...base,
    id: 'sedentary-reminder',
    name: '久坐提醒',
    trigger: { type: 'userState', state: 'sedentary' },
    cooldownMinutes: 60,
    cats: { pick: 'weighted', by: 'clinginess', prefer: 'high', min: 1, max: 1 },
    steps: [
      { do: 'moveTo', target: 'pointer', gait: 'walk' },
      { do: 'goToPose', pose: 'sit' },
      { do: 'sound', slot: 'meow' },
      { do: 'bubble', texts: ['坐好久啦，起来动一动吧'], durationMs: 6000 },
    ],
  },
  {
    ...base,
    id: 'birthday',
    name: '生日',
    trigger: { type: 'catDate', date: 'birthday' },
    cooldownMinutes: 1440,
    cats: { pick: 'dateOwner' },
    steps: [
      { do: 'goToPose', pose: 'sit' },
      { do: 'effect', effect: 'gift', durationMs: 60_000 },
      { do: 'effect', effect: 'confetti', durationMs: 5000 },
      { do: 'bubble', texts: ['今天是{name}的生日！'], durationMs: 6000 },
    ],
  },
  {
    ...base,
    id: 'home-date',
    name: '到家纪念日',
    trigger: { type: 'catDate', date: 'homeDate' },
    cooldownMinutes: 1440,
    cats: { pick: 'dateOwner' },
    steps: [
      { do: 'effect', effect: 'confetti', durationMs: 5000 },
      { do: 'bubble', texts: ['今天是{name}到家的纪念日'], durationMs: 6000 },
    ],
  },
  {
    ...base,
    id: 'spring-festival',
    name: '春节',
    trigger: { type: 'lunarHoliday', date: '01-01' },
    cooldownMinutes: 1440,
    cats: { pick: 'weighted', by: 'activity', prefer: 'high', min: 1, max: 1 },
    steps: [
      { do: 'effect', effect: 'lantern', durationMs: 60_000 },
      { do: 'effect', effect: 'confetti', durationMs: 5000 },
      { do: 'bubble', texts: ['过年好！'], durationMs: 5000 },
    ],
  },
  {
    ...base,
    id: 'national-day',
    name: '国庆',
    trigger: { type: 'holiday', date: '10-01' },
    cooldownMinutes: 1440,
    cats: { pick: 'weighted', by: 'activity', prefer: 'high', min: 1, max: 1 },
    steps: [
      { do: 'effect', effect: 'confetti', durationMs: 5000 },
      { do: 'bubble', texts: ['国庆快乐'], durationMs: 5000 },
    ],
  },
];

describe('事件格式（M3 定稿）', () => {
  it.each(EXAMPLES.map((event) => [event.name, event] as const))(
    '#109 的事件「%s」能用定稿的格式写出来',
    (_name, event) => {
      expect(problemsOf(EventSchema, event)).toEqual([]);
    },
  );

  it('喂饭提醒已取消（2026-10-03 用户决定），feedingTime 不再是触发条件', () => {
    expect(problemsOf(EventTriggerSchema, { type: 'feedingTime' })).toHaveLength(1);
  });

  it.each(['01-01', '08-15', '12-30', '05-05'])('农历日期 %s 合法', (date) => {
    expect(problemsOf(EventTriggerSchema, { type: 'lunarHoliday', date })).toEqual([]);
  });

  it.each(['13-01', '00-15', '01-31', '1-1', '08-15 '])('农历日期 %s 不合法', (date) => {
    expect(problemsOf(EventTriggerSchema, { type: 'lunarHoliday', date })).toEqual([
      `字段 date（日期） 不对：${zh.validation.lunarMonthDayFormat}`,
    ]);
  });

  it('"今天过纪念日的猫"只能配猫的生日或到家纪念日', () => {
    const birthday = EXAMPLES.find((event) => event.id === 'birthday');
    expect(
      problemsOf(EventSchema, { ...birthday, trigger: { type: 'holiday', date: '10-01' } }),
    ).toEqual([`字段 cats.pick（怎么挑猫） 不对：${zh.validation.dateOwnerNeedsCatDate}`]);
  });

  it('stay 只能是最后一步', () => {
    const away = EXAMPLES.find((event) => event.id === 'user-away');
    expect(
      problemsOf(EventSchema, {
        ...away,
        steps: [{ do: 'stay' }, { do: 'goToPose', pose: 'sleep' }],
      }),
    ).toEqual([`字段 steps[0]（步骤） 不对：${zh.validation.stayMustBeLast}`]);
  });

  it('目标是特效时，前面必须先放特效', () => {
    const chase = EXAMPLES.find((event) => event.id === 'chase-bug');
    expect(
      problemsOf(EventSchema, {
        ...chase,
        steps: [
          { do: 'face', target: 'effect' },
          { do: 'effect', effect: 'bug', durationMs: 1000 },
        ],
      }),
    ).toEqual([`字段 steps[0].target（目标） 不对：${zh.validation.effectTargetFirst}`]);
  });

  it('等待的最长时间不能小于最短时间，时间段首尾不能一样', () => {
    const sleepy = EXAMPLES.find((event) => event.id === 'late-night-sleepy');
    expect(
      problemsOf(EventSchema, {
        ...sleepy,
        trigger: { type: 'timeOfDay', from: '23:00', to: '23:00' },
        steps: [{ do: 'wait', minMs: 2000, maxMs: 1000 }],
      }),
    ).toEqual([
      `字段 trigger.to（结束时刻） 不对：${zh.validation.emptyTimeRange}`,
      `字段 steps[0].maxMs（最长（毫秒）） 不对：${zh.validation.maxMsBelowMinMs}`,
    ]);
  });

  it('气泡文字只认 {name} 占位，写错时说清楚是哪个', () => {
    expect(
      problemsOf(EventStepSchema, {
        do: 'bubble',
        texts: ['{name}饿了', '{nmae}困了'],
        durationMs: 1000,
      }),
    ).toEqual([`字段 texts[1]（气泡文字） 不对：${zh.validation.unknownPlaceholder('nmae')}`]);
  });

  it('goToPose 只能去基础姿势，连接姿势要靠具体的片段', () => {
    expect(problemsOf(EventStepSchema, { do: 'goToPose', pose: 'crouch' })).toHaveLength(1);
  });

  it('不认识的特效 id 会被拒绝', () => {
    expect(
      problemsOf(EventStepSchema, { do: 'effect', effect: 'fireworks', durationMs: 1000 }),
    ).toHaveLength(1);
    expect(
      problemsOf(EventStepSchema, { do: 'effect', effect: 'cut', durationMs: 1000 }),
    ).toHaveLength(1);
  });

  it('不能写某只猫的 id 来指定参与的猫（ADR-0005）', () => {
    const away = EXAMPLES.find((event) => event.id === 'user-away');
    expect(problemsOf(EventSchema, { ...away, cats: { pick: 'all', cat: 'doudou' } })).toEqual([
      expect.stringContaining('cat'),
    ]);
  });
});
