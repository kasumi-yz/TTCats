import { describe, expect, it } from 'vitest';
import type { CatPlacement } from '../../shared/core-api';
import type { Clip } from '../../shared/schemas';
import { hitCat, physicalToLocal } from './coordinates';

describe('点击遮罩坐标换算', () => {
  it.each([
    [1920, 1080, 1],
    [2560, 1440, 1],
    [3440, 1440, 1],
    [2880, 1800, 1.5],
    [1920, 1080, 1.25],
  ])('%dx%d 缩放 %s 按 DIP、实际视频帧锚点、缩放和镜像命中猫', (width, height, dpi) => {
    const origin = { x: -120, y: 30 };
    const placement: CatPlacement = {
      cat: 'test',
      clip: 'walk',
      variant: 1,
      clipTimeMs: 0,
      playbackRate: 1,
      x: (width / dpi) * 0.5,
      y: height / dpi - 100,
      scale: 1.7,
      mirrored: false,
      depth: 0,
      pose: 'stand',
    };
    const clip = {
      width: 8,
      height: 8,
      frameCount: 2,
      hitMaskScale: 1,
      footAnchors: [
        { x: 4, y: 7 },
        { x: 3, y: 6 },
      ],
    } as Clip;
    const mask = new Uint8Array(16);
    mask[8 + 2] = 1 << 2; // 第1帧 (2,2)；第0帧同位置为空。
    for (const mirrored of [false, true]) {
      placement.mirrored = mirrored;
      const local = {
        x: placement.x + (2.5 - 3) * (mirrored ? -placement.scale : placement.scale),
        y: placement.y + (2.5 - 6) * placement.scale,
      };
      const actual = physicalToLocal(
        { x: (local.x + origin.x) * dpi, y: (local.y + origin.y) * dpi },
        origin,
        dpi,
      );
      expect(hitCat(actual, placement, clip, mask, 1)).toBe(true);
      expect(hitCat(actual, placement, clip, mask, 0)).toBe(false);
      expect(hitCat({ x: actual.x + 100, y: actual.y }, placement, clip, mask, 1)).toBe(false);
    }
  });
});
