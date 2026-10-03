import { expect, it } from 'vitest';
import { captionHitBounds } from './test-window-ledges';

it('截图的按钮参考按实际系统命中区域得到，不用被测 DWM 矩形夹住右端', () => {
  const outer = { left: 200, top: 300, right: 800, bottom: 600 };
  const result = captionHitBounds(outer, 1.5, (x, y) => {
    if (y < 300 || y >= 345 || x < 580 || x >= 795) return 1;
    return x < 652 ? 8 : x < 724 ? 9 : 20;
  });
  expect(result).toEqual({ left: 580, top: 300, right: 795, bottom: 345 });
  expect(() => captionHitBounds(outer, 1.5, () => 1)).toThrow('没有找到关闭按钮');
});
