import { describe, expect, it } from 'vitest';
import type { CatPlacement, StageBounds, StageFrame } from '../../shared/core-api';
import type { Cat, Clip, Settings } from '../../shared/schemas';
import {
  CatActor,
  MAX_WALK_SLOPE,
  PLAYBACK_RATE_RANGE,
  type ActorEnv,
  type SegmentInfo,
} from './actor';
import { Floor } from './floor';
import { clipDurationMs } from './pose-graph';
import { createStageCore, CUT_EFFECT_MS, Stage } from './stage-core';
import {
  at,
  catalog,
  defined,
  NEUTRAL,
  SCREEN,
  seeded,
  snapshot,
  testCat,
  testClip,
  testClips,
} from './test-fixtures';

const T0 = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

interface LoggedSegment extends SegmentInfo {
  cat: string;
  at: number;
}

function setup(
  options: {
    cats?: { cat: Cat; clips?: Clip[] }[];
    settings?: Partial<Settings>;
    bounds?: StageBounds;
    seed?: number;
  } = {},
) {
  const cats = options.cats ?? [{ cat: testCat('a') }];
  const log: LoggedSegment[] = [];
  const stage = new Stage({
    content: catalog(cats),
    snapshot: snapshot(
      cats.map((c) => c.cat.id),
      options.settings,
    ),
    bounds: options.bounds ?? SCREEN,
    now: T0,
    random: seeded(options.seed ?? 1),
    observer: { segmentStarted: (cat, seg, at) => log.push({ ...seg, cat, at }) },
  });
  return { stage, log };
}

/** 从 from 到 to 每隔 stepMs 调一次 update，返回每一帧。 */
function run(stage: Stage, from: number, to: number, stepMs = 33): StageFrame[] {
  const frames: StageFrame[] = [];
  for (let t = from + stepMs; t <= to; t += stepMs) frames.push(stage.update(t));
  return frames;
}

function placementOf(frame: StageFrame, cat = 'a'): CatPlacement {
  const p = frame.cats.find((c) => c.cat === cat);
  if (p === undefined) throw new Error(`no cat ${cat}`);
  return p;
}

function segmentsOf(log: LoggedSegment[], cat = 'a'): LoggedSegment[] {
  return log.filter((s) => s.cat === cat);
}

describe('片段调度', () => {
  it('首尾姿势都对得上：自己生活两小时，每个片段都从上一个片段的结束姿势开始', () => {
    const { stage, log } = setup({
      cats: [
        { cat: testCat('a') },
        { cat: testCat('b', { personality: { ...NEUTRAL, activity: 0.9 } }) },
      ],
    });
    run(stage, T0, T0 + 2 * HOUR, 100);
    for (const cat of ['a', 'b']) {
      const segments = segmentsOf(log, cat);
      expect(segments.length).toBeGreaterThan(100);
      for (let i = 1; i < segments.length; i++) {
        expect(at(segments, i).cut).toBe(false);
        expect(at(segments, i).clip.fromPose).toBe(at(segments, i - 1).clip.toPose);
      }
    }
  });

  it('同一个动作不连续出现两次（D7）', () => {
    const { stage, log } = setup({
      cats: [{ cat: testCat('a', { personality: { ...NEUTRAL, activity: 1 } }) }],
    });
    run(stage, T0, T0 + 4 * HOUR, 200);
    const actions = segmentsOf(log)
      .filter((s) => s.clip.kind === 'action')
      .map((s) => s.clip.name);
    expect(actions.length).toBeGreaterThan(20);
    for (let i = 1; i < actions.length; i++) expect(actions[i]).not.toBe(actions[i - 1]);
  });

  it('播放速度在 0.9～1.1 倍之间浮动', () => {
    const { stage, log } = setup();
    run(stage, T0, T0 + HOUR, 200);
    const rates = segmentsOf(log).map((s) => s.rate);
    expect(Math.min(...rates)).toBeGreaterThanOrEqual(PLAYBACK_RATE_RANGE[0]);
    expect(Math.max(...rates)).toBeLessThan(PLAYBACK_RATE_RANGE[1]);
    expect(new Set(rates).size).toBe(rates.length);
  });

  it('有多个版本时，同一个片段不连续用同一个版本', () => {
    const clips = [
      ...testClips(),
      testClip('idle-stand', { variant: 2 }),
      testClip('idle-sit', { variant: 2 }),
    ];
    const { stage, log } = setup({ cats: [{ cat: testCat('a'), clips }] });
    run(stage, T0, T0 + 2 * HOUR, 200);
    const last = new Map<string, number>();
    let checked = 0;
    for (const s of segmentsOf(log)) {
      if (s.clip.name === 'idle-stand' || s.clip.name === 'idle-sit') {
        if (last.has(s.clip.name)) {
          expect(s.clip.variant).not.toBe(last.get(s.clip.name));
          checked++;
        }
        last.set(s.clip.name, s.clip.variant);
      }
    }
    expect(checked).toBeGreaterThan(5);
  });

  it('循环片段随机播一段时长，而且只在播完整遍时结束', () => {
    const { stage, log } = setup();
    run(stage, T0, T0 + 2 * HOUR, 50);
    const segments = segmentsOf(log);
    const holds: number[] = [];
    for (let i = 0; i + 1 < segments.length; i++) {
      const s = at(segments, i);
      if (s.clip.name !== 'idle-stand' && s.clip.name !== 'idle-sit') continue;
      const clipTime = (at(segments, i + 1).at - s.at) * s.rate;
      const cycles = clipTime / clipDurationMs(s.clip);
      expect(cycles).toBeCloseTo(Math.round(cycles), 6);
      holds.push(Math.round(cycles));
    }
    expect(new Set(holds).size).toBeGreaterThan(3);
  });

  it.each([0, 1])('按真实经过的时间推进：每帧间隔不同，结果一样（地板纵深 %s）', (floorDepth) => {
    const settings = { floorDepth };
    const a = setup({ settings, seed: 5 }).stage;
    const b = setup({ settings, seed: 5 }).stage;
    for (let checkpoint = 1; checkpoint <= 3600; checkpoint++) {
      const t = T0 + checkpoint * 1000;
      run(a, t - 1000, t - 16, 16);
      run(b, t - 1000, t - 100, 300);
      const pa = placementOf(a.update(t));
      const pb = placementOf(b.update(t));
      expect(pb.clip).toBe(pa.clip);
      expect(pb.variant).toBe(pa.variant);
      expect(pb.x).toBeCloseTo(pa.x, 6);
      expect(pb.depth).toBeCloseTo(pa.depth, 9);
      expect(pb.clipTimeMs).toBeCloseTo(pa.clipTimeMs, 6);
    }
  });
});

describe('在地板上移动', () => {
  it('走路时按片段的移动速度前进，脚不打滑；不走路时位置不变', () => {
    const { stage } = setup({ settings: { floorDepth: 0, scale: 1.5 } });
    const frames = run(stage, T0, T0 + 30 * MIN, 20);
    let walked = 0;
    for (let i = 1; i < frames.length; i++) {
      const prev = placementOf(at(frames, i - 1));
      const cur = placementOf(at(frames, i));
      if (prev.clip !== cur.clip || prev.clipTimeMs > cur.clipTimeMs) continue; // 片段边界
      const dx = Math.abs(cur.x - prev.x);
      if (cur.clip === 'walk') {
        expect(dx).toBeCloseTo((80 * cur.scale * cur.playbackRate * 20) / 1000, 6);
        walked++;
      } else {
        expect(dx).toBe(0);
      }
      expect(cur.y).toBe(prev.y);
    }
    expect(walked).toBeGreaterThan(100);
  });

  it('切换片段时落脚锚点的位置连续，猫不跳位', () => {
    const { stage } = setup();
    const frames = run(stage, T0, T0 + HOUR, 33);
    for (let i = 1; i < frames.length; i++) {
      const prev = placementOf(at(frames, i - 1));
      const cur = placementOf(at(frames, i));
      expect(Math.abs(cur.x - prev.x)).toBeLessThan(5);
      expect(Math.abs(cur.y - prev.y)).toBeLessThan(5);
    }
  });

  it('按行走方向镜像；走完以后保持朝向', () => {
    const { stage } = setup();
    const frames = run(stage, T0, T0 + HOUR, 50);
    let left = 0;
    let right = 0;
    for (let i = 1; i < frames.length; i++) {
      const prev = placementOf(at(frames, i - 1));
      const cur = placementOf(at(frames, i));
      if (cur.clip !== 'walk' || prev.clip !== 'walk' || cur.clipTimeMs < prev.clipTimeMs) continue;
      // 测试片段朝右，往左走时要镜像
      if (cur.x < prev.x) {
        expect(cur.mirrored).toBe(true);
        left++;
      } else if (cur.x > prev.x) {
        expect(cur.mirrored).toBe(false);
        right++;
      }
    }
    expect(left).toBeGreaterThan(0);
    expect(right).toBeGreaterThan(0);
  });

  it('不能镜像的片段，往反方向走时改用朝那边的版本', () => {
    const clips = [
      ...testClips(['walk']),
      testClip('walk', { mirrorable: false, facing: 'right' }),
      testClip('walk', { variant: 2, mirrorable: false, facing: 'left' }),
    ];
    const { stage, log } = setup({ cats: [{ cat: testCat('a'), clips }] });
    const frames = run(stage, T0, T0 + HOUR, 50);
    expect(frames.every((f) => !placementOf(f).mirrored || placementOf(f).clip !== 'walk')).toBe(
      true,
    );
    const walks = segmentsOf(log).filter((s) => s.clip.name === 'walk');
    expect(new Set(walks.map((s) => s.clip.facing))).toEqual(new Set(['left', 'right']));
  });

  function walkLeftFrom960(clips: Clip[], gait: 'walk' | 'run') {
    const env: ActorEnv = {
      random: () => 0.5,
      floor: new Floor({ bounds: SCREEN, scale: 1, floorDepth: 0 }),
      scale: 1,
      activityLevel: 'natural',
      addEffect: () => undefined,
    };
    const actor = new CatActor(testCat('a'), clips, env, {
      x: 960,
      d: 0.5,
      facing: 'right',
      now: T0,
    });
    actor.interrupt([{ kind: 'move', gait, x: 100, d: 0.5 }], { kind: 'summon' }, 'cut', T0);
    const before = actor.placement();
    actor.advance(T0, T0 + 500, false);
    return { before, after: actor.placement() };
  }

  it('奔跑片段不能朝目标方向时，改用能朝那边的走路片段，不倒着滑', () => {
    const clips = [...testClips(['run']), testClip('run', { mirrorable: false, facing: 'right' })];
    const { after } = walkLeftFrom960(clips, 'run');
    expect(after).toMatchObject({ clip: 'walk', mirrored: true });
    expect(after.x).toBeLessThan(960);
  });

  it('走路片段也不能朝目标方向时，猫不走，而不是倒着滑', () => {
    const clips = [
      ...testClips(['run', 'walk']),
      testClip('walk', { mirrorable: false, facing: 'right' }),
    ];
    const { before, after } = walkLeftFrom960(clips, 'run');
    expect(after.x).toBe(960);
    expect(after.clip).not.toBe('walk');
    expect(before.clip).not.toBe('walk');
    // 往右走照常
    const stage = setup({ cats: [{ cat: testCat('a'), clips }] }).stage;
    const frames = run(stage, T0, T0 + HOUR, 50);
    for (let i = 1; i < frames.length; i++) {
      const prev = placementOf(at(frames, i - 1));
      const cur = placementOf(at(frames, i));
      if (cur.clip === 'walk' && prev.clip === 'walk') {
        expect(cur.x).toBeGreaterThanOrEqual(prev.x);
        expect(cur.mirrored).toBe(false);
      }
    }
    expect(frames.some((f) => placementOf(f).clip === 'walk')).toBe(true);
  });

  it('斜着走：纵向位移不超过横向位移的一定比例，远近缩放随纵深变化', () => {
    const { stage } = setup({ settings: { floorDepth: 1 } });
    const frames = run(stage, T0, T0 + HOUR, 50);
    const floor = new Floor({ bounds: SCREEN, scale: 1, floorDepth: 1 });
    let diagonal = 0;
    for (let i = 1; i < frames.length; i++) {
      const prev = placementOf(at(frames, i - 1));
      const cur = placementOf(at(frames, i));
      expect(cur.scale).toBeCloseTo(floor.depthScale(cur.depth), 9);
      expect(cur.y).toBeCloseTo(floor.yAt(cur.depth), 9);
      if (cur.clip !== 'walk' || prev.clip !== 'walk' || cur.clipTimeMs < prev.clipTimeMs) continue;
      const dy = Math.abs(cur.y - prev.y);
      expect(dy).toBeLessThanOrEqual(MAX_WALK_SLOPE * Math.abs(cur.x - prev.x) + 1e-9);
      if (dy > 0) diagonal++;
    }
    expect(diagonal).toBeGreaterThan(0);
  });

  it('按纵深排序，离得近的后画；缩放 = 用户缩放 × 相对体型 × 远近缩放', () => {
    const { stage } = setup({
      cats: [
        { cat: testCat('a', { relativeSize: 0.8 }) },
        { cat: testCat('b', { relativeSize: 1.2 }) },
        { cat: testCat('c') },
      ],
      settings: { scale: 1.5, floorDepth: 1 },
    });
    const floor = new Floor({ bounds: SCREEN, scale: 1.5, floorDepth: 1 });
    for (const frame of run(stage, T0, T0 + 10 * MIN, 500)) {
      const depths = frame.cats.map((c) => c.depth);
      expect([...depths].sort((x, y) => x - y)).toEqual(depths);
      for (const c of frame.cats) {
        const rel = defined(
          new Map([
            ['a', 0.8],
            ['b', 1.2],
            ['c', 1],
          ]).get(c.cat),
        );
        expect(c.scale).toBeCloseTo(1.5 * rel * floor.depthScale(c.depth), 9);
      }
    }
  });

  it('猫一直待在地板上，不跑出屏幕', () => {
    const { stage } = setup({
      cats: [
        { cat: testCat('a', { relativeSize: 1.5, personality: { ...NEUTRAL, activity: 1 } }) },
      ],
      settings: { scale: 2, floorDepth: 1 },
    });
    const floor = new Floor({ bounds: SCREEN, scale: 2, floorDepth: 1 });
    const { min, max } = floor.xRange(1.5);
    for (const frame of run(stage, T0, T0 + 2 * HOUR, 100)) {
      const p = placementOf(frame);
      expect(p.x).toBeGreaterThanOrEqual(min);
      expect(p.x).toBeLessThanOrEqual(max);
      expect(p.y).toBeGreaterThanOrEqual(floor.farY);
      expect(p.y).toBeLessThanOrEqual(floor.nearY);
    }
  });
});

describe('打断', () => {
  it('平常的姿势变化等当前循环片段播完这一遍，再接过渡片段', () => {
    const log: SegmentInfo[] = [];
    const times: number[] = [];
    const env: ActorEnv = {
      random: seeded(2),
      floor: new Floor({ bounds: SCREEN, scale: 1, floorDepth: 0.5 }),
      scale: 1,
      activityLevel: 'natural',
      addEffect: () => {
        throw new Error('soft 打断不该放特效');
      },
      observer: {
        segmentStarted: (_cat, seg, at) => {
          log.push(seg);
          times.push(at);
        },
      },
    };
    const actor = new CatActor(testCat('a'), testClips(), env, {
      x: 500,
      d: 0.5,
      facing: 'right',
      now: T0,
    });
    actor.interrupt(
      [{ kind: 'clip', name: 'idle-stand', holdMs: 60_000 }],
      { kind: 'idle' },
      'cut',
      T0,
    );
    const loopStart = at(times, -1);
    const loop = at(log, -1);
    actor.advance(T0, T0 + 700, false);
    actor.interrupt(
      [{ kind: 'clip', name: 'sleep', holdMs: 60_000 }],
      { kind: 'sleepCommand' },
      'soft',
      T0 + 700,
    );
    expect(actor.placement().clip).toBe('idle-stand');
    actor.advance(T0 + 700, T0 + 10_000, false);
    const next = log.findIndex((s, i) => i > log.indexOf(loop) && s.clip.name === 'stand-to-sit');
    expect(next).toBeGreaterThan(0);
    // 正好在第一遍播完时接上
    expect(at(times, next) - loopStart).toBeCloseTo(clipDurationMs(loop.clip) / loop.rate, 2);
    expect(
      log
        .slice(next)
        .map((s) => s.clip.name)
        .slice(0, 3),
    ).toEqual(['stand-to-sit', 'sit-to-sleep', 'sleep']);
  });

  it('用户触发的打断立刻切换，并在切换处放一个小特效', () => {
    const { stage, log } = setup();
    run(stage, T0, T0 + 5_017, 33);
    const t = T0 + 5_050;
    stage.handleCommand({ type: 'cat/sleep', cat: 'a' }, t);
    const frame = stage.update(t);
    const p = placementOf(frame);
    expect(['stand-to-sit', 'sit-to-sleep', 'sleep']).toContain(p.clip);
    expect(p.clipTimeMs).toBe(0);
    expect(frame.effects).toHaveLength(1);
    expect(frame.effects[0]).toMatchObject({ effect: 'cut', x: p.x, ageMs: 0 });
    expect(at(frame.effects, 0).y).toBeLessThan(p.y);
    expect(at(segmentsOf(log), -1).at).toBe(t);
    // 特效过一会儿就消失，id 不变
    const id = at(frame.effects, 0).id;
    expect(at(stage.update(t + CUT_EFFECT_MS / 2).effects, 0).id).toBe(id);
    expect(stage.update(t + CUT_EFFECT_MS).effects).toEqual([]);
  });

  it('播了一半以上的过渡片段，硬切时当作已经到了结束姿势', () => {
    const { stage, log } = setup();
    stage.handleCommand({ type: 'debug/playClip', cat: 'a', clip: 'stand-to-sit' }, T0);
    const transition = at(segmentsOf(log), -1);
    expect(transition.clip.name).toBe('stand-to-sit');
    const late = T0 + (0.7 * clipDurationMs(transition.clip)) / transition.rate;
    stage.update(late);
    stage.handleCommand({ type: 'cat/sleep', cat: 'a' }, late);
    expect(at(segmentsOf(log), -1).clip.name).toBe('sit-to-sleep');
  });
});

describe('命令', () => {
  it('召唤：立刻起身走到鼠标旁边，面朝鼠标等着', () => {
    const { stage, log } = setup({ settings: { floorDepth: 1 } });
    run(stage, T0, T0 + 3_000);
    const start = placementOf(stage.update(T0 + 3_000));
    const to = { x: start.x < 960 ? start.x + 300 : start.x - 300, y: 900 };
    stage.handleCommand({ type: 'cat/summon', cats: ['a'], to }, T0 + 3_000);
    expect(at(stage.debugReport(T0 + 3_000).cats, 0).behavior).toBe('被召唤过来');
    const frames = run(stage, T0 + 3_000, T0 + 20_000);
    const final = placementOf(at(frames, -1));
    expect(final.clip).toBe('idle-stand');
    expect(Math.abs(final.x - to.x)).toBeLessThan(300);
    expect(final.mirrored).toBe(final.x > to.x);
    // 距离不远，走过来
    expect(segmentsOf(log).some((s) => s.at >= T0 + 3_000 && s.clip.name === 'walk')).toBe(true);
  });

  it('召唤：离得远时跑过来；没有奔跑片段时降级成走过来', () => {
    for (const [omit, gait] of [
      [[], 'run'],
      [['run'], 'walk'],
    ] as const) {
      const { stage, log } = setup({ cats: [{ cat: testCat('a'), clips: testClips(omit) }] });
      const start = placementOf(stage.update(T0 + 100));
      const x = start.x < 960 ? 1800 : 100;
      stage.handleCommand({ type: 'cat/summon', cats: ['a'], to: { x, y: 1000 } }, T0 + 100);
      run(stage, T0 + 100, T0 + 60_000);
      const moves = segmentsOf(log).filter(
        (s) => s.at >= T0 + 100 && (s.clip.name === 'run' || s.clip.name === 'walk'),
      );
      expect(moves[0]?.clip.name).toBe(gait);
    }
  });

  it('召唤时没写目标，就走到最后一次看到鼠标的地方', () => {
    const { stage } = setup();
    stage.handlePointer({ type: 'move', x: 1500, y: 1000, cat: null }, T0 + 10);
    stage.handleCommand({ type: 'cat/summon', cats: ['a'] }, T0 + 20);
    const final = placementOf(at(run(stage, T0 + 20, T0 + 40_000), -1));
    expect(Math.abs(final.x - 1500)).toBeLessThan(300);
  });

  it('同时召唤几只猫，它们分开站在鼠标两边，不叠在一起', () => {
    const { stage } = setup({ cats: ['a', 'b', 'c'].map((id) => ({ cat: testCat(id) })) });
    stage.handleCommand({ type: 'cat/summon', cats: ['a', 'b', 'c'], to: { x: 960, y: 1000 } }, T0);
    // 每只猫走到以后、站着等的位置
    const arrived = new Map<string, number>();
    for (let t = T0 + 33; t < T0 + 20_000; t += 33) {
      stage.update(t);
      for (const c of stage.debugReport(t).cats) {
        if (c.behavior === '被召唤过来' && c.clip === 'idle-stand' && !arrived.has(c.cat)) {
          arrived.set(c.cat, c.x);
        }
      }
    }
    expect(arrived.size).toBe(3);
    const xs = [...arrived.values()].sort((x, y) => x - y);
    expect(xs[0]).toBeLessThan(960);
    expect(xs[2]).toBeGreaterThan(960);
    expect(at(xs, 1) - at(xs, 0)).toBeGreaterThan(150);
    expect(at(xs, 2) - at(xs, 1)).toBeGreaterThan(150);
  });

  it('让猫睡觉：起身的过渡片段都按姿势网络来，睡下后睡很久', () => {
    const { stage, log } = setup();
    stage.handleCommand({ type: 'cat/sleep', cat: 'a' }, T0 + 10);
    run(stage, T0 + 10, T0 + 5 * MIN, 100);
    const names = segmentsOf(log)
      .filter((s) => s.at >= T0 + 10)
      .map((s) => s.clip.name);
    expect(names).toEqual(['stand-to-sit', 'sit-to-sleep', 'sleep']);
    expect(stage.debugReport(T0 + 5 * MIN).cats[0]).toMatchObject({
      pose: 'sleep',
      behavior: '被叫去睡觉',
    });
  });

  it('已经在睡的猫再让它睡，不打断、不放特效', () => {
    const { stage } = setup();
    stage.handleCommand({ type: 'cat/sleep', cat: 'a' }, T0);
    run(stage, T0, T0 + MIN);
    stage.handleCommand({ type: 'cat/sleep', cat: 'a' }, T0 + MIN + 500);
    const frame = stage.update(T0 + MIN + 500);
    expect(frame.effects).toEqual([]);
    expect(placementOf(frame).clip).toBe('sleep');
  });

  it('调试台播放任意片段：能走到它的开始姿势就先播过渡片段', () => {
    const { stage, log } = setup();
    stage.handleCommand({ type: 'debug/playClip', cat: 'a', clip: 'sleep-to-sit' }, T0 + 10);
    expect(at(stage.debugReport(T0 + 10).cats, 0).behavior).toBe('调试：播放「sleep-to-sit」');
    run(stage, T0 + 10, T0 + 4_000, 10);
    expect(
      segmentsOf(log)
        .filter((s) => s.at >= T0 + 10)
        .map((s) => s.clip.name)
        .slice(0, 3),
    ).toEqual(['stand-to-sit', 'sit-to-sleep', 'sleep-to-sit']);
  });

  it('调试台播放任意片段：走不到它的开始姿势就硬切，播完再回到能待着的姿势', () => {
    const { stage, log } = setup();
    stage.handleCommand({ type: 'debug/playClip', cat: 'a', clip: 'dangle' }, T0 + 10);
    const frame = stage.update(T0 + 10);
    expect(placementOf(frame).clip).toBe('dangle');
    expect(frame.effects).toHaveLength(1);
    expect(at(segmentsOf(log), -1).cut).toBe(true);
    run(stage, T0 + 10, T0 + 30_000, 50);
    const after = segmentsOf(log).filter((s) => s.at > T0 + 10);
    expect(at(after, 0).clip.name).toBe('land');
  });

  it('调试台可以指定版本；没有的片段不理会', () => {
    const clips = [...testClips(), testClip('groom', { variant: 2 })];
    const { stage } = setup({ cats: [{ cat: testCat('a'), clips }] });
    stage.handleCommand({ type: 'debug/playClip', cat: 'a', clip: 'groom', variant: 2 }, T0 + 10);
    run(stage, T0 + 10, T0 + 2_000, 50);
    expect(placementOf(stage.update(T0 + 2_000))).toMatchObject({ clip: 'groom', variant: 2 });
    const before = stage.debugReport(T0 + 2_000);
    stage.handleCommand({ type: 'debug/playClip', cat: 'a', clip: 'no-such-clip' }, T0 + 2_000);
    stage.handleCommand({ type: 'debug/playClip', cat: 'nobody', clip: 'groom' }, T0 + 2_000);
    expect(stage.debugReport(T0 + 2_000)).toEqual(before);
  });
});

describe('行为和性格', () => {
  function stats(personality: Cat['personality'], level: Settings['activityLevel'] = 'natural') {
    const { stage, log } = setup({
      cats: [{ cat: testCat('a', { personality }) }],
      settings: { activityLevel: level },
    });
    run(stage, T0, T0 + 6 * HOUR, 500);
    const segments = segmentsOf(log);
    let sleepMs = 0;
    for (let i = 0; i + 1 < segments.length; i++) {
      if (at(segments, i).clip.name === 'sleep')
        sleepMs += at(segments, i + 1).at - at(segments, i).at;
    }
    return {
      walks: segments.filter((s) => s.clip.name === 'walk').length,
      segments: segments.length,
      sleepMs,
    };
  }

  it('性格不同，行为有可以测出来的差异', () => {
    const active = stats({ ...NEUTRAL, activity: 0.95 });
    const lazy = stats({ ...NEUTRAL, activity: 0.05 });
    expect(active.walks).toBeGreaterThan(2 * lazy.walks);
    expect(lazy.sleepMs).toBeGreaterThan(active.sleepMs);
  });

  it('活跃度越高，换得越勤', () => {
    const quiet = stats(NEUTRAL, 'quiet');
    const rowdy = stats(NEUTRAL, 'rowdy');
    expect(rowdy.segments).toBeGreaterThan(1.5 * quiet.segments);
  });

  it('没有为某一只猫写死行为：数据一样、id 不同的猫，表现完全一样', () => {
    const pack = (ids: string[]) =>
      ids.map((id, i) => ({
        cat: testCat(id, { name: `猫${i}`, personality: { ...NEUTRAL, activity: i / 2 } }),
      }));
    const a = setup({ cats: pack(['doudou', 'kubo', 'majiang']) });
    const b = setup({ cats: pack(['x', 'y', 'z']) });
    const strip = (frames: StageFrame[]) =>
      frames.map((f) => f.cats.map((c) => ({ ...c, cat: '' })));
    expect(strip(run(b.stage, T0, T0 + HOUR, 250))).toEqual(
      strip(run(a.stage, T0, T0 + HOUR, 250)),
    );
  });
});

describe('屏幕和设置变化', () => {
  it('屏幕变小时，位置按比例跟着变，猫不会跑到屏幕外面', () => {
    const cats = ['a', 'b', 'c'].map((id) => ({ cat: testCat(id) }));
    const { stage } = setup({ cats, bounds: { width: 3440, height: 1392 } });
    run(stage, T0, T0 + 2 * MIN, 100);
    const before = stage.update(T0 + 2 * MIN);
    const small = { width: 1536, height: 816 };
    stage.setBounds(small, T0 + 2 * MIN);
    const floor = new Floor({ bounds: small, scale: 1, floorDepth: 0.5 });
    const after = stage.update(T0 + 2 * MIN);
    for (const p of after.cats) {
      const old = defined(before.cats.find((c) => c.cat === p.cat));
      expect(p.x).toBeCloseTo(floor.clampX((old.x * 1536) / 3440, 1), 6);
      expect(p.y).toBeCloseTo(floor.yAt(old.depth), 6);
    }
    for (const frame of run(stage, T0 + 2 * MIN, T0 + 30 * MIN, 100)) {
      for (const p of frame.cats) {
        expect(p.x).toBeGreaterThanOrEqual(floor.xRange(1).min);
        expect(p.x).toBeLessThanOrEqual(floor.xRange(1).max);
        expect(p.y).toBeLessThanOrEqual(floor.nearY);
      }
    }
  });

  it('桌面层大小为 0 时不出现 NaN，恢复后照常', () => {
    const { stage } = setup();
    stage.setBounds({ width: 0, height: 0 }, T0 + 100);
    const frames = run(stage, T0 + 100, T0 + 5_000);
    stage.setBounds(SCREEN, T0 + 5_000);
    frames.push(...run(stage, T0 + 5_000, T0 + 60_000));
    for (const f of frames) {
      const p = placementOf(f);
      expect([p.x, p.y, p.scale, p.clipTimeMs].every(Number.isFinite)).toBe(true);
    }
  });

  it('改缩放和地板纵深后，地板和猫跟着调整', () => {
    const { stage } = setup();
    stage.applySnapshot(snapshot(['a'], { scale: 2, floorDepth: 1 }, 2), T0 + 100);
    const p = placementOf(stage.update(T0 + 100));
    const floor = new Floor({ bounds: SCREEN, scale: 2, floorDepth: 1 });
    expect(p.y).toBeCloseTo(floor.yAt(p.depth), 9);
    expect(p.scale).toBeCloseTo(2 * floor.depthScale(p.depth), 9);
  });

  it('显示和隐藏猫；过期的快照被丢掉；缺必需片段的猫不出现', () => {
    const { stage } = setup({
      cats: [
        { cat: testCat('a') },
        { cat: testCat('b') },
        { cat: testCat('broken'), clips: testClips(['sleep']) },
      ],
    });
    expect(
      stage
        .update(T0)
        .cats.map((c) => c.cat)
        .sort(),
    ).toEqual(['a', 'b']);
    stage.applySnapshot(snapshot(['b'], {}, 5), T0 + 10);
    expect(stage.update(T0 + 10).cats.map((c) => c.cat)).toEqual(['b']);
    stage.applySnapshot(snapshot(['a', 'b'], {}, 4), T0 + 20);
    expect(stage.update(T0 + 20).cats.map((c) => c.cat)).toEqual(['b']);
    stage.applySnapshot(snapshot(['a', 'b', 'nobody'], {}, 6), T0 + 30);
    expect(
      stage
        .update(T0 + 30)
        .cats.map((c) => c.cat)
        .sort(),
    ).toEqual(['a', 'b']);
  });
});

describe('隐藏后再恢复', () => {
  it('两次 update 之间隔了 3 小时：不会一下子补播很多片段，状态合理', () => {
    const { stage, log } = setup({ cats: ['a', 'b', 'c'].map((id) => ({ cat: testCat(id) })) });
    run(stage, T0, T0 + MIN, 33);
    const countBefore = log.length;
    const resume = T0 + MIN + 3 * HOUR;
    const frame = stage.update(resume);
    expect(log.length - countBefore).toBeLessThanOrEqual(3 * 6);
    const floor = new Floor({ bounds: SCREEN, scale: 1, floorDepth: 0.5 });
    for (const p of frame.cats) {
      expect(p.x).toBeGreaterThanOrEqual(floor.xRange(1).min);
      expect(p.x).toBeLessThanOrEqual(floor.xRange(1).max);
      // 刚选了新行为，从头开始播
      expect(at(segmentsOf(log, p.cat), -1).at).toBe(resume);
    }
    // 接着照常运行，姿势照样对得上
    run(stage, resume, resume + 10 * MIN, 50);
    for (const cat of ['a', 'b', 'c']) {
      const segments = segmentsOf(log, cat);
      for (let i = 1; i < segments.length; i++) {
        expect(at(segments, i).clip.fromPose).toBe(at(segments, i - 1).clip.toPose);
      }
    }
  });

  it('系统时间倒退时不会卡住', () => {
    const { stage } = setup();
    run(stage, T0, T0 + 10_000);
    const before = placementOf(stage.update(T0 + 10_000));
    stage.update(T0 - HOUR);
    const frames = run(stage, T0 - HOUR, T0 - HOUR + 60_000);
    expect(frames.some((f) => placementOf(f).clipTimeMs !== before.clipTimeMs)).toBe(true);
  });
});

describe('接口', () => {
  it('createStageCore 返回 StageCore；M1 的这一部分不产生事实', () => {
    const core = createStageCore({
      content: catalog([{ cat: testCat('a') }]),
      snapshot: snapshot(['a']),
      bounds: SCREEN,
      now: T0,
      random: seeded(1),
    });
    expect(core.update(T0 + 33).cats).toHaveLength(1);
    expect(core.drainFacts()).toEqual([]);
    expect(core.debugReport(T0 + 33).cats[0]).toMatchObject({ cat: 'a', pose: 'stand' });
  });
});
