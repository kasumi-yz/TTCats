import { describe, expect, it } from 'vitest';
import { CatActor, type Facing } from './actor';
import { Floor } from './floor';
import { SCREEN, snapshot, testCat, testClip, testClips } from './test-fixtures';

function setup(facing: Facing, x: number, speed = 80) {
  const actor = new CatActor(
    testCat('one-way'),
    [...testClips(['walk', 'run']), testClip('walk', { facing, mirrorable: false, speed })],
    {
      random: () => 0.5,
      floor: new Floor({ bounds: SCREEN, scale: 1, floorDepth: 1 }),
      scale: 1,
      activityLevel: snapshot(['one-way']).settings.activityLevel,
      addEffect: () => undefined,
    },
    { x, d: 0, facing, now: 0 },
  );
  actor.playDebugClip('idle-stand', undefined, 0);
  return actor;
}

function outside(actor: CatActor, x = actor.x) {
  const extent = 128 * actor.finalScale();
  return x + extent < 0 || x - extent > SCREEN.width;
}

function advance(actor: CatActor, from: number, to: number) {
  for (let t = from; t < to; t += 50) actor.advance(t, Math.min(t + 50, to), false);
}

describe('单向、不可镜像的生命周期（#78 审查回归）', () => {
  it.each(['left', 'right'] as const)('只能朝 %s 走时，从可行的一侧入场', (facing) => {
    const actor = setup(facing, SCREEN.width / 2);
    // 故意请求相反的初始朝向，包括延迟期间的尺寸更新。
    actor.facing = facing === 'left' ? 'right' : 'left';
    actor.enter(SCREEN.width / 2, 1500, 0);
    const before = actor.x;
    expect(outside(actor)).toBe(true);
    expect(before < 0).toBe(facing === 'right');
    actor.clampToFloor();
    expect(actor.x).toBe(before);
    advance(actor, 0, 1500);
    expect(actor.x).toBe(before);
    advance(actor, 1500, 2500);
    expect((actor.x - before) * (facing === 'right' ? 1 : -1)).toBeGreaterThan(0);
    expect(actor.placement().mirrored).toBe(false);
    advance(actor, 2500, 60_000);
    expect(actor.x).toBeGreaterThan(0);
    expect(actor.x).toBeLessThan(SCREEN.width);
    expect(actor.behavior.kind).not.toBe('entrance');
  });

  it.each(['left', 'right'] as const)('最近一侧不可达时，朝 %s 完整走出屏幕', (facing) => {
    const start = facing === 'right' ? 300 : SCREEN.width - 300;
    const actor = setup(facing, start);
    actor.exit(0);
    expect(actor.x).toBe(start);
    expect(actor.hasExited()).toBe(false);
    let moved = false;
    for (let t = 0; t < 90_000 && !actor.hasExited(); t += 50) {
      const previous = actor.x;
      actor.advance(t, t + 50, false);
      if (actor.x !== previous) {
        moved = true;
        expect((actor.x - previous) * (facing === 'right' ? 1 : -1)).toBeGreaterThan(0);
        expect(actor.placement().mirrored).toBe(false);
      }
      if (actor.hasExited()) expect(outside(actor, previous)).toBe(true);
    }
    expect(moved).toBe(true);
    expect(actor.hasExited()).toBe(true);
    expect(outside(actor)).toBe(true);
  });

  it.each(['left', 'right'] as const)('出场中无法掉头时，离屏后再从 %s 方向返回', (facing) => {
    const actor = setup(facing, SCREEN.width / 2);
    actor.exit(0);
    advance(actor, 0, 3000);
    const before = actor.x;
    actor.enter(SCREEN.width / 2, 0, 3000, false);
    expect(actor.x).toBe(before);
    let crossed = false;
    let returned = false;
    for (let t = 3000; t < 90_000; t += 50) {
      const previous = actor.x;
      const wasOutside = outside(actor);
      actor.advance(t, t + 50, false);
      expect(actor.hasExited()).toBe(false);
      if (Math.abs(actor.x - previous) > SCREEN.width / 2) {
        expect(wasOutside && outside(actor)).toBe(true);
        crossed = true;
      }
      if (crossed && !actor.isExiting() && !outside(actor)) returned = true;
    }
    expect(crossed && returned).toBe(true);
  });

  it('没有有效移动速度时，不把入场或出场失败记成完成', () => {
    const entering = setup('right', 300, 0);
    entering.enter(300, 0, 0);
    const entranceX = entering.x;
    advance(entering, 0, 60_000);
    expect(entering.x).toBe(entranceX);
    expect(entering.behavior.kind).toBe('entrance');
    const exiting = setup('right', 300, 0);
    exiting.exit(0);
    advance(exiting, 0, 60_000);
    expect(exiting.x).toBe(300);
    expect(exiting.hasExited()).toBe(false);
    expect(exiting.isExiting()).toBe(true);
  });

  it('无法走到勿扰角落时，不把原地停留误报为到达后睡觉', () => {
    const actor = setup('right', 1200);
    actor.setCorner(100, 0);
    advance(actor, 0, 60_000);
    expect(actor.x).toBe(1200);
    expect(actor.behavior.kind).toBe('goToCorner');
    expect(actor.placement().clip).not.toBe('sleep');
  });

  it('等待离屏后返回时再次隐藏，取消返回计划', () => {
    const actor = setup('right', SCREEN.width / 2);
    actor.exit(0);
    advance(actor, 0, 3000);
    actor.enter(300, 0, 3000, false);
    actor.exit(3000);
    advance(actor, 3000, 60_000);
    expect(actor.hasExited()).toBe(true);
    expect(outside(actor)).toBe(true);
  });
});
