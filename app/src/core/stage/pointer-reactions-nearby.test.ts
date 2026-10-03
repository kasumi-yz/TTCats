import { describe, expect, it } from 'vitest';
import type { PointerInput } from '../../shared/core-api';
import type { SimulatedInteraction } from '../../shared/ipc';
import { Stage } from './stage-core';
import { at, catalog, NEUTRAL, SCREEN, snapshot, testCat } from './test-fixtures';

function setup({ patience = 0, scale = 1, relativeSize = 1, doNotDisturb = false } = {}) {
  const id = 'arbitrary-cat';
  const initial = snapshot([id], { scale, floorDepth: 0 });
  if (doNotDisturb) initial.doNotDisturb = { mode: 'untilOff' };
  const stage = new Stage({
    content: catalog([
      { cat: testCat(id, { relativeSize, personality: { ...NEUTRAL, patience } }) },
    ]),
    snapshot: initial,
    bounds: SCREEN,
    // 先让入场走完，再从屏内开始测。
    now: -60_000,
    random: () => 0.5,
  });
  stage.handleCommand({ type: 'debug/playClip', cat: id, clip: 'idle-stand' }, 0);
  const p = at(stage.update(0).cats, 0);
  const unit = 150 * p.scale;
  const point = { x: p.x + 1.5 * unit, y: p.y - unit / 2 };
  const click = (
    now: number,
    patch: Partial<Extract<PointerInput, { type: 'clickThrough' }>> = {},
  ) => {
    stage.handlePointer({ type: 'clickThrough', ...point, cat: null, ...patch }, now);
  };
  const simulate = (interaction: SimulatedInteraction, now: number) => {
    stage.handleCommand({ type: 'debug/simulate', cat: id, interaction }, now);
  };
  const behavior = (now: number) => at(stage.debugReport(now).cats, 0).behavior;
  return { stage, id, p, unit, point, click, simulate, behavior, initial };
}

describe('在猫旁边连续点击让开（D10）', () => {
  it.each(['nearby', 'body', 'far'] as const)('只累计附近空白，区别于身上和远处：%s', (where) => {
    const { stage, id, p, point, unit, click, behavior } = setup();
    const patch =
      where === 'body' ? { x: p.x, cat: id } : where === 'far' ? { x: p.x + unit * 2.01 } : {};
    for (const t of [0, 100, 200]) click(t, patch);
    expect(behavior(200) === '走开').toBe(where === 'nearby');
    if (where === 'nearby') {
      const moved = at(stage.update(2200).cats, 0);
      expect(moved.x).toBeLessThan(p.x);
      expect(Math.abs(moved.x - point.x)).toBeGreaterThan(Math.abs(p.x - point.x));
    }
    expect(stage.drainFacts()).toEqual([]);
  });

  it.each([2000, 2001])('两秒窗口包含边界，不累计过期点击：%i', (span) => {
    const { click, behavior } = setup();
    click(0);
    click(1000);
    click(span);
    expect(behavior(span) === '走开').toBe(span === 2000);
  });

  it.each([
    [0, 3],
    [0.5, 4],
    [1, 5],
  ] as const)('耐心 %s 要点 %s 次，同样规则适用任意猫', (patience, count) => {
    const { click, behavior } = setup({ patience });
    for (let i = 0; i < count - 1; i++) click(i * 100);
    expect(behavior(300)).not.toBe('走开');
    click((count - 1) * 100);
    expect(behavior(400)).toBe('走开');
  });

  it.each([0.5, 1, 2])('距离随显示大小变化：缩放 %s', (scale) => {
    const { p, unit, click, behavior } = setup({ scale, relativeSize: 0.8 });
    for (const t of [0, 100, 200]) click(t, { x: p.x + 2.01 * unit });
    expect(behavior(200)).not.toBe('走开');
    for (const t of [300, 400, 500]) click(t, { x: p.x + 2 * unit });
    expect(behavior(500)).toBe('走开');
  });

  it('幽灵模式仍响应附近点击，但穿过自身的点击不算附近', () => {
    const { stage, click, p, id, behavior } = setup();
    stage.setGhostMode(true, 0);
    for (const t of [0, 100, 200]) click(t, { x: p.x, cat: id });
    expect(behavior(200)).not.toBe('走开');
    for (const t of [300, 400, 500]) click(t);
    expect(behavior(500)).toBe('走开');
  });

  it('冷却期内不累计；主动命令可打断，但不能绕过十秒冷却', () => {
    const { stage, click, id, behavior } = setup();
    for (const t of [0, 100, 200]) click(t);
    stage.handleCommand({ type: 'debug/playClip', cat: id, clip: 'idle-stand' }, 200);
    for (const t of [10000, 10100, 10199]) click(t);
    expect(behavior(10199)).not.toBe('走开');
    click(10200);
    expect(behavior(10200)).not.toBe('走开');
    click(10300);
    click(10400);
    expect(behavior(10400)).toBe('走开');
  });

  it('睡觉的猫先醒来再走开，不瞬移', () => {
    const { stage, click, p, id, behavior } = setup();
    stage.handleCommand({ type: 'cat/sleep', cat: id }, 0);
    expect(at(stage.update(2000).cats, 0).pose).toBe('sleep');
    for (const t of [2000, 2100, 2200]) click(t);
    expect(behavior(2200)).toBe('走开');
    expect(at(stage.update(2200).cats, 0).x).toBe(p.x);
    expect(at(stage.update(6000).cats, 0).x).toBeLessThan(p.x);
  });

  it('勿扰时让开后持续在新位置睡，关闭勿扰后可以恢复自主行为', () => {
    const { stage, click, p, initial, behavior } = setup({ doNotDisturb: true });
    for (const t of [0, 100, 200]) click(t);
    const settled = at(stage.update(15000).cats, 0);
    expect(settled.x).toBeLessThan(p.x);
    expect(settled.clip).toBe('sleep');
    for (const t of [30000, 60000, 120000]) {
      const current = at(stage.update(t).cats, 0);
      expect(current.x).toBe(settled.x);
      expect(current.clip).toBe('sleep');
    }
    stage.applySnapshot({ ...initial, revision: 2, doNotDisturb: { mode: 'off' } }, 120000);
    // 关闭勿扰时立刻醒来；之后睡不睡由自主行为决定。
    expect(behavior(120000)).not.toBe('去睡觉');
  });

  it('拎起和下落不受影响，模拟命令也不能覆盖悬空状态', () => {
    const { stage, click, simulate } = setup();
    simulate('pickUp', 0);
    for (const t of [0, 10, 20]) click(t);
    simulate('nearbyClicks', 20);
    expect(at(stage.update(20).cats, 0).clip).toBe('dangle');
    simulate('drop', 30);
    for (const t of [30, 40, 50]) click(t);
    simulate('nearbyClicks', 50);
    expect(at(stage.update(50).cats, 0).clip).toBe('fall');
  });

  it('调试命令复用次数判定和冷却，幽灵模式也可触发', () => {
    const { stage, simulate, behavior, p } = setup({ patience: 1 });
    stage.setGhostMode(true, 0);
    simulate('nearbyClicks', 0);
    expect(behavior(0)).toBe('走开');
    expect(at(stage.update(2000).cats, 0).x).not.toBe(p.x);
    expect(stage.drainFacts()).toEqual([]);
  });

  it('系统时间倒退不把原本过期的点击重新拼进窗口', () => {
    const { stage, click, behavior } = setup();
    click(10000);
    stage.update(11000);
    stage.update(1000);
    click(2100);
    click(2200);
    expect(behavior(2200)).not.toBe('走开');
    click(2300);
    expect(behavior(2300)).toBe('走开');
  });

  it('隐藏再显示不沿用旧猫的点击累计', () => {
    const { stage, click, id, initial, behavior } = setup();
    click(0);
    click(100);
    stage.applySnapshot(
      { ...initial, revision: 2, settings: { ...initial.settings, visibleCats: [] } },
      100,
    );
    stage.applySnapshot({ ...initial, revision: 3 }, 100);
    click(200);
    expect(behavior(200)).not.toBe('走开');
    expect(at(stage.update(200).cats, 0).cat).toBe(id);
  });

  it('多猫各自累计，调试指定猫不会顺便触发重叠的另一只', () => {
    const stage = new Stage({
      content: catalog(['one', 'two'].map((id) => ({ cat: testCat(id) }))),
      snapshot: snapshot(['one', 'two']),
      bounds: SCREEN,
      now: 0,
      random: () => 0.5,
    });
    stage.handleCommand({ type: 'debug/simulate', cat: 'one', interaction: 'nearbyClicks' }, 0);
    const cats = stage.debugReport(0).cats;
    expect(cats.find((cat) => cat.cat === 'one')?.behavior).toBe('走开');
    expect(cats.find((cat) => cat.cat === 'two')?.behavior).not.toBe('走开');
  });
});
