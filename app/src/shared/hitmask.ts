// 点击遮罩（HitMask）的文件格式（ADR-0003）。M1 定稿（#18），沿用 M0-A 验证过的做法。
// 素材工厂（Python）、测试猫咪包的生成脚本、桌面层的点击判定都按这里的规则读写。
//
// 一个片段对应一个遮罩文件，记录每一帧里哪些地方是猫身上：
// - 把片段画面切成 hitMaskScale × hitMaskScale 像素的格子（hitMaskScale 写在片段元数据里）。
//   列数 = ceil(width / hitMaskScale)，行数 = ceil(height / hitMaskScale)。
//   最右一列和最下一行可能不满一格，只算画面里实际有的像素。
// - 一格里像素的 alpha 平均值 ≥ 128（0～255）就算猫身上，记为 1，否则记为 0。刚好一半像素不透明时平均值是 127.5，不算。
// - 每一帧按行优先排：第 0 行从左到右，再第 1 行……格子编号 i = 行 × 列数 + 列。
// - 每格占 1 位：格子 i 在这一帧的第 floor(i / 8) 个字节，第 (i mod 8) 位（最低位是第 0 位）。
// - 每一帧占 ceil(列数 × 行数 / 8) 个字节，最后一个字节没用到的高位写 0。
// - 所有帧按顺序首尾相接，没有文件头。文件长度必须正好是 每帧字节数 × frameCount。

/** 一个片段的点击遮罩在文件里的排布。 */
export interface HitMaskLayout {
  scale: number;
  cols: number;
  rows: number;
  /** 每一帧占多少字节。 */
  frameBytes: number;
  /** 整个文件应该有多少字节。 */
  totalBytes: number;
}

export function hitMaskLayout(clip: {
  width: number;
  height: number;
  frameCount: number;
  hitMaskScale: number;
}): HitMaskLayout {
  const scale = clip.hitMaskScale;
  const cols = Math.ceil(clip.width / scale);
  const rows = Math.ceil(clip.height / scale);
  const frameBytes = Math.ceil((cols * rows) / 8);
  return { scale, cols, rows, frameBytes, totalBytes: frameBytes * clip.frameCount };
}

/**
 * 第 frame 帧（从 0 算起）里，片段画面上的 (x, y) 像素是不是猫身上。
 * 坐标是片段画面里的像素坐标，原点在左上角；超出画面或帧号越界都返回 false。
 */
export function hitMaskAt(
  mask: Uint8Array,
  layout: HitMaskLayout,
  frame: number,
  x: number,
  y: number,
): boolean {
  const col = Math.floor(x / layout.scale);
  const row = Math.floor(y / layout.scale);
  if (col < 0 || row < 0 || col >= layout.cols || row >= layout.rows) return false;
  if (!Number.isInteger(frame) || frame < 0) return false;
  const i = row * layout.cols + col;
  const byte = mask[frame * layout.frameBytes + (i >> 3)];
  return byte !== undefined && (byte & (1 << (i & 7))) !== 0;
}

/**
 * 把一帧画面的不透明度编码成遮罩。alpha 是逐像素的不透明度（0～255），按行优先排，长度 width × height。
 * 生成测试猫咪包、给素材工厂对照结果时用。
 */
export function encodeHitMaskFrame(
  alpha: Uint8Array,
  width: number,
  height: number,
  scale: number,
): Uint8Array {
  const layout = hitMaskLayout({ width, height, frameCount: 1, hitMaskScale: scale });
  const out = new Uint8Array(layout.frameBytes);
  for (let row = 0; row < layout.rows; row++) {
    for (let col = 0; col < layout.cols; col++) {
      let sum = 0;
      let count = 0;
      for (let y = row * scale; y < Math.min((row + 1) * scale, height); y++) {
        for (let x = col * scale; x < Math.min((col + 1) * scale, width); x++) {
          sum += alpha[y * width + x] ?? 0;
          count += 1;
        }
      }
      if (sum >= 128 * count) {
        const i = row * layout.cols + col;
        out[i >> 3] = (out[i >> 3] ?? 0) | (1 << (i & 7));
      }
    }
  }
  return out;
}
