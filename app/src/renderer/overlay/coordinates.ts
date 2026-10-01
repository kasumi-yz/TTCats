import type { CatPlacement } from '../../shared/core-api';
import type { Clip } from '../../shared/schemas';
import { hitMaskAt, hitMaskLayout } from '../../shared/hitmask';

/** Electron 的屏幕坐标与 CSS 都是 DIP；只有系统级测试输入才从物理像素转换。 */
export function physicalToLocal(
  point: { x: number; y: number },
  origin: { x: number; y: number },
  scaleFactor: number,
) {
  return { x: point.x / scaleFactor - origin.x, y: point.y / scaleFactor - origin.y };
}

export function localToClip(
  point: { x: number; y: number },
  placement: CatPlacement,
  clip: Clip,
  frame: number,
) {
  const anchor = clip.footAnchors[frame];
  if (!anchor || !(placement.scale > 0)) return undefined;
  return {
    x:
      anchor.x +
      (point.x - placement.x) / (placement.mirrored ? -placement.scale : placement.scale),
    y: anchor.y + (point.y - placement.y) / placement.scale,
  };
}

export function hitCat(
  point: { x: number; y: number },
  placement: CatPlacement,
  clip: Clip,
  mask: Uint8Array,
  frame: number,
): boolean {
  const pixel = localToClip(point, placement, clip, frame);
  return pixel !== undefined && hitMaskAt(mask, hitMaskLayout(clip), frame, pixel.x, pixel.y);
}
