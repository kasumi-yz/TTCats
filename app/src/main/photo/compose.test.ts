import type { NativeImage } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { composePhoto } from './compose';

vi.mock('electron', () => ({
  nativeImage: {
    createFromBitmap: (pixels: Buffer, size: { width: number; height: number }) => ({
      getSize: () => size,
      toBitmap: () => pixels,
    }),
  },
}));

function image(width: number, height: number, pixels: number[]): NativeImage {
  return { getSize: () => ({ width, height }), toBitmap: () => Buffer.from(pixels) } as NativeImage;
}

describe('拍照透明合成', () => {
  it('透明处保留桌面、实心处保留猫，预乘半透明毛边不能再次变暗', () => {
    const desktop = image(3, 1, [100, 100, 100, 255, 100, 100, 100, 255, 100, 100, 100, 255]);
    const layer = image(3, 1, [0, 0, 0, 0, 20, 80, 120, 128, 10, 90, 200, 255]);
    const photo = composePhoto(desktop, layer, 0, 0);
    expect([...photo.toBitmap()]).toEqual([
      100, 100, 100, 255, 70, 130, 170, 255, 10, 90, 200, 255,
    ]);
    expect(photo.getSize()).toEqual({ width: 3, height: 1 });
  });

  it('工作区偏移映射到照片物理像素，超出屏幕部分裁掉而不折回另一行', () => {
    const desktop = image(2, 2, Array<number>(16).fill(255));
    const layer = image(
      2,
      2,
      [10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255],
    );
    expect([...composePhoto(desktop, layer, -1, 1).toBitmap()]).toEqual([
      255, 255, 255, 255, 255, 255, 255, 255, 40, 50, 60, 255, 255, 255, 255, 255,
    ]);
  });
});
