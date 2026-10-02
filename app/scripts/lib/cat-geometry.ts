// 交互测试按猫咪包里真实的点击遮罩找点击位置：哪里一定是猫身上、哪里一定不是。
// 桌面层不报告当前帧和朝向，所以这里按"站着循环"片段的所有帧、两种朝向都算一遍，取最稳妥的结果。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CatSchema, ClipSchema, type Clip } from '../../src/shared/schemas';
import { hitCat } from '../../src/renderer/overlay/coordinates';

export interface Point {
  x: number;
  y: number;
}

/** 一只站着不动的猫：落脚点（桌面层 CSS 像素）、最终缩放和它的站立片段。 */
export interface StandingCat {
  id: string;
  x: number;
  y: number;
  scale: number;
  clip: Clip;
  mask: Uint8Array;
}

export interface StandClip {
  relativeSize: number;
  clip: Clip;
  mask: Uint8Array;
}

/** 读猫咪包里的体型和某个片段（默认 idle-stand：交互测试冻结猫时播的就是它）。 */
export function loadStandClip(
  contentDirectory: string,
  cat: string,
  clipName = 'idle-stand',
): StandClip {
  const dir = join(contentDirectory, 'cats', cat);
  const info = CatSchema.parse(JSON.parse(readFileSync(join(dir, 'cat.json'), 'utf8')));
  const clip = ClipSchema.parse(
    JSON.parse(readFileSync(join(dir, 'clips', `${clipName}.json`), 'utf8')),
  );
  return {
    relativeSize: info.relativeSize,
    clip,
    mask: new Uint8Array(readFileSync(join(dir, clip.hitMask))),
  };
}

/**
 * 撸猫来回划的两个端点：站着和开始呼噜（换成 purr 片段）以后都一定在猫身上，
 * 两点之间的距离尽量大。shapes 是同一只猫在同一位置的几种片段。
 */
export function strokePoints(
  shapes: StandingCat[],
  others: StandingCat[],
): { left: Point; right: Point } | undefined {
  const [first] = shapes;
  if (!first) return undefined;
  const ok = (p: Point): boolean =>
    shapes.every((s) => surelyOnCat(s, p)) && others.every((o) => !maybeOnCat(o, p));
  const box = catBox(first);
  let best: { left: Point; right: Point; span: number } | undefined;
  for (let y = box.y0; y <= box.y1; y += 2)
    for (let span = 4; span <= (box.x1 - box.x0) / 2; span += 2) {
      const left = { x: first.x - span, y };
      const right = { x: first.x + span, y };
      if (!ok(left) || !ok(right)) continue;
      if (!best || span > best.span) best = { left, right, span };
    }
  return best && { left: best.left, right: best.right };
}

function hitAny(cat: StandingCat, p: Point, every: boolean, radius: number): boolean {
  const offsets = [-radius, 0, radius];
  for (let frame = 0; frame < cat.clip.frameCount; frame++)
    for (const mirrored of [false, true])
      for (const dx of offsets)
        for (const dy of offsets) {
          const hit = hitCat(
            { x: p.x + dx, y: p.y + dy },
            {
              cat: cat.id,
              clip: cat.clip.name,
              variant: cat.clip.variant,
              clipTimeMs: 0,
              playbackRate: 1,
              x: cat.x,
              y: cat.y,
              scale: cat.scale,
              mirrored,
              depth: 0,
              pose: cat.clip.fromPose,
            },
            cat.clip,
            cat.mask,
            frame,
          );
          if (every && !hit) return false;
          if (!every && hit) return true;
        }
  return every;
}

/** 不管哪一帧、哪种朝向、周围 2 像素内，都是猫身上。 */
export function surelyOnCat(cat: StandingCat, p: Point): boolean {
  return hitAny(cat, p, true, 2);
}

/** 只要有一帧、一种朝向、周围 3 像素内碰到猫身，就算"可能是猫身上"。 */
export function maybeOnCat(cat: StandingCat, p: Point): boolean {
  return hitAny(cat, p, false, 3);
}

/** 猫的画面范围（桌面层坐标）。 */
export function catBox(cat: StandingCat): { x0: number; x1: number; y0: number; y1: number } {
  const anchor = cat.clip.footAnchors[0] ?? { x: cat.clip.width / 2, y: cat.clip.height };
  const half = Math.max(anchor.x, cat.clip.width - anchor.x) * cat.scale;
  return {
    x0: cat.x - half,
    x1: cat.x + half,
    y0: cat.y - anchor.y * cat.scale,
    y1: cat.y + (cat.clip.height - anchor.y) * cat.scale,
  };
}

/**
 * 在区域里找一个满足条件、离"不满足条件的地方"最远的点（最不容易因为一两个像素的误差点偏）。
 * 找不到、或者最好的点离边界不到 minClearance 像素时返回 undefined。
 */
export function pickPoint(
  region: { x0: number; x1: number; y0: number; y1: number },
  ok: (p: Point) => boolean,
  minClearance = 3,
  step = 2,
): Point | undefined {
  const cols = Math.max(1, Math.floor((region.x1 - region.x0) / step) + 1);
  const rows = Math.max(1, Math.floor((region.y1 - region.y0) / step) + 1);
  const grid: boolean[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      grid.push(ok({ x: region.x0 + c * step, y: region.y0 + r * step }));
  const reach = 20;
  let best: { p: Point; clearance: number } | undefined;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      if (!grid[r * cols + c]) continue;
      let clearance = reach * step;
      for (let dr = -reach; dr <= reach; dr++)
        for (let dc = -reach; dc <= reach; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= rows || cc >= cols || grid[rr * cols + cc]) continue;
          clearance = Math.min(clearance, Math.hypot(dr, dc) * step);
        }
      if (!best || clearance > best.clearance)
        best = { p: { x: region.x0 + c * step, y: region.y0 + r * step }, clearance };
    }
  return best && best.clearance >= minClearance ? best.p : undefined;
}

/** 猫身上、而且不会碰到其他猫的点（拖猫、点猫用）。 */
export function exclusivePoint(cat: StandingCat, others: StandingCat[]): Point | undefined {
  return pickPoint(
    catBox(cat),
    (p) => surelyOnCat(cat, p) && others.every((o) => !maybeOnCat(o, p)),
  );
}

/** 两只猫都一定不透明的点。 */
export function sharedPoint(a: StandingCat, b: StandingCat): Point | undefined {
  const box = catBox(a);
  return pickPoint(box, (p) => surelyOnCat(a, p) && surelyOnCat(b, p));
}

/**
 * 猫的两腿之间：在猫的画面范围里、两条腿之间，但哪只猫都碰不到。
 * 只在落脚点左右各 0.15 个画面宽、地面往上 0.3 个画面高以内找，免得找到猫画面外面去。
 */
export function legGap(cat: StandingCat, all: StandingCat[]): Point | undefined {
  const box = catBox(cat);
  const width = box.x1 - box.x0;
  const height = box.y1 - box.y0;
  return pickPoint(
    { x0: cat.x - width * 0.15, x1: cat.x + width * 0.15, y0: cat.y - height * 0.3, y1: cat.y },
    (p) => all.every((o) => !maybeOnCat(o, p)),
    2,
    1,
  );
}
