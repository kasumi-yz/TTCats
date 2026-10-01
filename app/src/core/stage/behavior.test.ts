import { describe, expect, it } from 'vitest';
import { ActivityLevelSchema, type Personality } from '../../shared/schemas';
import {
  behaviorWeights,
  chooseBehavior,
  dailyActions,
  restDurationMs,
  type ChoiceContext,
} from './behavior';
import { ClipLibrary } from './pose-graph';
import { at, NEUTRAL, seeded, testClips } from './test-fixtures';

const lively: Personality = { ...NEUTRAL, activity: 0.9 };
const lazy: Personality = { ...NEUTRAL, activity: 0.1 };

function context(overrides: Partial<ChoiceContext> = {}): ChoiceContext {
  return {
    personality: NEUTRAL,
    pose: 'stand',
    library: new ClipLibrary(testClips()),
    lastAction: undefined,
    ...overrides,
  };
}

function weightOf(ctx: ChoiceContext, kind: string): number {
  return behaviorWeights(ctx)
    .filter((c) => c.behavior.kind === kind)
    .reduce((sum, c) => sum + c.weight, 0);
}

describe('行为选择', () => {
  it('日常动作只用猫咪包里有的、不是反应用的动作片段', () => {
    expect(dailyActions(new ClipLibrary(testClips()))).toEqual(['groom', 'stretch', 'yawn']);
    expect(dailyActions(new ClipLibrary(testClips(['groom', 'yawn'])))).toEqual(['stretch']);
  });

  it('上一个做过的动作不会紧接着再选（D7）', () => {
    const kinds = behaviorWeights(context({ lastAction: 'groom' })).map((c) => c.behavior);
    expect(kinds).not.toContainEqual({ kind: 'action', clip: 'groom' });
    expect(kinds).toContainEqual({ kind: 'action', clip: 'yawn' });
  });

  it('已经在这个姿势里，就不会再选"换到这个姿势"', () => {
    const rests = behaviorWeights(context({ pose: 'sit' }))
      .map((c) => c.behavior)
      .filter((b) => b.kind === 'rest');
    expect(rests).toEqual([
      { kind: 'rest', pose: 'stand' },
      { kind: 'rest', pose: 'sleep' },
    ]);
  });

  it('活跃的猫更爱走动，不活跃的猫更爱待着和睡觉', () => {
    const a = context({ personality: lively });
    const b = context({ personality: lazy });
    expect(weightOf(a, 'wander')).toBeGreaterThan(weightOf(b, 'wander'));
    expect(weightOf(a, 'idle')).toBeLessThan(weightOf(b, 'idle'));
  });

  it('同样的随机数，选出的行为只取决于数据', () => {
    const picks = (seed: number) => {
      const random = seeded(seed);
      return Array.from({ length: 50 }, () => chooseBehavior(random, context()));
    };
    expect(picks(7)).toEqual(picks(7));
    expect(new Set(picks(7).map((b) => b.kind)).size).toBeGreaterThan(2);
  });
});

describe('活跃度', () => {
  it('只改变整体频率：两只猫待着的时长之比在每一档都一样', () => {
    const ratios = ActivityLevelSchema.options.map(
      (level) =>
        restDurationMs(seeded(1), 'sit', lively, level) /
        restDurationMs(seeded(1), 'sit', lazy, level),
    );
    for (const ratio of ratios) expect(ratio).toBeCloseTo(at(ratios, 0));
    expect(ratios[0]).toBeLessThan(1);
  });

  it('越闹腾，每件事持续得越短', () => {
    const durations = ActivityLevelSchema.options.map((level) =>
      restDurationMs(seeded(1), 'stand', NEUTRAL, level),
    );
    expect([...durations].sort((x, y) => y - x)).toEqual(durations);
  });

  it('待机时长是随机的', () => {
    const random = seeded(3);
    const durations = Array.from({ length: 10 }, () =>
      restDurationMs(random, 'stand', NEUTRAL, 'natural'),
    );
    expect(new Set(durations).size).toBe(10);
  });
});
