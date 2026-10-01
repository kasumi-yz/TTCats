import { describe, expect, it } from 'vitest';
import { encodeHitMaskFrame, hitMaskAt, hitMaskLayout } from './hitmask';

/** 造一帧 width × height 的不透明度，opaque(x, y) 为真的像素不透明。 */
function alphaOf(width: number, height: number, opaque: (x: number, y: number) => boolean) {
  const alpha = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) alpha[y * width + x] = opaque(x, y) ? 255 : 0;
  }
  return alpha;
}

describe('点击遮罩的排布', () => {
  it('列数和行数向上取整，每帧按位补齐到整字节', () => {
    expect(hitMaskLayout({ width: 10, height: 6, frameCount: 3, hitMaskScale: 4 })).toEqual({
      scale: 4,
      cols: 3,
      rows: 2,
      frameBytes: 1,
      totalBytes: 3,
    });
    expect(hitMaskLayout({ width: 384, height: 384, frameCount: 48, hitMaskScale: 4 })).toEqual({
      scale: 4,
      cols: 96,
      rows: 96,
      frameBytes: 1152,
      totalBytes: 55296,
    });
  });
});

describe('点击遮罩的编码', () => {
  it('格子编号行优先，第 i 格在第 i/8 个字节的第 i%8 位（最低位在前）', () => {
    // 3 列 × 2 行：只有第 1 行第 2 列（格子 5）不透明
    const alpha = alphaOf(12, 8, (x, y) => x >= 8 && y >= 4);
    expect([...encodeHitMaskFrame(alpha, 12, 8, 4)]).toEqual([0b0010_0000]);
  });

  it('格子里 alpha 平均值 ≥ 128 才算猫身上', () => {
    const half = alphaOf(4, 4, (_x, y) => y < 2); // 刚好一半像素不透明：平均 127.5
    expect([...encodeHitMaskFrame(half, 4, 4, 4)]).toEqual([0]);
    const more = alphaOf(4, 4, (x, y) => y < 2 || (y === 2 && x === 0)); // 多一个像素
    expect([...encodeHitMaskFrame(more, 4, 4, 4)]).toEqual([1]);
    const flat = new Uint8Array(16).fill(128); // 每个像素都是半透明的 128
    expect([...encodeHitMaskFrame(flat, 4, 4, 4)]).toEqual([1]);
  });

  it('最右一列、最下一行不满一格时，只算画面里实际有的像素', () => {
    // 5×5 画面、4 倍缩小：右下角格子只有 1 个像素
    const alpha = alphaOf(5, 5, (x, y) => x === 4 && y === 4);
    expect([...encodeHitMaskFrame(alpha, 5, 5, 4)]).toEqual([0b1000]);
  });
});

describe('点击判定', () => {
  const layout = hitMaskLayout({ width: 12, height: 8, frameCount: 2, hitMaskScale: 4 });
  const frame0 = encodeHitMaskFrame(
    alphaOf(12, 8, (x) => x < 4),
    12,
    8,
    4,
  );
  const frame1 = encodeHitMaskFrame(
    alphaOf(12, 8, (x) => x >= 8),
    12,
    8,
    4,
  );
  const mask = new Uint8Array([...frame0, ...frame1]);

  it('按帧号和像素坐标查到对应的格子', () => {
    expect(hitMaskAt(mask, layout, 0, 1, 1)).toBe(true);
    expect(hitMaskAt(mask, layout, 0, 10, 6)).toBe(false);
    expect(hitMaskAt(mask, layout, 1, 1, 1)).toBe(false);
    expect(hitMaskAt(mask, layout, 1, 10, 6)).toBe(true);
  });

  it('超出画面或帧号越界都算不在猫身上', () => {
    expect(hitMaskAt(mask, layout, 0, -1, 0)).toBe(false);
    expect(hitMaskAt(mask, layout, 0, 12, 0)).toBe(false);
    expect(hitMaskAt(mask, layout, 0, 0, 8)).toBe(false);
    expect(hitMaskAt(mask, layout, 2, 1, 1)).toBe(false);
    expect(hitMaskAt(mask, layout, -1, 1, 1)).toBe(false);
    expect(hitMaskAt(mask, layout, 0.5, 1, 1)).toBe(false);
  });
});
