import { describe, expect, it } from 'vitest';
import type { PointerInput } from '../../shared/core-api';
import type { Personality } from '../../shared/schemas';
import { CatActor, MAX_WALK_SLOPE, type ActorEnv } from './actor';
import { Floor } from './floor';
import { Stage } from './stage-core';
import { at, catalog, NEUTRAL, SCREEN, snapshot, testCat, testClips } from './test-fixtures';

const T0 = 1_800_000_000_000;

function setup(options: { personality?: Partial<Personality>; omit?: string[]; id?: string } = {}) {
  const id = options.id ?? 'test-cat';
  const stage = new Stage({
    content: catalog([
      {
        cat: testCat(id, { personality: { ...NEUTRAL, ...options.personality } }),
        clips: testClips(options.omit),
      },
    ]),
    snapshot: snapshot([id], { floorDepth: 1 }),
    bounds: SCREEN,
    now: T0,
    random: () => 0,
  });
  const p = at(stage.update(T0).cats, 0);
  const send = (input: PointerInput, ms: number) => {
    stage.handlePointer(input, T0 + ms);
  };
  const click = (ms: number) => {
    send({ type: 'down', x: p.x, y: p.y - 50, cat: id }, ms);
    send({ type: 'up', x: p.x, y: p.y - 50 }, ms + 1);
  };
  const simulate = (interaction: 'poke' | 'pet' | 'pickUp' | 'drop', ms = 0) => {
    stage.handleCommand({ type: 'debug/simulate', cat: id, interaction }, T0 + ms);
  };
  return { stage, id, p, send, click, simulate };
}

function placement(stage: Stage, ms: number) {
  return at(stage.update(T0 + ms).cats, 0);
}

describe('单击互动', () => {
  it.each([
    { omit: [], clip: 'poked' },
    { omit: ['poked'], clip: 'meow' },
    { omit: ['poked', 'meow'], clip: 'idle-stand' },
  ])('被戳片段缺失时逐级降级，不丢掉事实：$clip', ({ omit, clip }) => {
    const { stage, click } = setup({ omit });
    click(100);
    const frame = stage.update(T0 + 101);
    expect(at(frame.cats, 0).clip).toBe(clip);
    expect(frame.bubbles).toHaveLength(1);
    expect(stage.drainFacts()).toEqual([{ type: 'cat/poked', cat: 'test-cat', at: T0 + 101 }]);
    expect(stage.drainFacts()).toEqual([]);
  });

  it('按耐心决定连续戳几次走开，黏人程度也改变反应气泡', () => {
    const impatient = setup({ personality: { patience: 0, clinginess: 0 } });
    const patient = setup({ personality: { patience: 1, clinginess: 1 } });
    for (const ms of [0, 100, 200]) {
      impatient.click(ms);
      patient.click(ms);
    }
    const a = impatient.stage.update(T0 + 201);
    const b = patient.stage.update(T0 + 201);
    expect(at(impatient.stage.debugReport(T0 + 201).cats, 0).behavior).toBe('走开');
    expect(at(b.cats, 0).clip).toBe('poked');
    expect(at(a.bubbles, 0).text).not.toBe(at(b.bubbles, 0).text);
    expect(placement(impatient.stage, 1301).x).toBeGreaterThan(at(a.cats, 0).x);
  });

  it('零散点击不累计为短时间连戳，松手丢失也不误算单击', () => {
    const { stage, click, send, p, id } = setup({ personality: { patience: 0 } });
    for (const ms of [0, 2100, 4200]) click(ms);
    expect(placement(stage, 4201).clip).toBe('poked');
    stage.drainFacts();
    send({ type: 'down', x: p.x, y: p.y, cat: id }, 4300);
    send({ type: 'cancel' }, 4400);
    expect(stage.drainFacts()).toEqual([]);
  });
});

describe('撸猫轨迹', () => {
  it('1.5 秒内刚好三次完整来回划就开始呼噜，离开时只交一次准确时长', () => {
    const { stage, send, p, id } = setup();
    send({ type: 'move', x: p.x, y: p.y - 50, cat: id }, 0);
    send({ type: 'move', x: p.x + 30, y: p.y - 50, cat: id }, 500);
    send({ type: 'move', x: p.x, y: p.y - 50, cat: id }, 1000);
    expect(placement(stage, 1000).clip).not.toBe('purr');
    send({ type: 'move', x: p.x + 30, y: p.y - 50, cat: id }, 1500);
    const frame = stage.update(T0 + 1500);
    expect(at(frame.cats, 0).clip).toBe('purr');
    expect(frame.effects.some((e) => e.effect === 'hearts')).toBe(true);
    expect(stage.drainFacts()).toEqual([]);
    send({ type: 'move', x: 1000, y: 0, cat: null }, 1800);
    expect(stage.drainFacts()).toEqual([
      { type: 'cat/petted', cat: id, at: T0 + 1800, durationMs: 300 },
    ]);
    stage.update(T0 + 5000);
    expect(stage.drainFacts()).toEqual([]);
  });

  it.each([1500, 1501])('三划完成时间间隔 %i 毫秒：窗口包含边界、排除超时', (span) => {
    const { stage, send, p, id } = setup();
    for (const [ms, dx] of [
      [0, 0],
      [1, 30],
      [751, 0],
      [span + 1, 30],
    ] as const) {
      send({ type: 'move', x: p.x + dx, y: p.y - 50, cat: id }, ms);
    }
    expect(placement(stage, span + 1).clip === 'purr').toBe(span === 1500);
  });

  it('抖动、同向滑动、离开后再回来不拼成三次来回划', () => {
    const { stage, send, p, id } = setup();
    for (let i = 0; i < 20; i++) send({ type: 'move', x: p.x + (i % 2), y: p.y, cat: id }, i * 10);
    for (let i = 0; i < 5; i++)
      send({ type: 'move', x: p.x + i * 30, y: p.y, cat: id }, 200 + i * 50);
    expect(placement(stage, 400).clip).not.toBe('purr');
    send({ type: 'move', x: p.x, y: p.y, cat: id }, 450);
    send({ type: 'move', x: 0, y: 0, cat: null }, 500);
    send({ type: 'move', x: p.x + 30, y: p.y, cat: id }, 550);
    send({ type: 'move', x: p.x, y: p.y, cat: id }, 600);
    expect(placement(stage, 600).clip).not.toBe('purr');
  });

  it('停下鼠标后结束撸猫；时间跳过很久也只算到最后移动后的截止时刻', () => {
    const { stage, send, p, id } = setup();
    for (const [ms, dx] of [
      [0, 0],
      [100, 30],
      [200, 0],
      [300, 30],
    ] as const)
      send({ type: 'move', x: p.x + dx, y: p.y, cat: id }, ms);
    stage.update(T0 + 10_000);
    expect(stage.drainFacts()).toEqual([
      { type: 'cat/petted', cat: id, at: T0 + 900, durationMs: 600 },
    ]);
    expect(placement(stage, 10_001).clip).not.toBe('purr');
  });

  it('耐心决定呼噜最长时长，超时后走开；缺呼噜片段只停用撸猫', () => {
    const impatient = setup({ personality: { patience: 0 } });
    const patient = setup({ personality: { patience: 1 } });
    impatient.simulate('pet');
    patient.simulate('pet');
    expect(placement(impatient.stage, 2000).clip).toBe('sit-to-stand');
    expect(at(impatient.stage.debugReport(T0 + 2000).cats, 0).behavior).toBe('走开');
    expect(placement(patient.stage, 2000).clip).toBe('purr');
    expect(impatient.stage.drainFacts()).toEqual([
      { type: 'cat/petted', cat: impatient.id, at: T0 + 2000, durationMs: 2000 },
    ]);
    expect(patient.stage.drainFacts()).toEqual([]);
    const missing = setup({ omit: ['purr'] });
    missing.simulate('pet');
    missing.click(100);
    expect(missing.stage.drainFacts().map((f) => f.type)).toEqual(['cat/poked']);
  });

  it('持续撸猫跨过循环仍保持呼噜和爱心，换命令结束并发事实', () => {
    const { stage, simulate } = setup();
    simulate('pet');
    const frame = stage.update(T0 + 3000);
    expect(at(frame.cats, 0).clip).toBe('purr');
    expect(frame.effects.some((e) => e.effect === 'hearts')).toBe(true);
    stage.handleCommand({ type: 'cat/sleep', cat: 'test-cat' }, T0 + 3000);
    expect(stage.drainFacts()).toEqual([
      { type: 'cat/petted', cat: 'test-cat', at: T0 + 3000, durationMs: 3000 },
    ]);
    expect(placement(stage, 10_000).clip).toBe('sleep');
  });
});

describe('拎起放下', () => {
  it('睡觉中开始拖动立刻悬空，抓取点不跳位，按下本身不拎起', () => {
    const { stage, send, p, id } = setup();
    stage.handleCommand({ type: 'cat/sleep', cat: id }, T0);
    placement(stage, 3000);
    send({ type: 'down', x: p.x, y: p.y - 50, cat: id }, 3100);
    expect(placement(stage, 3100).clip).toBe('sleep');
    send({ type: 'move', x: p.x + 50, y: p.y - 150, cat: null }, 3200);
    const held = placement(stage, 3200);
    expect(held).toMatchObject({ clip: 'dangle', pose: 'dangle', x: p.x + 50, y: p.y - 100 });
    expect(stage.drainFacts()).toEqual([{ type: 'cat/pickedUp', cat: id, at: T0 + 3200 }]);
    expect(placement(stage, 30_000).clip).toBe('dangle');
  });

  it('拖动移出屏幕仍夹在合法范围，丢失松手的 cancel 放下且不重复事实', () => {
    const { stage, send, simulate } = setup();
    simulate('pickUp');
    send({ type: 'move', x: -500, y: -500, cat: null }, 100);
    expect(placement(stage, 100)).toMatchObject({ x: 90, y: 0, clip: 'dangle' });
    send({ type: 'move', x: 5000, y: -100, cat: null }, 200);
    expect(placement(stage, 200).x).toBe(1830);
    send({ type: 'cancel' }, 300);
    expect(placement(stage, 300).clip).toBe('fall');
    send({ type: 'cancel' }, 301);
    expect(stage.drainFacts().map((f) => f.type)).toEqual(['cat/pickedUp', 'cat/dropped']);
    expect(placement(stage, 5000)).toMatchObject({ pose: 'stand', x: 1830 });
  });

  it('下落位置按真实时间计算，帧率、松手前速度不改变轨迹，落地后回站姿', () => {
    const a = setup();
    const b = setup();
    for (const s of [a, b]) {
      s.simulate('pickUp');
      s.simulate('drop', 100);
    }
    const released = placement(a.stage, 100);
    for (let t = 110; t <= 300; t += 10) placement(a.stage, t);
    const smallSteps = placement(a.stage, 300);
    const oneStep = placement(b.stage, 300);
    expect(smallSteps).toEqual(oneStep);
    expect(oneStep.x).toBe(released.x);
    expect(oneStep.y).toBeGreaterThan(released.y);
    expect(oneStep.clip).toBe('fall');
    expect(placement(a.stage, 2000)).toMatchObject({ pose: 'stand', clip: 'idle-stand' });
    expect(placement(a.stage, 2000).y).toBe(a.p.y);
  });

  it('松手位置用于最后一次定位；放在地板下方只落地，不甩飞', () => {
    const { stage, simulate, send, p } = setup();
    simulate('pickUp');
    send({ type: 'up', x: 800, y: 5000 }, 100);
    expect(placement(stage, 100)).toMatchObject({ x: 800, y: p.y, clip: 'land' });
    expect(placement(stage, 1500).x).toBe(800);
  });

  it('快速和慢速拖动在同一处松手，得到同一条下落轨迹', () => {
    const a = setup();
    const b = setup();
    a.simulate('pickUp');
    b.simulate('pickUp');
    a.send({ type: 'move', x: 100, y: 0, cat: null }, 99);
    b.send({ type: 'move', x: 699, y: 299, cat: null }, 20);
    for (const s of [a, b]) s.send({ type: 'up', x: 700, y: 300 }, 100);
    expect(placement(a.stage, 300)).toEqual(placement(b.stage, 300));
    expect(placement(a.stage, 300).x).toBe(700);
  });

  it('冷却到期后允许再次响应靠近', () => {
    const { stage, send, p } = setup({ personality: { clinginess: 1, initiative: 1 } });
    send({ type: 'move', x: p.x + 250, y: p.y - 50, cat: null }, 0);
    const next = placement(stage, 5000);
    send({ type: 'move', x: next.x + 250, y: next.y - 50, cat: null }, 5000);
    expect(at(stage.debugReport(T0 + 5000).cats, 0).behavior).toBe('凑近鼠标');
    expect(placement(stage, 5000).clipTimeMs).toBe(0);
  });

  it.each(['dangle', 'land'])('缺 %s 时不能拎起，其他互动照常', (clip) => {
    const { stage, simulate, click } = setup({ omit: [clip] });
    simulate('pickUp');
    simulate('drop');
    click(100);
    expect(stage.drainFacts().map((f) => f.type)).toEqual(['cat/poked']);
  });

  it('没有 fall 时用悬空片段下落，也照常落地', () => {
    const { stage, simulate } = setup({ omit: ['fall'] });
    simulate('pickUp');
    simulate('drop', 100);
    expect(placement(stage, 200).clip).toBe('dangle');
    expect(placement(stage, 2000).pose).toBe('stand');
  });
});

describe('靠近、幽灵模式和生命周期', () => {
  it('黏人且主动会凑过来，不黏人会躲开，黏人但被动就待着；冷却期间不重新打断', () => {
    for (const [personality, behavior] of [
      [{ clinginess: 1, initiative: 1 }, '凑近鼠标'],
      [{ clinginess: 0, initiative: 1 }, '走开'],
      [{ clinginess: 1, initiative: 0 }, '待着'],
    ] as const) {
      const { stage, send, p } = setup({ personality });
      send({ type: 'move', x: p.x + 250, y: p.y - 50, cat: null }, 0);
      expect(at(stage.debugReport(T0).cats, 0).behavior).toBe(behavior);
      const first = placement(stage, 100);
      send({ type: 'move', x: p.x + 200, y: p.y - 50, cat: null }, 100);
      expect(placement(stage, 100).clipTimeMs).toBe(first.clipTimeMs);
      if (behavior === '凑近鼠标') expect(first.x).toBeGreaterThan(p.x);
      if (behavior === '走开') {
        // 猫贴着左边时，向右侧可走的地板让开。
        expect(first.x).toBeGreaterThan(p.x);
      }
    }
  });

  it('幽灵模式不接受新互动和靠近，结束后恢复；已有拖动仍跟随并正常放下', () => {
    const { stage, simulate, send, p, click } = setup();
    stage.setGhostMode(true, T0);
    click(10);
    simulate('pet', 20);
    simulate('pickUp', 30);
    send({ type: 'move', x: p.x + 250, y: p.y - 50, cat: null }, 40);
    expect(placement(stage, 40).clip).toBe('idle-stand');
    expect(stage.drainFacts()).toEqual([]);
    stage.setGhostMode(false, T0 + 50);
    simulate('pickUp', 60);
    stage.setGhostMode(true, T0 + 70);
    expect(placement(stage, 70).clip).toBe('dangle');
    send({ type: 'move', x: 700, y: 300, cat: null }, 80);
    expect(placement(stage, 80)).toMatchObject({ x: 700, y: 300 });
    send({ type: 'up', x: 700, y: 300 }, 90);
    expect(stage.drainFacts().map((f) => f.type)).toEqual(['cat/pickedUp', 'cat/dropped']);
    expect(placement(stage, 3000).pose).toBe('stand');
  });

  it('幽灵模式结束已有撸猫，不把按 Ctrl 前的轨迹带到结束以后', () => {
    const { stage, simulate } = setup();
    simulate('pet');
    stage.setGhostMode(true, T0 + 100);
    expect(stage.drainFacts()).toEqual([
      { type: 'cat/petted', cat: 'test-cat', at: T0 + 100, durationMs: 100 },
    ]);
    stage.setGhostMode(false, T0 + 200);
    expect(placement(stage, 3000).clip).not.toBe('purr');
  });

  it('拎起期间召唤、睡觉和播放调试片段不丢掉猫的悬空状态', () => {
    const { stage, simulate } = setup();
    simulate('pickUp');
    stage.handleCommand({ type: 'cat/summon', cats: ['test-cat'] }, T0 + 10);
    stage.handleCommand({ type: 'cat/sleep', cat: 'test-cat' }, T0 + 20);
    stage.handleCommand({ type: 'debug/playClip', cat: 'test-cat', clip: 'groom' }, T0 + 30);
    expect(placement(stage, 1000).clip).toBe('dangle');
    simulate('drop', 1100);
    expect(stage.drainFacts().map((f) => f.type)).toEqual(['cat/pickedUp', 'cat/dropped']);
  });

  it('隐藏互动中的猫清理互动；重新显示不会继承拖动或撸猫', () => {
    for (const interaction of ['pet', 'pickUp'] as const) {
      const { stage, simulate, id } = setup();
      simulate(interaction);
      stage.drainFacts();
      stage.applySnapshot(snapshot([], { floorDepth: 1 }, 2), T0 + 100);
      expect(stage.update(T0 + 100).cats).toEqual([]);
      expect(stage.drainFacts().map((f) => f.type)).toEqual([
        interaction === 'pet' ? 'cat/petted' : 'cat/dropped',
      ]);
      stage.applySnapshot(snapshot([id], { floorDepth: 1 }, 3), T0 + 200);
      expect(placement(stage, 200).clip).toBe('idle-stand');
    }
  });

  it('系统时间倒退后撸猫仍按真实经过时长结束；换猫 id 不改变互动结果', () => {
    const a = setup({ id: 'doudou' });
    const b = setup({ id: 'another-cat' });
    for (const s of [a, b]) {
      s.simulate('pet');
      s.stage.update(T0 - 10000);
      s.stage.update(T0 - 3000);
    }
    expect(a.stage.drainFacts().map((f) => ({ ...f, cat: '' }))).toEqual(
      b.stage.drainFacts().map((f) => ({ ...f, cat: '' })),
    );
    expect(placement(a.stage, -3000).clip).toBe('sit-to-stand');
    expect(a.stage.drainFacts()).toEqual([]);
    expect(placement(a.stage, -1900).x).toBeGreaterThan(a.p.x);
  });
});

describe('放大猫后的斜走连续性（#23 复查回归）', () => {
  it('确实收回越界位置后，下一帧 x、纵深和 y 从收回的位置接着走，坡度仍受限', () => {
    const env: ActorEnv = {
      random: () => 0.5,
      floor: new Floor({ bounds: SCREEN, scale: 1, floorDepth: 1 }),
      scale: 1,
      activityLevel: 'natural',
      addEffect: () => undefined,
    };
    const actor = new CatActor(testCat('a'), testClips(), env, {
      x: 120,
      d: 0.1,
      facing: 'right',
      now: T0,
    });
    actor.interrupt(
      [{ kind: 'move', gait: 'walk', x: 1600, d: 0.9 }],
      { kind: 'summon' },
      'cut',
      T0,
    );
    actor.advance(T0, T0 + 300, false);
    const before = actor.placement();
    env.scale = 2;
    env.floor = new Floor({ bounds: SCREEN, scale: 2, floorDepth: 1 });
    expect(before.x).toBeLessThan(env.floor.xRange(1).min);
    actor.clampToFloor();
    const clamped = actor.placement();
    expect(clamped.x).toBe(env.floor.xRange(1).min);
    expect(clamped.depth).toBe(before.depth);
    actor.advance(T0 + 300, T0 + 301, false);
    const next = actor.placement();
    expect(next.x - clamped.x).toBeGreaterThan(0);
    expect(next.x - clamped.x).toBeLessThan(0.2);
    expect(Math.abs(next.depth - clamped.depth)).toBeLessThan(0.001);
    expect(Math.abs(next.y - clamped.y)).toBeLessThanOrEqual(
      MAX_WALK_SLOPE * Math.abs(next.x - clamped.x) + 1e-9,
    );
  });
});
