// 桌面层渲染进程：PixiJS 视频纹理播放 3 只"假猫"，片段切换与三种打断衔接，
// 按当前帧的点击遮罩做命中判定，拖动（拎起）和幽灵模式的画面表现。

import { Application, Container, Graphics, Sprite, Text, Texture, VideoSource } from 'pixi.js';
import type {
  CatInfo,
  CatPlacement,
  HiddenReport,
  InterruptMode,
  Layout,
  MainToRenderer,
  Point,
  Preload,
  Rect,
  RendererToMain,
  SwitchStats,
} from '../shared/protocol';
import { INTERRUPT_MODE_LABEL, INTERRUPT_MODES } from '../shared/protocol';

interface SpikeApi {
  send(channel: string, data: unknown): void;
  on(channel: string, fn: (data: unknown) => void): void;
  readMask(name: string): Promise<Uint8Array>;
  manifest(): Promise<Manifest>;
}
declare global {
  interface Window {
    spike: SpikeApi;
  }
}

interface ClipMeta {
  id: string;
  kind: 'loop' | 'transition';
  fromPose: string;
  toPose: string;
  frames: number;
  video: string;
  mask: string;
}
interface Manifest {
  size: number;
  fps: number;
  footAnchor: [number, number];
  mask: { width: number; height: number; scale: number };
  clips: ClipMeta[];
}

const api = window.spike;
const send = <K extends keyof RendererToMain>(channel: K, data: RendererToMain[K]): void => api.send(channel, data);
const on = <K extends keyof MainToRenderer>(channel: K, fn: (data: MainToRenderer[K]) => void): void =>
  api.on(channel, fn as (d: unknown) => void);
const emit = (type: string, data: Record<string, unknown> = {}): void => send('event', { type, ...data });

const CROSSFADE_MS = 150;
const POOF_MS = 260;
const GHOST_ALPHA = 0.35;
const smooth = (t: number): number => t * t * (3 - 2 * t);

let M: Manifest;
const clips = new Map<string, ClipMeta>();
const masks = new Map<string, Uint8Array>();
let maskFrameBytes = 0;

// ---- 统计 ----
const switchLatencies: number[] = [];
const interruptLatencies: Record<InterruptMode, number[]> = { crossfade: [], hardcut: [], transition: [] };
const counters = { interval: 0, raf: 0, rvfc: 0 };

function maskBit(clipId: string, frame: number, idx: number): boolean {
  const m = masks.get(clipId);
  if (!m) return false;
  const byte = m[frame * maskFrameBytes + (idx >> 3)];
  return (byte & (1 << (idx & 7))) !== 0;
}

/** 某个片段在所有帧上的"交集"（每帧都不透明）和"并集"（任意一帧不透明） */
const maskSummary = new Map<string, { and: Uint8Array; or: Uint8Array }>();
function summaryOf(clipId: string): { and: Uint8Array; or: Uint8Array } {
  let s = maskSummary.get(clipId);
  if (s) return s;
  const n = M.mask.width * M.mask.height;
  const and = new Uint8Array(n).fill(1);
  const or = new Uint8Array(n);
  const frames = clips.get(clipId)!.frames;
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < n; i++) {
      const b = maskBit(clipId, f, i);
      if (!b) and[i] = 0;
      if (b) or[i] = 1;
    }
  }
  s = { and, or };
  maskSummary.set(clipId, s);
  return s;
}

// ---- 播放器：一个片段一个 <video>，预加载后切换只需 play() ----
class Player {
  readonly video: HTMLVideoElement;
  readonly texture: Texture;
  frame = 0;
  private measureFrom = 0;
  private measureMode: InterruptMode | null = null;
  private startedAt = 0;
  onEnded: (() => void) | null = null;
  ready: Promise<void>;
  isReady = false;

  constructor(readonly clip: ClipMeta) {
    const v = document.createElement('video');
    v.src = `spike://app/assets/clips/${clip.video}`;
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.loop = clip.kind === 'loop';
    this.video = v;
    this.ready = new Promise((resolve) =>
      v.addEventListener(
        'loadeddata',
        () => {
          this.isReady = true;
          resolve();
        },
        { once: true },
      ),
    );
    const source = new VideoSource({ resource: v, autoPlay: false, autoLoad: true });
    this.texture = new Texture({ source });
    v.addEventListener('ended', () => this.onEnded?.());
    const onFrame = (_now: number, meta: VideoFrameCallbackMetadata): void => {
      counters.rvfc++;
      this.frame = Math.round(meta.mediaTime * M.fps) % clip.frames;
      if (this.startedAt) {
        // 从调用 play() 到新片段第一帧呈现
        switchLatencies.push(performance.now() - this.startedAt);
        this.startedAt = 0;
      }
      if (this.measureFrom) {
        // 从发出打断到新片段第一帧呈现（"过渡片段"方式包括等当前片段回到姿势的时间）
        if (this.measureMode) interruptLatencies[this.measureMode].push(performance.now() - this.measureFrom);
        this.measureFrom = 0;
        this.measureMode = null;
      }
      v.requestVideoFrameCallback(onFrame);
    };
    v.requestVideoFrameCallback(onFrame);
  }

  start(measureFrom: number, mode: InterruptMode | null): void {
    this.measureFrom = measureFrom;
    this.measureMode = mode;
    this.video.loop = this.clip.kind === 'loop';
    if (this.video.currentTime !== 0) this.video.currentTime = 0;
    this.frame = 0;
    this.startedAt = performance.now();
    void this.video.play();
  }

  destroy(): void {
    this.onEnded = null;
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    this.texture.destroy(true);
  }

  stop(): void {
    this.video.pause();
    this.video.loop = this.clip.kind === 'loop';
    this.video.currentTime = 0;
    this.frame = 0;
    this.measureFrom = 0;
  }
}

// ---- 猫 ----
class Cat {
  readonly root = new Container();
  readonly body = new Container();
  private readonly spriteA = new Sprite();
  private readonly spriteB = new Sprite();
  private readonly fx = new Graphics();
  private readonly label = new Text({ text: '', style: { fontSize: 13, fill: 0xffffff, stroke: { color: 0x000000, width: 3 } } });
  private readonly players = new Map<string, Player>();
  cur!: Player;
  private curSprite = this.spriteA;
  private fade: { player: Player; sprite: Sprite; start: number } | null = null;
  private poofStart = 0;
  private queue: string[] = [];
  private pendingClip: string | null = null;
  private interruptT0 = 0;
  private interruptMode: InterruptMode | null = null;
  z = 0;
  scale = 0.6;
  dragging = false;
  behaviors = false;
  nextBehaviorAt = 0;

  constructor(
    readonly id: string,
    public mode: InterruptMode,
    tint: number,
  ) {
    for (const s of [this.spriteA, this.spriteB]) {
      s.anchor.set(M.footAnchor[0], M.footAnchor[1]);
      s.tint = tint;
      s.visible = false;
      this.body.addChild(s);
    }
    this.root.addChild(this.body, this.fx, this.label);
    this.label.anchor.set(0.5, 0);
    this.label.y = 6;
  }

  player(clipId: string): Player {
    let p = this.players.get(clipId);
    if (!p) {
      const meta = clips.get(clipId);
      if (!meta) throw new Error(`没有片段 ${clipId}`);
      p = new Player(meta);
      p.onEnded = () => this.onEnded(p!);
      this.players.set(clipId, p);
    }
    return p;
  }

  async preloadAll(): Promise<void> {
    await Promise.all([...clips.keys()].map((id) => this.player(id).ready));
  }

  setScale(s: number): void {
    this.scale = s;
    this.body.scale.set(s);
  }

  setLabel(text: string): void {
    this.label.text = text;
  }

  get endPose(): string {
    return this.cur.clip.toPose;
  }

  /** 切到某个片段。fade=true 时 150ms 交叉淡化，否则硬切。 */
  playNow(clipId: string, opts: { fade?: boolean; measureFrom?: number; mode?: InterruptMode | null } = {}): void {
    const next = this.player(clipId);
    const prev = this.cur;
    const t0 = opts.measureFrom ?? performance.now();
    if (!next.isReady) {
      // 按需加载的片段还没准备好：当前片段继续播，加载完再切（这段等待计入打断延迟）
      this.pendingClip = clipId;
      void next.ready.then(() => {
        if (this.pendingClip === clipId) {
          this.pendingClip = null;
          this.playNow(clipId, { ...opts, measureFrom: t0 });
        }
      });
      return;
    }
    this.pendingClip = null;
    if (this.fade) this.finishFade();
    if (opts.fade && prev && prev !== next) {
      const other = this.curSprite === this.spriteA ? this.spriteB : this.spriteA;
      other.texture = next.texture;
      other.alpha = 0;
      other.visible = true;
      this.body.setChildIndex(other, 1);
      this.fade = { player: prev, sprite: this.curSprite, start: performance.now() };
      this.curSprite = other;
    } else {
      if (prev && prev !== next) prev.stop();
      this.curSprite.texture = next.texture;
      this.curSprite.alpha = 1;
      this.curSprite.visible = true;
    }
    this.cur = next;
    next.start(t0, opts.mode ?? null);
    emit('clip', { id: this.id, clip: clipId });
    this.sync();
  }

  /** lazy 预加载：只保留正在播的、正在淡出的、队列里接下来要播的片段，其余释放 */
  private sync(): void {
    if (preload !== 'lazy') return;
    const keep = new Set([this.cur.clip.id, ...this.queue]);
    if (this.fade) keep.add(this.fade.player.clip.id);
    if (this.pendingClip) keep.add(this.pendingClip);
    for (const id of this.queue) this.player(id); // 预热
    for (const [id, p] of this.players) {
      if (!keep.has(id)) {
        p.destroy();
        this.players.delete(id);
      }
    }
  }

  private finishFade(): void {
    if (!this.fade) return;
    if (this.fade.player !== this.cur) this.fade.player.stop();
    this.fade.sprite.visible = false;
    this.curSprite.alpha = 1;
    this.fade = null;
    this.sync();
  }

  private onEnded(p: Player): void {
    if (p !== this.cur) return;
    const next = this.queue.shift() ?? `loop_${p.clip.toPose}`;
    const measure = this.interruptT0 || undefined;
    const mode = this.interruptMode;
    this.interruptT0 = 0;
    this.interruptMode = null;
    this.playNow(next, { measureFrom: measure, mode });
  }

  /** 让当前循环片段播到结尾（也就是回到姿势）后停下，交给队列里的下一个片段 */
  private endAtBoundary(): void {
    if (this.cur.clip.kind === 'loop') this.cur.video.loop = false;
  }

  /** 平常的姿势变化：等当前片段回到姿势，再播过渡片段（不算打断） */
  goToPose(target: string): void {
    const from = this.endPose;
    if (from === target) return;
    this.queue = [`tr_${from}_${target}`, `loop_${target}`];
    this.endAtBoundary();
    this.sync();
  }

  /** 打断：当前片段还没播完就换成别的，按这只猫的衔接方式处理 */
  interrupt(target: string): void {
    const t0 = performance.now();
    emit('interrupt', { id: this.id, mode: this.mode, from: this.cur.clip.id, frame: this.cur.frame, target });
    switch (this.mode) {
      case 'crossfade':
        this.queue = [];
        this.playNow(`loop_${target}`, { fade: true, measureFrom: t0, mode: 'crossfade' });
        break;
      case 'hardcut':
        this.queue = [];
        this.playNow(`loop_${target}`, { measureFrom: t0, mode: 'hardcut' });
        this.poof();
        break;
      case 'transition': {
        const from = this.endPose;
        this.queue = from === target ? [] : [`tr_${from}_${target}`, `loop_${target}`];
        if (from === target && this.cur.clip.kind === 'loop') return;
        this.interruptT0 = t0;
        this.interruptMode = 'transition';
        this.endAtBoundary();
        this.sync();
        break;
      }
    }
  }

  /** 拎起：拖动必须立刻有反应，所以"过渡片段"方式也不等，直接切进 X→悬空 的过渡片段 */
  pickup(): void {
    this.dragging = true;
    if (this.mode === 'transition') {
      const from = this.cur.clip.kind === 'loop' ? this.cur.clip.fromPose : this.endPose;
      if (from === 'hang') return;
      this.queue = ['loop_hang'];
      this.playNow(`tr_${from}_hang`, { measureFrom: performance.now(), mode: 'transition' });
    } else {
      this.interrupt('hang');
    }
  }

  drop(): void {
    this.dragging = false;
    this.queue = ['loop_stand'];
    this.playNow('tr_hang_stand');
  }

  poof(): void {
    this.poofStart = performance.now();
  }

  update(now: number): void {
    if (this.fade) {
      const t = Math.min(1, (now - this.fade.start) / CROSSFADE_MS);
      this.curSprite.alpha = smooth(t);
      this.fade.sprite.alpha = 1 - smooth(t);
      if (t >= 1) this.finishFade();
    }
    this.fx.clear();
    if (this.poofStart) {
      const t = (now - this.poofStart) / POOF_MS;
      if (t >= 1) this.poofStart = 0;
      else {
        // 硬切时的小特效：一团向外扩散的"烟"，盖住身体中段
        const cy = -M.size * (M.footAnchor[1] - 0.58) * this.scale;
        for (let i = 0; i < 7; i++) {
          const a = (i / 7) * Math.PI * 2;
          const r = (18 + 40 * smooth(t)) * this.scale * 1.6;
          this.fx
            .circle(Math.cos(a) * r * 0.9, cy + Math.sin(a) * r * 0.6, (34 - 14 * t) * this.scale * 1.6)
            .fill({ color: 0xf4f0e8, alpha: 0.85 * (1 - t) });
        }
      }
    }
  }

  // 窗口坐标 → 片段像素坐标
  private toClip(px: number, py: number): Point {
    return {
      x: (px - this.root.x) / this.scale + M.footAnchor[0] * M.size,
      y: (py - this.root.y) / this.scale + M.footAnchor[1] * M.size,
    };
  }
  private fromCell(mx: number, my: number): Point {
    const s = M.mask.scale;
    return {
      x: this.root.x + ((mx + 0.5) * s - M.footAnchor[0] * M.size) * this.scale,
      y: this.root.y + ((my + 0.5) * s - M.footAnchor[1] * M.size) * this.scale,
    };
  }
  cellAt(px: number, py: number): number {
    const c = this.toClip(px, py);
    if (c.x < 0 || c.y < 0 || c.x >= M.size || c.y >= M.size) return -1;
    return Math.floor(c.y / M.mask.scale) * M.mask.width + Math.floor(c.x / M.mask.scale);
  }

  /** 按当前帧的点击遮罩判断 (px, py) 是否落在猫的不透明像素上 */
  hit(px: number, py: number): boolean {
    const idx = this.cellAt(px, py);
    if (idx < 0) return false;
    if (maskBit(this.cur.clip.id, this.cur.frame, idx)) return true;
    return this.fade !== null && maskBit(this.fade.player.clip.id, this.fade.player.frame, idx);
  }

  /** 当前片段所有帧都不透明（always=true）或任一帧不透明的判断 */
  covers(px: number, py: number, always: boolean): boolean {
    const idx = this.cellAt(px, py);
    if (idx < 0) return false;
    const s = summaryOf(this.cur.clip.id);
    return (always ? s.and : s.or)[idx] === 1;
  }

  info(all: Cat[]): CatInfo {
    const W = M.mask.width;
    const { and, or } = summaryOf(this.cur.clip.id);
    const solid = (arr: Uint8Array, mx: number, my: number, v: number): boolean => {
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const x = mx + dx;
          const y = my + dy;
          if (x < 0 || y < 0 || x >= W || y >= W || arr[y * W + x] !== v) return false;
        }
      return true;
    };
    let minX = W;
    let minY = W;
    let maxX = -1;
    let maxY = -1;
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let i = 0; i < and.length; i++) {
      const mx = i % W;
      const my = (i / W) | 0;
      if (or[i]) {
        minX = Math.min(minX, mx);
        maxX = Math.max(maxX, mx);
        minY = Math.min(minY, my);
        maxY = Math.max(maxY, my);
      }
      if (and[i]) {
        sx += mx;
        sy += my;
        n++;
      }
    }
    const cx = sx / Math.max(1, n);
    const cy = sy / Math.max(1, n);
    const others = all.filter((c) => c !== this);
    let core: Point | null = null;
    let exclusive: Point | null = null;
    let shared: CatInfo['shared'] = null;
    let gap: Point | null = null;
    let bestCore = Infinity;
    let bestEx = Infinity;
    let bestShared = Infinity;
    let bestGap = Infinity;
    for (let my = 1; my < W - 1; my++) {
      for (let mx = 1; mx < W - 1; mx++) {
        const d = (mx - cx) ** 2 + (my - cy) ** 2;
        if (solid(and, mx, my, 1)) {
          const p = this.fromCell(mx, my);
          if (d < bestCore) {
            bestCore = d;
            core = p;
          }
          const coveredBy = others.find((o) => o.covers(p.x, p.y, false));
          if (!coveredBy && d < bestEx) {
            bestEx = d;
            exclusive = p;
          }
          const both = others.find((o) => o.covers(p.x, p.y, true));
          if (both && d < bestShared) {
            bestShared = d;
            shared = { with: both.id, point: p };
          }
        } else if (my > minY + (maxY - minY) * 0.6 && my < maxY && solid(or, mx, my, 0) && !others.some((o) => o.covers(this.fromCell(mx, my).x, this.fromCell(mx, my).y, false))) {
          // 猫的包围框下半部分、左右两边都有猫的像素的透明点：比如腿和腿之间
          let left = false;
          let right = false;
          for (let x = minX; x < mx; x++) left ||= or[my * W + x] === 1;
          for (let x = mx + 1; x <= maxX; x++) right ||= or[my * W + x] === 1;
          const dg = Math.abs(mx - (minX + maxX) / 2);
          if (left && right && dg < bestGap) {
            bestGap = dg;
            gap = this.fromCell(mx, my);
          }
        }
      }
    }
    const tl = this.fromCell(minX, minY);
    const br = this.fromCell(maxX, maxY);
    const bbox: Rect = { x: tl.x, y: tl.y, width: br.x - tl.x, height: br.y - tl.y };
    return {
      id: this.id,
      mode: this.mode,
      clip: this.cur.clip.id,
      frame: this.cur.frame,
      foot: { x: this.root.x, y: this.root.y },
      scale: this.scale,
      z: this.z,
      alpha: this.body.alpha,
      dragging: this.dragging,
      bbox,
      core,
      gap,
      exclusive,
      shared,
    };
  }

  pause(): void {
    for (const p of this.players.values()) if (!p.video.paused) p.video.pause();
  }
  resume(): void {
    this.cur.video.play().catch(() => undefined);
  }
}

// ---- 场景 ----
const TINTS = [0xffcf8a, 0xfff0b0, 0xcdb8a6];
let app: Application;
const cats: Cat[] = [];
const hud = new Text({ text: '', style: { fontSize: 12, fill: 0xffffff, fontFamily: 'Consolas, monospace', stroke: { color: 0x000000, width: 3 } } });
let layout: Layout = 'normal';
let ghost = false;
let paused = false;
let fullness = 100;
let naiveFullness = 100;
let naiveFrameFullness = 100;
let preload: Preload = 'all';

function sortByDepth(): void {
  cats.sort((a, b) => a.z - b.z);
  cats.forEach((c, i) => app.stage.setChildIndex(c.root, i));
}

function topCatAt(x: number, y: number): Cat | null {
  if (ghost) return null;
  for (let i = cats.length - 1; i >= 0; i--) if (cats[i].hit(x, y)) return cats[i];
  return null;
}

function place(p: CatPlacement): void {
  const cat = cats.find((c) => c.id === p.id);
  if (!cat) return;
  cat.root.position.set(p.x, p.y);
  if (p.scale) cat.setScale(p.scale);
  cat.z = p.z ?? p.y;
}

function applyLayout(l: Layout): void {
  layout = l;
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (l === 'normal') {
    const xs = [0.62, 0.72, 0.82];
    cats.forEach((c, i) => {
      place({ id: c.id, x: w * xs[i], y: h - 12 - i * 6, scale: [0.6, 0.55, 0.64][i] });
      c.behaviors = true;
      c.setLabel('');
    });
  } else if (l === 'demo') {
    cats.forEach((c, i) => {
      place({ id: c.id, x: w / 2 + (i - 1) * 260, y: h * 0.62, scale: 0.8, z: i });
      c.behaviors = false;
      c.mode = INTERRUPT_MODES[i];
      c.setLabel(INTERRUPT_MODE_LABEL[c.mode]);
    });
  } else {
    cats.forEach((c) => {
      c.behaviors = false;
      c.setLabel(c.id);
    });
  }
  sortByDepth();
}

// ---- 鼠标 ----
const mouse = { x: -1, y: -1, inside: false, moves: 0 };
let lastHover = false;
let lastHoverSent = 0;
let press: { cat: Cat; x0: number; y0: number; dx: number; dy: number; moved: boolean; pointerId: number } | null =
  null;

function updateHover(): void {
  const hit = press !== null || (!paused && mouse.inside && topCatAt(mouse.x, mouse.y) !== null);
  const now = performance.now();
  if (hit !== lastHover || (hit && now - lastHoverSent > 50)) {
    send('hover', hit);
    lastHover = hit;
    lastHoverSent = now;
  }
}

window.addEventListener('mousemove', (e) => {
  mouse.x = e.clientX;
  mouse.y = e.clientY;
  mouse.inside = true;
  mouse.moves++;
  updateHover();
});
// 注意：不能用 mouseleave 判断鼠标离开。鼠标穿透 + 转发时，Chromium 会在转发的 mousemove 之后误发 mouseleave，
// 导致第一次移到猫身上时判定失效（实测）。鼠标离开桌面层范围由主进程检查光标位置来处理。

window.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const cat = topCatAt(e.clientX, e.clientY);
  if (!cat) {
    // 窗口没在穿透状态，但点在了透明处：这次点击被桌面层"吃掉"了，下面的窗口收不到
    emit('missClick', { x: e.screenX, y: e.screenY });
    return;
  }
  document.documentElement.setPointerCapture(e.pointerId);
  press = {
    cat,
    x0: e.clientX,
    y0: e.clientY,
    dx: cat.root.x - e.clientX,
    dy: cat.root.y - e.clientY,
    moved: false,
    pointerId: e.pointerId,
  };
  send('drag', true);
  emit('catDown', { id: cat.id, x: e.screenX, y: e.screenY, ctrl: e.ctrlKey });
});

window.addEventListener('pointermove', (e) => {
  if (!press) return;
  if (!press.moved && Math.hypot(e.clientX - press.x0, e.clientY - press.y0) > 4) {
    press.moved = true;
    press.cat.pickup();
    press.cat.z = 1e6;
    sortByDepth();
    emit('pickup', { id: press.cat.id });
  }
  if (press.moved) press.cat.root.position.set(e.clientX + press.dx, e.clientY + press.dy);
});

function release(reason: string, sx?: number, sy?: number): void {
  if (!press) return;
  const { cat, moved } = press;
  try {
    document.documentElement.releasePointerCapture(press.pointerId);
  } catch {
    /* 已经释放 */
  }
  press = null;
  if (moved) {
    cat.drop();
    cat.z = cat.root.y;
    sortByDepth();
    emit('drop', { id: cat.id, reason, x: sx, y: sy, foot: { x: cat.root.x, y: cat.root.y } });
  } else {
    emit('catClick', { id: cat.id });
    if (cat.behaviors) cat.interrupt(cat.endPose === 'sit' ? 'stand' : 'sit');
  }
  send('drag', false);
  updateHover();
}
window.addEventListener('pointerup', (e) => release('pointerup', e.screenX, e.screenY));
window.addEventListener('pointercancel', () => release('pointercancel'));

// ---- 主进程消息 ----
let hiddenSince: {
  t: number;
  interval: number;
  raf: number;
  rvfc: number;
  naive: number;
  naiveFrame: number;
  wall: number;
} | null =
  null;

on('ghost', (g) => {
  ghost = g;
  for (const c of cats) c.body.alpha = g ? GHOST_ALPHA : 1;
  updateHover();
});
on('dragCancel', () => release('watchdog'));
on('snapshot', (s) => {
  fullness = s.fullness;
});
on('paused', (p) => {
  if (p === paused) return;
  paused = p;
  if (p) {
    app.ticker.stop();
    for (const c of cats) c.pause();
    hiddenSince = { t: Date.now(), ...counters, naive: naiveFullness, naiveFrame: naiveFrameFullness, wall: fullness };
  } else {
    for (const c of cats) c.resume();
    app.ticker.start();
    const h = hiddenSince;
    hiddenSince = null;
    if (h) {
      const hiddenMs = Date.now() - h.t;
      // 等主进程下一次推送快照，再比较"按真实时间"和"按计时器次数"两种结算
      setTimeout(() => {
        const report: HiddenReport = {
          hiddenMs,
          intervalTicks: counters.interval - h.interval,
          expectedIntervalTicks: Math.floor(hiddenMs / 1000),
          rafTicks: counters.raf - h.raf,
          rvfcTicks: counters.rvfc - h.rvfc,
          naiveFullnessDrop: h.naive - naiveFullness,
          naiveFrameFullnessDrop: h.naiveFrame - naiveFrameFullness,
          wallFullnessDrop: h.wall - fullness,
        };
        send('hiddenReport', report);
      }, 1100);
    }
  }
});
on('cmd', (c) => {
  switch (c.type) {
    case 'mode':
      for (const cat of cats) if (layout !== 'demo') cat.mode = c.mode as InterruptMode;
      break;
    case 'interruptAll':
      for (const cat of cats) cat.interrupt(cat.endPose === 'sit' ? 'stand' : 'sit');
      break;
    case 'interrupt': {
      const cat = cats.find((x) => x.id === c.id);
      cat?.interrupt(String(c.target));
      break;
    }
    case 'layout':
      applyLayout(c.layout as Layout);
      for (const p of (c.cats as CatPlacement[] | undefined) ?? []) place(p);
      sortByDepth();
      break;
    case 'hud':
      hud.visible = Boolean(c.on);
      break;
    case 'hang': {
      // 故意让渲染进程卡住一段时间，验证主进程的防卡死兜底
      const until = performance.now() + Number(c.ms);
      while (performance.now() < until) {
        /* busy */
      }
      break;
    }
  }
});

// ---- 启动 ----
let demoTimer = 0;
on('config', async (cfg) => {
  M = await api.manifest();
  for (const c of M.clips) clips.set(c.id, c);
  maskFrameBytes = Math.ceil((M.mask.width * M.mask.height) / 8);
  await Promise.all(M.clips.map(async (c) => masks.set(c.id, new Uint8Array(await api.readMask(c.mask)))));

  app = new Application();
  await app.init({
    backgroundAlpha: 0,
    resizeTo: window,
    antialias: false,
    resolution: cfg.res || window.devicePixelRatio,
    autoDensity: true,
    preference: 'webgl',
    // 双显卡笔记本上，WebGL 的 powerPreference 决定 Chromium 用核显还是独显（见验证报告）
    powerPreference: cfg.power === 'default' ? undefined : cfg.power,
  });
  document.body.appendChild(app.canvas);

  for (let i = 0; i < 3; i++) {
    const cat = new Cat(`cat-${'abc'[i]}`, cfg.mode, TINTS[i]);
    cats.push(cat);
    app.stage.addChild(cat.root);
  }
  preload = cfg.preload;
  if (preload === 'all') await Promise.all(cats.map((c) => c.preloadAll()));
  else await Promise.all(cats.map((c) => c.player('loop_stand').ready));
  if (cfg.fps) app.ticker.maxFPS = cfg.fps;
  for (const c of cats) c.playNow('loop_stand');
  applyLayout(cfg.layout);
  hud.visible = cfg.hud;
  hud.position.set(8, 8);
  app.stage.addChild(hud);

  app.ticker.add(() => {
    const now = performance.now();
    for (const c of cats) {
      c.update(now);
      if (c.behaviors && !c.dragging && now > c.nextBehaviorAt) {
        if (c.nextBehaviorAt && c.cur.clip.kind === 'loop' && c.cur.clip.fromPose !== 'hang') {
          c.goToPose(c.endPose === 'stand' ? 'sit' : 'stand');
        }
        c.nextBehaviorAt = now + 4000 + Math.random() * 5000;
      }
    }
    updateHover();
    if (hud.visible) {
      const s = stats();
      hud.text = [
        `TTCats 桌面层小样  布局=${layout}  幽灵=${ghost ? '开' : '关'}  FPS=${app.ticker.FPS.toFixed(0)}`,
        `衔接方式：${cats.map((c) => INTERRUPT_MODE_LABEL[c.mode]).join(' / ')}`,
        `饱腹（主进程按真实时间）=${fullness.toFixed(2)}   按计时器次数累加=${naiveFullness.toFixed(2)}`,
        `片段切换 ${s.count} 次，首帧平均 ${s.avgMs.toFixed(1)}ms，最大 ${s.maxMs.toFixed(1)}ms`,
        ...cats.map((c) => `${c.id}: ${c.cur.clip.id} #${c.cur.frame}`),
      ].join('\n');
    }
  });

  setInterval(() => {
    counters.interval++;
    naiveFullness -= 1 / 60;
  }, 1000);
  const raf = (): void => {
    counters.raf++;
    naiveFrameFullness -= 1 / 3600; // "每帧 1/60 秒"的错误做法
    requestAnimationFrame(raf);
  };
  requestAnimationFrame(raf);
  setInterval(() => {
    if (!paused) send('cats', { cats: cats.map((c) => c.info(cats)), switchStats: stats(), mouse: { ...mouse, hover: lastHover } });
  }, 100);

  if (cfg.layout === 'demo') {
    demoTimer = window.setInterval(() => {
      for (const c of cats) c.interrupt(c.endPose === 'sit' ? 'stand' : 'sit');
    }, 2600);
  }
  emit('rendererReady', { demoTimer });
});

function stats(): SwitchStats {
  const avg = (a: number[]): number | null => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  return {
    count: switchLatencies.length,
    avgMs: avg(switchLatencies) ?? 0,
    maxMs: switchLatencies.length ? Math.max(...switchLatencies) : 0,
    interruptLatencyAvgMs: {
      crossfade: avg(interruptLatencies.crossfade),
      hardcut: avg(interruptLatencies.hardcut),
      transition: avg(interruptLatencies.transition),
    },
  };
}
