// 地板（Floor，D4）：桌面层底部一条带纵深的可站立区域。
// 猫在地板上的位置用 x（桌面层里的 CSS 像素）和纵深 d（0 = 最远，1 = 最近）表示。
//
// 远近缩放按透视来算：缩放和离地平线的距离成正比。地板纵深拉满时，最远处是 85%、最近处是 100%；
// 纵深调小，地板变窄，最远处的缩放也按比例接近 100%。纵深为 0 时，所有猫都在同一条线上、一样大。
import type { StageBounds } from '../../shared/core-api';

/** 标准猫在 100% 缩放下站着的高度（CSS 像素，D13）。 */
export const STANDARD_CAT_HEIGHT = 150;
/** 地板纵深拉满时，最远处的缩放（D4）。 */
export const FAR_SCALE_AT_FULL_DEPTH = 0.85;
/** 地板纵深拉满时，地板有多高：标准猫身高的几倍。 */
const MAX_BAND_RATIO = 1;
/** 最近一条线离桌面层底边多远：标准猫身高的几倍。 */
const BOTTOM_MARGIN_RATIO = 0.08;
/** 猫咪包允许的最大相对体型（CatSchema）。最远一条线要给最大的猫留出头顶的空间。 */
const MAX_RELATIVE_SIZE = 1.5;
/** 侧面的猫，从落脚锚点到身体一端大约多远：站立身高的几倍。用来让猫不跑出屏幕左右两边。 */
const HALF_BODY_LENGTH_RATIO = 0.6;

export interface FloorParams {
  bounds: StageBounds;
  /** 用户设置的缩放（settings.scale）。 */
  scale: number;
  /** 地板纵深（settings.floorDepth），0～1。 */
  floorDepth: number;
}

export class Floor {
  readonly width: number;
  readonly height: number;
  /** 最近一条线的 y。 */
  readonly nearY: number;
  /** 最远一条线的 y。 */
  readonly farY: number;
  /** 最远处的远近缩放。 */
  readonly farScale: number;
  private readonly unit: number;

  constructor(params: FloorParams) {
    this.width = Math.max(0, params.bounds.width);
    this.height = Math.max(0, params.bounds.height);
    this.unit = STANDARD_CAT_HEIGHT * params.scale;
    this.nearY = Math.max(0, this.height - BOTTOM_MARGIN_RATIO * this.unit);
    const maxBand = MAX_BAND_RATIO * this.unit;
    const room = Math.max(0, this.nearY - MAX_RELATIVE_SIZE * this.unit);
    const band = Math.min(clamp01(params.floorDepth) * maxBand, room);
    this.farY = this.nearY - band;
    this.farScale = 1 - (1 - FAR_SCALE_AT_FULL_DEPTH) * (maxBand > 0 ? band / maxBand : 0);
  }

  /** 地板的高度（像素）。0 表示没有纵深。 */
  get band(): number {
    return this.nearY - this.farY;
  }

  yAt(d: number): number {
    return this.farY + clamp01(d) * this.band;
  }

  /** 屏幕上的 y 对应的纵深。地板没有纵深时返回 undefined。 */
  depthAtY(y: number): number | undefined {
    return this.band > 0 ? clamp01((y - this.farY) / this.band) : undefined;
  }

  depthScale(d: number): number {
    return this.farScale + (1 - this.farScale) * clamp01(d);
  }

  /** 一只相对体型为 relativeSize 的猫，落脚锚点 x 的范围。屏幕太窄放不下时，两端都是正中间。 */
  xRange(relativeSize: number): { min: number; max: number } {
    const half = HALF_BODY_LENGTH_RATIO * this.unit * relativeSize;
    if (this.width < 2 * half) return { min: this.width / 2, max: this.width / 2 };
    return { min: half, max: this.width - half };
  }

  clampX(x: number, relativeSize: number): number {
    const { min, max } = this.xRange(relativeSize);
    return Math.min(max, Math.max(min, x));
  }
}

export function clamp01(v: number): number {
  return v > 0 ? (v < 1 ? v : 1) : 0;
}
