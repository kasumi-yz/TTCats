import { nativeImage, type NativeImage } from 'electron';

/** NativeImage.toBitmap 返回预乘透明度像素（SkImageInfo::MakeN32Premul）。
 * 猫的颜色已乘过 alpha，不能再乘一次，否则半透明毛边会发黑。
 * https://github.com/electron/electron/blob/main/shell/common/api/electron_api_native_image.cc
 */
export function composePhoto(
  desktop: NativeImage,
  overlay: NativeImage,
  x: number,
  y: number,
): NativeImage {
  const size = desktop.getSize();
  const layerSize = overlay.getSize();
  const pixels = desktop.toBitmap();
  const layer = overlay.toBitmap();
  for (let row = Math.max(0, -y); row < Math.min(layerSize.height, size.height - y); row++) {
    for (let col = Math.max(0, -x); col < Math.min(layerSize.width, size.width - x); col++) {
      const from = (row * layerSize.width + col) * 4;
      const to = ((row + y) * size.width + col + x) * 4;
      const alpha = (layer[from + 3] ?? 0) / 255;
      if (alpha === 0) continue;
      for (let channel = 0; channel < 3; channel++)
        pixels[to + channel] = Math.round(
          (layer[from + channel] ?? 0) + (pixels[to + channel] ?? 0) * (1 - alpha),
        );
      pixels[to + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(pixels, size);
}
