import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  exclusivePoint,
  legGap,
  loadStandClip,
  maybeOnCat,
  sharedPoint,
  surelyOnCat,
  type StandingCat,
} from './cat-geometry';

const content = join(import.meta.dirname, '../../test-content');
function standing(id: string, x: number, scale: number): StandingCat {
  const { clip, mask } = loadStandClip(content, id);
  return { id, x, y: 1000, scale, clip, mask };
}

describe('交互测试找点击位置（测试猫咪包的真实遮罩）', () => {
  it('单只猫：身上的点一定命中，两腿之间一定不命中', () => {
    const cat = standing('test-calm', 500, 1);
    const body = exclusivePoint(cat, []);
    const gap = legGap(cat, [cat]);
    expect(body && surelyOnCat(cat, body)).toBe(true);
    expect(gap && !maybeOnCat(cat, gap)).toBe(true);
    // 腿缝在猫的画面里面：落脚点上方，左右都不远
    expect(gap && Math.abs(gap.x - 500)).toBeLessThan(20);
    expect(gap && gap.y).toBeLessThan(1000);
  });

  it('两只猫重叠：共同的点、各自独有的点都能找到，而且互不矛盾', () => {
    const back = standing('test-calm', 500, 1);
    const front = standing('test-close', 535, 0.8);
    const shared = sharedPoint(front, back);
    const onlyBack = exclusivePoint(back, [front]);
    const onlyFront = exclusivePoint(front, [back]);
    expect(shared && surelyOnCat(back, shared) && surelyOnCat(front, shared)).toBe(true);
    expect(onlyBack && surelyOnCat(back, onlyBack) && !maybeOnCat(front, onlyBack)).toBe(true);
    expect(onlyFront && surelyOnCat(front, onlyFront) && !maybeOnCat(back, onlyFront)).toBe(true);
  });

  it('被别的猫完全盖住时找不到独有的点', () => {
    const small = standing('test-close', 500, 0.8);
    const big = standing('test-active', 500, 1.2);
    expect(exclusivePoint(small, [big])).toBeUndefined();
  });
});
