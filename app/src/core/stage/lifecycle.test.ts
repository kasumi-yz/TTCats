import { describe, expect, it } from 'vitest';
import type { CatPlacement, StageBounds } from '../../shared/core-api';
import type { StateSnapshot } from '../../shared/ipc';
import { zh } from '../../shared/strings.zh-CN';
import { Stage } from './stage-core';
import { at, catalog, NEUTRAL, SCREEN, snapshot, testCat, testClips } from './test-fixtures';

const labels = zh.stageLifecycle;
const ids = ['quiet', 'active', 'middle'];
const entries = ids.map((id, i) => ({
  cat: testCat(id, { personality: { ...NEUTRAL, activity: [0.1, 0.9, 0.5][i] ?? 0 } }),
}));

function setup(
  options: { bounds?: StageBounds; scale?: number; dnd?: boolean; equal?: boolean } = {},
) {
  const changes = { scale: options.scale ?? 1, floorDepth: 1 };
  const state = (visible = ids, revision = 1, dnd = options.dnd ?? false): StateSnapshot => ({
    ...snapshot(visible, changes, revision),
    doNotDisturb: dnd ? { mode: 'untilOff' } : { mode: 'off' },
  });
  const starts: { cat: string; clip: string; at: number }[] = [];
  const stage = new Stage({
    content: catalog(options.equal ? ids.map((id) => ({ cat: testCat(id) })) : entries),
    snapshot: state(),
    bounds: options.bounds ?? SCREEN,
    now: 0,
    random: () => 0.5,
    observer: {
      segmentStarted: (cat, segment, at) => starts.push({ cat, clip: segment.clip.name, at }),
    },
  });
  return { stage, state, starts };
}

function cat(stage: Stage, now: number, id = at(ids, 0)) {
  return at(
    stage.update(now).cats.filter((p) => p.cat === id),
    0,
  );
}

function run(stage: Stage, from: number, to: number, step = 50) {
  for (let t = from + step; t < to; t += step) stage.update(t);
  return stage.update(to);
}

function fullyOutside(p: CatPlacement, width: number) {
  // 测试素材宽 256，落脚锚点在横向正中；验证画面整体离屏，不能只看锚点。
  return p.x + 128 * p.scale < 0 || p.x - 128 * p.scale > width;
}

describe('入场与出场（#59）', () => {
  it.each([false, true])('按活跃参数排队，同活跃度按显示顺序（相同：%s）', (equal) => {
    const { stage, starts } = setup({ equal });
    expect(stage.update(0).cats.every((p) => fullyOutside(p, SCREEN.width))).toBe(true);
    run(stage, 0, 4000);
    const walks = starts.filter((s) => s.clip === 'walk');
    expect(walks.map((s) => s.cat)).toEqual(equal ? ids : ['active', 'middle', 'quiet']);
    expect(walks.map((s) => s.at)).toEqual([0, 1500, 3000]);
    const arrived = run(stage, 4000, 60_000).cats;
    expect(arrived.every((p) => p.x > 0 && p.x < SCREEN.width)).toBe(true);
    expect(stage.debugReport(60_000).cats.every((p) => p.behavior !== labels.entrance)).toBe(true);
    expect(new Set(arrived.map((p) => p.x)).size).toBe(3);
  });

  it('隐藏后走到最近一侧，整幅画面离屏以后才从输出中移除', () => {
    const { stage, state } = setup();
    run(stage, 0, 60_000);
    const before = cat(stage, 60_000);
    stage.applySnapshot(state(ids.slice(1), 2), 60_000);
    expect(cat(stage, 60_000).x).toBe(before.x);
    expect(stage.debugReport(60_000).cats.find((c) => c.cat === ids[0])?.behavior).toBe(
      labels.exit,
    );
    let last = before;
    let removed = false;
    let moved = false;
    for (let t = 60_050; t <= 120_000; t += 50) {
      const p = stage.update(t).cats.find((p) => p.cat === ids[0]);
      if (p === undefined) {
        expect(fullyOutside(last, SCREEN.width)).toBe(true);
        removed = true;
        break;
      }
      if (p.x !== last.x) {
        expect(Math.sign(p.x - last.x)).toBe(before.x < SCREEN.width / 2 ? -1 : 1);
        moved = true;
      }
      last = p;
    }
    expect(moved && removed).toBe(true);
  });

  it('出场途中重新显示，从当前位置掉头回来，不瞬移也不重复创建', () => {
    const { stage, state } = setup();
    run(stage, 0, 60_000);
    stage.applySnapshot(state(ids.slice(1), 2), 60_000);
    run(stage, 60_000, 63_000);
    const mid = cat(stage, 63_000);
    stage.applySnapshot(state(ids, 3), 63_000);
    expect(cat(stage, 63_000).x).toBe(mid.x);
    expect(stage.debugReport(63_000).cats.find((c) => c.cat === ids[0])?.behavior).toBe(
      labels.entrance,
    );
    expect(cat(stage, 63_500).x).toBeGreaterThan(mid.x);
    expect(run(stage, 63_500, 120_000).cats).toHaveLength(3);
  });

  it.each(['pickUp', 'drop'] as const)(
    '在%s时隐藏，先下落并播完落地，再出场；不重复产生放下事实',
    (interaction) => {
      const { stage, state, starts } = setup();
      run(stage, 0, 60_000);
      stage.handleCommand(
        { type: 'debug/simulate', cat: at(ids, 0), interaction: 'pickUp' },
        60_000,
      );
      if (interaction === 'drop')
        stage.handleCommand(
          { type: 'debug/simulate', cat: at(ids, 0), interaction: 'drop' },
          60_100,
        );
      const held = cat(stage, 60_100);
      stage.applySnapshot(state(ids.slice(1), 2), 60_100);
      expect(cat(stage, 60_100).y).toBe(held.y);
      expect(cat(stage, 60_100).clip).toBe('fall');
      const final = run(stage, 60_100, 120_000);
      expect(final.cats.some((p) => p.cat === ids[0])).toBe(false);
      const clips = starts.filter((s) => s.cat === ids[0] && s.at >= 60_100);
      expect(clips.findIndex((s) => s.clip === 'land')).toBeLessThan(
        clips.findIndex((s) => s.clip === 'walk'),
      );
      expect(stage.drainFacts().filter((f) => f.type === 'cat/dropped')).toHaveLength(1);
    },
  );

  it('下落时又显示，先落地再回到屏内', () => {
    const { stage, state } = setup();
    run(stage, 0, 60_000);
    stage.handleCommand({ type: 'debug/simulate', cat: at(ids, 0), interaction: 'pickUp' }, 60_000);
    stage.applySnapshot(state(ids.slice(1), 2), 60_010);
    stage.applySnapshot(state(ids, 3), 60_020);
    expect(cat(stage, 60_020).clip).toBe('fall');
    expect(run(stage, 60_020, 120_000).cats).toHaveLength(3);
  });

  it('召唤正在等待入场的猫立即改道；已经隐藏、正在出场的猫不响应命令或鼠标', () => {
    const { stage, state } = setup();
    stage.handleCommand({ type: 'cat/summon', cats: [at(ids, 0)], to: { x: 1500, y: 1000 } }, 0);
    expect(stage.debugReport(0).cats.find((c) => c.cat === ids[0])?.behavior).toBe('被召唤过来');
    const outside = cat(stage, 0).x;
    expect(cat(stage, 100).x).toBeGreaterThan(outside);
    let arrived = false;
    for (let t = 100; t < 30_000; t += 100) {
      const p = cat(stage, t);
      if (
        p.clip === 'idle-stand' &&
        stage.debugReport(t).cats.find((c) => c.cat === ids[0])?.behavior === '被召唤过来'
      ) {
        expect(p.x).toBeGreaterThan(1200);
        arrived = true;
        break;
      }
    }
    expect(arrived).toBe(true);
    run(stage, 30_000, 60_000);
    stage.applySnapshot(state(ids.slice(1), 2), 60_000);
    const before = stage.debugReport(60_000);
    stage.handleCommand({ type: 'cat/summon', cats: [at(ids, 0)], to: { x: 0, y: 0 } }, 60_000);
    stage.handleCommand({ type: 'debug/simulate', cat: at(ids, 0), interaction: 'pickUp' }, 60_000);
    const p = cat(stage, 60_000);
    stage.handlePointer({ type: 'down', cat: at(ids, 0), x: p.x, y: p.y }, 60_000);
    stage.handlePointer({ type: 'up', x: p.x, y: p.y }, 60_000);
    expect(stage.debugReport(60_000)).toEqual(before);
    expect(stage.drainFacts()).toEqual([]);
  });

  it('重新入场只重置显示中的猫，清理拎起和撸猫；长暂停后不补播历史行为', () => {
    const { stage, state, starts } = setup();
    run(stage, 0, 60_000);
    stage.applySnapshot(state(ids.slice(1), 2), 60_000);
    stage.handleCommand({ type: 'debug/simulate', cat: at(ids, 1), interaction: 'pickUp' }, 60_000);
    stage.handleCommand({ type: 'cat/entrance' }, 60_000);
    expect(
      stage
        .update(60_000)
        .cats.filter((p) => p.cat !== ids[0])
        .every((p) => fullyOutside(p, SCREEN.width)),
    ).toBe(true);
    const count = starts.length;
    const frame = stage.update(3 * 60 * 60_000);
    expect(frame.cats.map((p) => p.cat).sort()).toEqual(ids.slice(1).sort());
    expect(frame.cats.every((p) => p.x > 0 && p.x < SCREEN.width)).toBe(true);
    expect(starts.length - count).toBeLessThan(20);
    expect(stage.drainFacts().filter((f) => f.type === 'cat/dropped')).toHaveLength(1);
  });
});

describe('勿扰模式', () => {
  it.each([false, true])('进入勿扰后聚到同一侧排开睡觉；启动时已开启：%s', (dnd) => {
    const { stage, state } = setup({ dnd });
    if (!dnd) {
      run(stage, 0, 60_000);
      stage.applySnapshot(state(ids, 2, true), 60_000);
    }
    const from = dnd ? 0 : 60_000;
    let sawCorner = false;
    for (let t = from; t <= 180_000; t += 100) {
      stage.update(t);
      sawCorner ||= stage.debugReport(t).cats.some((c) => c.behavior === labels.goToCorner);
    }
    expect(sawCorner).toBe(true);
    const asleep = stage.debugReport(180_000).cats;
    expect(asleep.every((c) => c.behavior === labels.doNotDisturbSleep && c.pose === 'sleep')).toBe(
      true,
    );
    const xs = asleep.map((c) => c.x).sort((a, b) => a - b);
    expect(at(xs, 2) < SCREEN.width / 2 || at(xs, 0) > SCREEN.width / 2).toBe(true);
    expect(at(xs, 1) - at(xs, 0)).toBeGreaterThan(100);
    expect(at(xs, 2) - at(xs, 1)).toBeGreaterThan(100);
    const before = stage.update(180_000).cats;
    const after = stage.update(24 * 60 * 60_000).cats;
    expect(after.map((p) => p.x)).toEqual(before.map((p) => p.x));
    expect(after.every((p) => p.pose === 'sleep')).toBe(true);
  });

  it.each(['poke', 'pet', 'pickUp', 'summon'] as const)(
    '勿扰期间%s仍有效，结束后回角落；单纯靠近不反应',
    (interaction) => {
      const { stage } = setup({ dnd: true });
      run(stage, 0, 120_000);
      const p = cat(stage, 120_000);
      stage.handlePointer({ type: 'move', cat: null, x: p.x + 100, y: p.y - 50 }, 120_000);
      run(stage, 120_000, 122_000);
      expect(
        stage.debugReport(122_000).cats.every((c) => c.behavior === labels.doNotDisturbSleep),
      ).toBe(true);
      if (interaction === 'summon')
        stage.handleCommand(
          { type: 'cat/summon', cats: [at(ids, 0)], to: { x: 1700, y: 1000 } },
          122_000,
        );
      else stage.handleCommand({ type: 'debug/simulate', cat: at(ids, 0), interaction }, 122_000);
      expect(stage.debugReport(122_000).cats.find((c) => c.cat === ids[0])?.behavior).not.toBe(
        labels.doNotDisturbSleep,
      );
      if (interaction === 'pickUp') {
        stage.handleCommand(
          { type: 'debug/simulate', cat: at(ids, 0), interaction: 'drop' },
          124_000,
        );
      }
      run(stage, 124_000, 240_000);
      expect(
        stage.debugReport(240_000).cats.every((c) => c.behavior === labels.doNotDisturbSleep),
      ).toBe(true);
      expect(Math.abs(cat(stage, 240_000).x - p.x)).toBeLessThan(150);
      if (interaction !== 'summon') expect(stage.drainFacts().length).toBeGreaterThan(0);
    },
  );

  it('勿扰结束后先醒来，再恢复自主行为；勿扰中新显示和重新入场的猫仍回角落', () => {
    const { stage, state, starts } = setup({ dnd: true });
    run(stage, 0, 120_000);
    stage.applySnapshot(state(ids.slice(1), 2, true), 120_000);
    stage.update(180_000);
    stage.applySnapshot(state(ids, 3, true), 180_000);
    stage.handleCommand({ type: 'cat/entrance' }, 180_000);
    run(stage, 180_000, 300_000);
    expect(
      stage.debugReport(300_000).cats.every((c) => c.behavior === labels.doNotDisturbSleep),
    ).toBe(true);
    stage.applySnapshot(state(ids, 4, false), 300_000);
    run(stage, 300_000, 305_000);
    for (const id of ids)
      expect(starts.filter((s) => s.cat === id && s.at >= 300_000).map((s) => s.clip)).toEqual(
        expect.arrayContaining(['sleep-to-sit', 'sit-to-stand']),
      );
    expect(
      stage.debugReport(305_000).cats.every((c) => c.behavior !== labels.doNotDisturbSleep),
    ).toBe(true);
  });
});

describe('模拟屏幕与时间', () => {
  it('排队和走路中更改屏幕、猫大小，快照不会把入场猫吸到屏内，之后仍能完成入场', () => {
    const { stage, state } = setup();
    stage.update(500);
    stage.setBounds({ width: 1536, height: 816 }, 500);
    stage.applySnapshot({ ...state(ids, 2), settings: { ...state().settings, scale: 2 } }, 500);
    const waiting = cat(stage, 500);
    expect(fullyOutside(waiting, 1536)).toBe(true);
    const current = stage.update(500).cats;
    stage.applySnapshot({ ...state(ids, 3), settings: { ...state().settings, scale: 2 } }, 500);
    expect(stage.update(500).cats).toEqual(current);
    const arrived = run(stage, 500, 120_000).cats;
    expect(arrived.every((p) => p.x > 0 && p.x < 1536)).toBe(true);
  });

  it('出场中缩小屏幕并放大猫，仍要等整幅画面离屏才能移除', () => {
    const { stage, state } = setup();
    run(stage, 0, 60_000);
    stage.applySnapshot(state([], 2), 60_000);
    run(stage, 60_000, 62_000);
    stage.setBounds({ width: 960, height: 540 }, 62_000);
    stage.applySnapshot({ ...state([], 3), settings: { ...state([]).settings, scale: 2 } }, 62_000);
    let last = stage.update(62_000).cats;
    for (let t = 62_020; t <= 120_000; t += 20) {
      const next = stage.update(t).cats;
      for (const p of last) {
        if (!next.some((c) => c.cat === p.cat)) expect(fullyOutside(p, 960)).toBe(true);
      }
      last = next;
    }
    expect(last).toEqual([]);
  });

  it('勿扰开启时，被叫去长睡的猫仍去角落；已经拎起的猫等放手后再去', () => {
    const { stage, state } = setup();
    run(stage, 0, 60_000);
    stage.handleCommand({ type: 'cat/sleep', cat: at(ids, 0) }, 60_000);
    run(stage, 60_000, 64_000);
    stage.handleCommand({ type: 'debug/simulate', cat: at(ids, 1), interaction: 'pickUp' }, 64_000);
    stage.applySnapshot(state(ids, 2, true), 64_000);
    run(stage, 64_000, 180_000);
    expect(stage.debugReport(180_000).cats.find((c) => c.cat === ids[0])?.behavior).toBe(
      labels.doNotDisturbSleep,
    );
    expect(cat(stage, 180_000, ids[1]).clip).toBe('dangle');
    stage.handleCommand({ type: 'debug/simulate', cat: at(ids, 1), interaction: 'drop' }, 180_000);
    run(stage, 180_000, 240_000);
    expect(
      stage.debugReport(240_000).cats.every((c) => c.behavior === labels.doNotDisturbSleep),
    ).toBe(true);
  });

  it.each([
    [1920, 1080, 1],
    [2560, 1440, 1],
    [3440, 1440, 1],
    [2880, 1800, 1.5],
    [1920, 1080, 1.25],
  ])('%s×%s，缩放%s：不同猫大小都能入场、出场、再回来', (width, height, dpi) => {
    for (const scale of [0.5, 1, 2]) {
      const bounds = { width: width / dpi, height: height / dpi };
      const { stage, state } = setup({ bounds, scale });
      expect(stage.update(0).cats.every((p) => fullyOutside(p, bounds.width))).toBe(true);
      expect(run(stage, 0, 120_000).cats.every((p) => p.x > 0 && p.x < bounds.width)).toBe(true);
      stage.applySnapshot(state([], 2), 120_000);
      expect(stage.update(240_000).cats).toEqual([]);
      stage.applySnapshot(state(ids, 3), 240_000);
      expect(stage.update(240_000).cats.every((p) => fullyOutside(p, bounds.width))).toBe(true);
      expect(stage.update(360_000).cats.every((p) => p.x > 0 && p.x < bounds.width)).toBe(true);
    }
  });

  it('推进频率不改变入场；系统时间倒退不延长排队等待', () => {
    const a = setup();
    const b = setup();
    run(a.stage, 0, 8000, 16);
    run(b.stage, 0, 8000, 100);
    for (const id of ids) expect(cat(a.stage, 8000, id).x).toBeCloseTo(cat(b.stage, 8000, id).x, 6);
    const c = setup();
    c.stage.update(-10_000);
    c.stage.update(-6000);
    expect(c.starts.filter((s) => s.clip === 'walk')).toEqual(
      expect.arrayContaining([
        { cat: 'active', clip: 'walk', at: 0 },
        { cat: 'middle', clip: 'walk', at: -8500 },
        { cat: 'quiet', clip: 'walk', at: -7000 },
      ]),
    );
  });

  it('缺可选片段时仍能进出场和勿扰睡觉', () => {
    const stage = new Stage({
      content: catalog([
        { cat: testCat('a'), clips: testClips(['run', 'purr', 'dangle', 'land', 'fall']) },
      ]),
      snapshot: { ...snapshot(['a']), doNotDisturb: { mode: 'untilOff' } },
      bounds: SCREEN,
      now: 0,
      random: () => 0.5,
    });
    run(stage, 0, 120_000);
    expect(stage.debugReport(120_000).cats[0]?.behavior).toBe(labels.doNotDisturbSleep);
    stage.applySnapshot(snapshot([], {}, 2), 120_000);
    expect(stage.update(240_000).cats).toEqual([]);
  });
});
