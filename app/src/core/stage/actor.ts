// 一只猫在桌面层里的画面状态：在哪、正在播哪个片段、接下来要播什么。
//
// 计划是一串步骤（Step）。步骤要求的开始姿势和猫当前的姿势对不上时，自动按姿势网络插入过渡片段；
// 走不通时才硬切（ADR-0002）。计划播完，就按性格参数选下一个行为。
//
// 时间全部按真实经过的毫秒数推进，不按帧数累加（ADR-0004）。片段时间 = 真实时间 × 播放速度。
import type { CatPlacement, StageEffect } from '../../shared/core-api';
import type { ActivityLevel, BasePose, Cat, Clip, Pose } from '../../shared/schemas';
import {
  chooseBehavior,
  COMMANDED_SLEEP_MS,
  restDurationMs,
  SUMMON_WAIT_MS,
  type Behavior,
} from './behavior';
import { clamp01, STANDARD_CAT_HEIGHT, type Floor } from './floor';
import { ClipLibrary, clipDurationMs, isBasePose, PoseGraph, REST_LOOPS } from './pose-graph';
import { pick, uniform, type Random } from './random';

export type Facing = 'left' | 'right';

/** 计划里的一步。 */
export type Step =
  /** 播一个片段。循环片段播 holdMs 左右（取整到整遍），不写就播一遍。 */
  | { kind: 'clip'; name: string; variant?: number; holdMs?: number }
  /** 用走路或奔跑片段，在地板上移动到 (x, d) 附近。 */
  | { kind: 'move'; gait: 'walk' | 'run'; x: number; d: number }
  /** 转身朝向某个 x。 */
  | { kind: 'face'; towardX: number };

/** 打断方式（ADR-0002）：soft 等当前片段回到姿势再换；cut 立刻硬切，并放一个小特效盖住切换处。 */
export type InterruptMode = 'soft' | 'cut';

/** 一个片段开始播放的记录，给测试检查衔接用。 */
export interface SegmentInfo {
  clip: Clip;
  /** 是不是硬切进来的（姿势可能对不上）。 */
  cut: boolean;
  mirrored: boolean;
  rate: number;
}

export interface StageObserver {
  segmentStarted(cat: string, segment: SegmentInfo, at: number): void;
}

/** 所有猫共用的环境。由 StageCore 在设置、屏幕大小变化时更新。 */
export interface ActorEnv {
  readonly random: Random;
  floor: Floor;
  /** 用户设置的缩放。 */
  scale: number;
  activityLevel: ActivityLevel;
  addEffect(effect: StageEffect, x: number, y: number, at: number): void;
  readonly observer?: StageObserver | undefined;
}

/** 播放速度的浮动范围（D7）。 */
export const PLAYBACK_RATE_RANGE: readonly [number, number] = [0.9, 1.1];
/** 斜着走时，纵向位移最多是横向位移的几倍。再陡，侧面走路的片段就像在滑。 */
export const MAX_WALK_SLOPE = 0.4;
/** 召唤时离目标超过这么远（标准猫身高的几倍）就跑过去，前提是有奔跑片段。 */
const RUN_DISTANCE_RATIO = 3;
/** 散步至少走多远（标准猫身高的几倍）。 */
const MIN_WANDER_RATIO = 0.5;
/** 调试台播放循环片段时播多久。 */
const DEBUG_LOOP_MS = 6_000;
/** 一次推进里最多处理多少个片段边界，防止坏数据让循环停不下来。 */
const MAX_ADVANCE_STEPS = 10_000;

interface Move {
  fromX: number;
  fromD: number;
  toX: number;
  toD: number;
  dir: 1 | -1;
  /** 已经要求停下：到下一个循环边界就停。 */
  stop: boolean;
  /** 这一遍开始时的 x。也用来发现被屏幕边挡住、原地踏步的情况。 */
  cycleStartX: number;
  /**
   * 这一遍的移动速度（像素 / 片段毫秒），在每一遍开始时按当时的远近缩放算好，这一遍里不变。
   * 这样位置只取决于这一遍播了多久，不受 update 怎么分段影响（ADR-0004）。
   */
  cycleSpeed: number;
}

interface Segment {
  clip: Clip;
  rate: number;
  mirrored: boolean;
  /** 已经播了多久（片段时间，毫秒）。 */
  elapsed: number;
  /** 播到这里结束（片段时间，毫秒）。移动时是下一个循环边界。 */
  end: number;
  move?: Move;
}

export class CatActor {
  readonly id: string;
  readonly library: ClipLibrary;
  readonly graph: PoseGraph;
  x: number;
  d: number;
  facing: Facing;
  behavior: Behavior = { kind: 'idle' };
  /** 当前片段开始时的姿势；片段播完后是它的结束姿势。 */
  private pose: Pose = 'stand';
  private seg: Segment;
  private queue: Step[] = [];
  private lastAction: string | undefined;
  /** 下一个开始的片段是硬切进来的。 */
  private cutPending = false;
  private readonly lastVariant = new Map<string, number>();
  private held = false;
  private airY: number | undefined;
  private fall: { fromY: number; elapsedMs: number } | undefined;

  constructor(
    readonly cat: Cat,
    clips: readonly Clip[],
    private readonly env: ActorEnv,
    start: { x: number; d: number; facing: Facing; now: number },
  ) {
    this.id = cat.id;
    this.library = new ClipLibrary(clips);
    this.graph = new PoseGraph(this.library);
    this.x = start.x;
    this.d = start.d;
    this.facing = start.facing;
    this.seg = this.makeSegment(this.requireClip(REST_LOOPS.stand), {});
    this.startNext(start.now);
  }

  // ---------- 推进 ----------

  /**
   * 从 from 推进到 to。catchUp 表示这是隐藏后恢复之类的长间隔：
   * 当前的计划照真实时间推进完（不画出来），但不再接着选新行为补播，新行为从 to 开始。
   */
  advance(from: number, to: number, catchUp: boolean): void {
    if (this.held || this.fall !== undefined) {
      this.seg.elapsed =
        (this.seg.elapsed + (to - from) * this.seg.rate) % clipDurationMs(this.seg.clip);
      if (this.fall === undefined) return;
      const floorY = this.env.floor.yAt(this.d);
      // 从静止下落，不继承鼠标速度（D5 不做甩飞）。
      const gravity = STANDARD_CAT_HEIGHT * this.finalScale() * 12;
      const landingMs = Math.sqrt((2 * Math.max(0, floorY - this.fall.fromY)) / gravity) * 1000;
      this.fall.elapsedMs += to - from;
      this.airY = Math.min(
        floorY,
        this.fall.fromY + (gravity * (this.fall.elapsedMs / 1000) ** 2) / 2,
      );
      if (this.fall.elapsedMs < landingMs) return;
      const landedAt = to - (this.fall.elapsedMs - landingMs);
      this.fall = undefined;
      this.airY = undefined;
      this.react('land', { kind: 'dropped' }, false, landedAt);
      this.advance(landedAt, to, catchUp);
      return;
    }
    let t = from;
    for (let guard = 0; t < to && guard < MAX_ADVANCE_STEPS; guard++) {
      const seg = this.seg;
      const realRemaining = (seg.end - seg.elapsed) / seg.rate;
      if (to - t < realRemaining) {
        this.progress(seg, to - t);
        return;
      }
      this.progress(seg, realRemaining);
      seg.elapsed = seg.end;
      t += realRemaining;
      if (seg.move !== undefined && this.continueMove(seg, seg.move)) continue;
      this.pose = seg.clip.toPose;
      if (catchUp && this.queue.length === 0) {
        this.startNext(to);
        return;
      }
      this.startNext(t);
    }
  }

  private progress(seg: Segment, dtMs: number): void {
    if (dtMs <= 0) return;
    seg.elapsed += dtMs * seg.rate;
    const move = seg.move;
    if (move === undefined) return;
    const cycleStart = seg.end - clipDurationMs(seg.clip);
    this.x = this.env.floor.clampX(
      move.cycleStartX + move.dir * move.cycleSpeed * (seg.elapsed - cycleStart),
      this.cat.relativeSize,
    );
    if (move.toX !== move.fromX) {
      const along = (this.x - move.fromX) / (move.toX - move.fromX);
      this.d = clamp01(move.fromD + (move.toD - move.fromD) * along);
    }
  }

  /** 走完一遍时决定要不要再走一遍。只在循环边界上停，猫才会停在站姿上。 */
  private continueMove(seg: Segment, move: Move): boolean {
    const cycle = this.cycleDistance(seg.clip);
    const remaining = (move.toX - this.x) * move.dir;
    const stuck = Math.abs(this.x - move.cycleStartX) < 1e-6;
    if (move.stop || stuck || remaining < cycle / 2) return false;
    move.cycleStartX = this.x;
    move.cycleSpeed = this.cycleSpeed(seg.clip);
    seg.end += clipDurationMs(seg.clip);
    return true;
  }

  // ---------- 计划 ----------

  /** 当前计划播完了，接着播下一步；没有下一步就按性格选新行为。 */
  private startNext(t: number): void {
    for (let guard = 0; guard < 32; guard++) {
      const step = this.queue.shift();
      if (step === undefined) {
        this.planAutonomous();
        continue;
      }
      if (this.startStep(step, t)) return;
    }
    // 坏数据导致一直排不出片段：在最近能待着的姿势里待着，实在不行硬切回站着
    const rest = this.restPose();
    if (this.pose !== rest) this.hardCut(rest, t);
    this.beginSegment(this.requireClip(REST_LOOPS[rest]), t, { holdMs: DEBUG_LOOP_MS });
  }

  private planAutonomous(): void {
    const rest = this.restPose();
    const behavior = chooseBehavior(this.env.random, {
      personality: this.cat.personality,
      pose: rest,
      library: this.library,
      lastAction: this.lastAction,
    });
    this.behavior = behavior;
    switch (behavior.kind) {
      case 'idle':
        this.queue = [this.restStep(rest)];
        break;
      case 'rest':
        this.queue = [this.restStep(behavior.pose)];
        break;
      case 'wander':
        this.queue = [{ kind: 'move', gait: 'walk', ...this.wanderTarget() }];
        break;
      case 'action':
        this.queue = [{ kind: 'clip', name: behavior.clip }];
        break;
    }
  }

  private restStep(pose: BasePose): Step {
    const holdMs = restDurationMs(
      this.env.random,
      pose,
      this.cat.personality,
      this.env.activityLevel,
    );
    return { kind: 'clip', name: REST_LOOPS[pose], holdMs };
  }

  /** 散步的目标：地板上随机一处，不太近，坡度不太陡。 */
  private wanderTarget(): { x: number; d: number } {
    const floor = this.env.floor;
    const walk = this.library.first('walk');
    const half = walk === undefined ? 0 : this.cycleDistance(walk) / 2;
    const range = floor.xRange(this.cat.relativeSize);
    const min = Math.min(range.min + half, (range.min + range.max) / 2);
    const max = Math.max(range.max - half, min);
    const minDistance = MIN_WANDER_RATIO * STANDARD_CAT_HEIGHT * this.env.scale;
    let x = this.x;
    for (let i = 0; i < 4; i++) {
      x = uniform(this.env.random, min, max);
      if (Math.abs(x - this.x) >= minDistance) break;
    }
    return { x, d: uniform(this.env.random, 0, 1) };
  }

  /** 开始一步。开始了一个片段就返回 true；这一步不用播片段（或者先插了过渡片段）就返回 false。 */
  private startStep(step: Step, t: number): boolean {
    switch (step.kind) {
      case 'face':
        if (step.towardX !== this.x) this.facing = step.towardX < this.x ? 'left' : 'right';
        return false;
      case 'clip': {
        const first = this.library.first(step.name);
        if (first === undefined) return false;
        if (!this.reachPose(first.fromPose, step, t)) return false;
        const clip = this.pickVariant(step.name, step.variant);
        if (clip === undefined) return false;
        this.beginSegment(clip, t, step.holdMs === undefined ? {} : { holdMs: step.holdMs });
        return true;
      }
      case 'move':
        return this.startMove(step, t);
    }
  }

  /**
   * 让猫处在 pose 上。不在的话，能走通就把过渡片段插到 step 前面（返回 false，下一轮再播 step）；
   * 走不通就硬切过去（返回 true，接着播 step）。
   */
  private reachPose(pose: Pose, step: Step, t: number): boolean {
    if (this.pose === pose) return true;
    const path = this.graph.path(this.pose, pose);
    if (path !== undefined && path.length > 0) {
      this.queue.unshift(...path.map((name): Step => ({ kind: 'clip', name })), step);
      return false;
    }
    this.hardCut(pose, t);
    return true;
  }

  private startMove(step: Extract<Step, { kind: 'move' }>, t: number): boolean {
    const toX = this.env.floor.clampX(step.x, this.cat.relativeSize);
    if (toX === this.x) return false;
    const dir = toX > this.x ? 1 : -1;
    const facing = dir > 0 ? 'right' : 'left';
    // 奔跑没有能朝这边的版本就改成走路；走路也没有，就不走，免得画面朝一边、身子往另一边滑
    const gaits = step.gait === 'run' && this.canRun() ? ['run', 'walk'] : ['walk'];
    const gait = gaits.find((name) =>
      this.library.variants(name).some((clip) => canMoveToward(clip, facing)),
    );
    if (gait === undefined) return false;
    if (!this.reachPose('stand', step, t)) return false;
    this.facing = facing;
    const clip = this.pickVariant(gait, undefined, true);
    if (clip === undefined) return false;
    if (Math.abs(toX - this.x) < this.cycleDistance(clip) / 2) return false;
    // 坡度限制：纵向位移不超过横向位移的 MAX_WALK_SLOPE 倍
    const band = this.env.floor.band;
    const maxDd = band > 0 ? (MAX_WALK_SLOPE * Math.abs(toX - this.x)) / band : 1;
    const toD = Math.min(this.d + maxDd, Math.max(this.d - maxDd, clamp01(step.d)));
    this.beginSegment(clip, t, {
      move: {
        fromX: this.x,
        fromD: this.d,
        toX,
        toD,
        dir,
        stop: false,
        cycleStartX: this.x,
        cycleSpeed: this.cycleSpeed(clip),
      },
    });
    return true;
  }

  private canRun(): boolean {
    const run = this.library.first('run');
    return run !== undefined && run.speed > 0;
  }

  /**
   * 按朝向挑一个版本：优先能朝这个方向的；有多个版本时不连续用同一个（D7）。
   * forMove 时只挑能朝移动方向、而且真的会移动的版本。
   */
  private pickVariant(name: string, variant?: number, forMove = false): Clip | undefined {
    let options = this.library.variants(name).filter((c) => c.fromPose === this.pose);
    if (forMove) options = options.filter((c) => canMoveToward(c, this.facing));
    const exact = options.find((c) => c.variant === variant);
    if (exact !== undefined) return exact;
    const facingOk = options.filter((c) => c.facing === this.facing || c.mirrorable);
    if (facingOk.length > 0) options = facingOk;
    const last = this.lastVariant.get(name);
    if (options.length > 1) options = options.filter((c) => c.variant !== last);
    return pick(this.env.random, options);
  }

  private makeSegment(clip: Clip, opts: { holdMs?: number; move?: Move }): Segment {
    const rate = uniform(this.env.random, ...PLAYBACK_RATE_RANGE);
    const duration = clipDurationMs(clip);
    let end = duration;
    if (clip.kind === 'loop' && opts.holdMs !== undefined && opts.move === undefined) {
      end = Math.max(1, Math.round((opts.holdMs * rate) / duration)) * duration;
    }
    let mirrored = false;
    if (clip.facing !== this.facing) {
      if (clip.mirrorable) mirrored = true;
      // 不能镜像、也没有朝这边的版本：猫只好转过身来
      else this.facing = clip.facing;
    }
    const seg: Segment = { clip, rate, mirrored, elapsed: 0, end };
    if (opts.move !== undefined) seg.move = opts.move;
    return seg;
  }

  private beginSegment(clip: Clip, t: number, opts: { holdMs?: number; move?: Move }): void {
    this.seg = this.makeSegment(clip, opts);
    const cut = this.cutPending;
    this.cutPending = false;
    this.pose = clip.fromPose;
    this.lastVariant.set(clip.name, clip.variant);
    if (clip.kind === 'action') this.lastAction = clip.name;
    this.env.observer?.segmentStarted(
      this.id,
      { clip, cut, mirrored: this.seg.mirrored, rate: this.seg.rate },
      t,
    );
  }

  // ---------- 打断 ----------

  /**
   * 换成新的计划。soft：等当前片段回到姿势（循环片段到这一遍结束）再换；
   * cut：立刻换。当前片段不在姿势上时，放一个小特效盖住切换处（ADR-0002）。
   */
  interrupt(steps: Step[], behavior: Behavior, mode: InterruptMode, t: number): void {
    this.held = false;
    this.behavior = behavior;
    this.queue = steps;
    const seg = this.seg;
    const duration = clipDurationMs(seg.clip);
    if (mode === 'soft') {
      if (seg.move !== undefined) seg.move.stop = true;
      if (seg.clip.kind === 'loop') {
        seg.end = Math.min(seg.end, Math.ceil(seg.elapsed / duration) * duration);
      }
      return;
    }
    const frame = 1000 / seg.clip.fps;
    const inClip = seg.clip.kind === 'loop' ? seg.elapsed % duration : seg.elapsed;
    const atPose = inClip < frame || duration - inClip < frame;
    if (!atPose) {
      this.addCutEffect(t);
      this.cutPending = true;
    }
    // 过渡片段播了一半以上，就当它已经到了结束姿势
    this.pose =
      seg.clip.kind === 'transition' && seg.elapsed >= duration / 2
        ? seg.clip.toPose
        : seg.clip.fromPose;
    this.startNext(t);
  }

  /** 召唤：走（或跑）到 (x, d)，转向 towardX，再站着等一会儿。 */
  summon(x: number, d: number, towardX: number, t: number): void {
    const far = Math.abs(x - this.x) > RUN_DISTANCE_RATIO * STANDARD_CAT_HEIGHT * this.env.scale;
    const holdMs = uniform(this.env.random, ...SUMMON_WAIT_MS);
    this.interrupt(
      [
        { kind: 'move', gait: far ? 'run' : 'walk', x, d },
        { kind: 'face', towardX },
        { kind: 'clip', name: REST_LOOPS.stand, holdMs },
      ],
      { kind: 'summon' },
      'cut',
      t,
    );
  }

  /** 让猫睡觉。已经在睡的就接着睡，不打断。 */
  sleep(t: number): void {
    const holdMs = uniform(this.env.random, ...COMMANDED_SLEEP_MS);
    const steps: Step[] = [{ kind: 'clip', name: REST_LOOPS.sleep, holdMs }];
    const asleep = this.seg.clip.name === REST_LOOPS.sleep && this.pose === 'sleep';
    this.interrupt(steps, { kind: 'sleepCommand' }, asleep ? 'soft' : 'cut', t);
  }

  /** 调试台播放任意片段。猫咪包里没有这个片段时返回 false，什么也不做。 */
  playDebugClip(name: string, variant: number | undefined, t: number): boolean {
    const first = this.library.first(name);
    if (first === undefined) return false;
    const step: Extract<Step, { kind: 'clip' }> = { kind: 'clip', name };
    if (variant !== undefined) step.variant = variant;
    if (first.kind === 'loop') step.holdMs = DEBUG_LOOP_MS;
    this.interrupt([step], { kind: 'debugClip', clip: name }, 'cut', t);
    return true;
  }

  /** 鼠标反应直接切到目标片段，不先排姿势过渡；held 时只循环，不选自主行为。 */
  react(name: string, behavior: Behavior, held: boolean, t: number): void {
    const first = this.library.first(name);
    if (first === undefined) return;
    this.queue = [];
    this.behavior = behavior;
    this.hardCut(first.fromPose, t);
    const clip = this.pickVariant(name) ?? first;
    this.beginSegment(clip, t, {});
    this.held = held;
  }

  releaseReaction(t: number): void {
    this.held = false;
    this.interrupt([this.restStep(this.restPose())], { kind: 'idle' }, 'soft', t);
  }

  pickUp(t: number): boolean {
    if (!this.library.has('dangle') || !this.library.has('land')) return false;
    this.airY = this.placement().y;
    this.fall = undefined;
    this.react('dangle', { kind: 'pickedUp' }, true, t);
    return true;
  }

  dragTo(x: number, y: number): void {
    this.x = this.env.floor.clampX(x, this.cat.relativeSize);
    this.airY = Math.min(this.env.floor.yAt(this.d), Math.max(0, y));
  }

  drop(t: number): void {
    if (this.airY === undefined || !this.held) return;
    this.held = false;
    this.fall = { fromY: this.airY, elapsedMs: 0 };
    this.react(this.library.has('fall') ? 'fall' : 'dangle', { kind: 'dropped' }, false, t);
    // 在地板上放下也要播放落地片段。
    this.advance(t, t, false);
  }

  isAirborne(): boolean {
    return this.airY !== undefined;
  }

  private hardCut(pose: Pose, t: number): void {
    if (!this.cutPending) this.addCutEffect(t);
    this.cutPending = true;
    this.pose = pose;
    this.seg.move = undefined;
  }

  private addCutEffect(t: number): void {
    const bodyY =
      (this.airY ?? this.env.floor.yAt(this.d)) - 0.4 * STANDARD_CAT_HEIGHT * this.finalScale();
    this.env.addEffect('cut', this.x, bodyY, t);
  }

  // ---------- 地板和屏幕 ----------

  /** 屏幕宽度变了：位置按比例跟着变，再收回地板范围里。 */
  rescaleX(factor: number): void {
    this.x *= factor;
    const move = this.seg.move;
    if (move !== undefined) {
      move.fromX *= factor;
      move.toX *= factor;
    }
    for (const step of this.queue) {
      if (step.kind === 'move') step.x *= factor;
      if (step.kind === 'face') step.towardX *= factor;
    }
    this.clampToFloor();
  }

  clampToFloor(): void {
    this.x = this.env.floor.clampX(this.x, this.cat.relativeSize);
    this.d = clamp01(this.d);
    // 位置被挪过：重新定这一遍的起点，让下一帧从现在的位置接着走，步速不变
    const move = this.seg.move;
    if (move !== undefined) {
      move.fromX = this.x;
      move.fromD = this.d;
      move.toX = this.env.floor.clampX(move.toX, this.cat.relativeSize);
      const maxDd =
        this.env.floor.band > 0
          ? (MAX_WALK_SLOPE * Math.abs(move.toX - this.x)) / this.env.floor.band
          : 1;
      move.toD = Math.min(this.d + maxDd, Math.max(this.d - maxDd, move.toD));
      const cycleStart = this.seg.end - clipDurationMs(this.seg.clip);
      move.cycleStartX = this.x - move.dir * move.cycleSpeed * (this.seg.elapsed - cycleStart);
    }
  }

  /** 最终缩放 = 用户设置的缩放 × 相对体型 × 远近缩放。 */
  finalScale(): number {
    return this.env.scale * this.cat.relativeSize * this.env.floor.depthScale(this.d);
  }

  /**
   * 移动时停下的位置和目标最多差多远：只能在走（跑）完整遍时停下，所以最多差半遍的距离。
   * 召唤几只猫时，用它把停的位置错开。
   */
  stopTolerance(): number {
    const clips = [...this.library.variants('walk'), ...this.library.variants('run')];
    return Math.max(0, ...clips.map((clip) => this.cycleDistance(clip) / 2));
  }

  /** 走（跑）一遍在屏幕上移动多远。和播放速度无关：速度快了腿也摆得快。 */
  private cycleDistance(clip: Clip): number {
    return this.cycleSpeed(clip) * clipDurationMs(clip);
  }

  /** 按现在的缩放，每播 1 毫秒片段时间移动多少像素。 */
  private cycleSpeed(clip: Clip): number {
    return (clip.speed * this.finalScale()) / 1000;
  }

  // ---------- 输出 ----------

  /** 当前所处的姿势；片段播到一半时是它的开始姿势。 */
  currentPose(): Pose {
    return this.seg.clip.fromPose;
  }

  placement(): CatPlacement {
    const seg = this.seg;
    const duration = clipDurationMs(seg.clip);
    return {
      cat: this.id,
      clip: seg.clip.name,
      variant: seg.clip.variant,
      // 循环片段给的是这一遍里的时间，渲染层可以直接对照视频的当前时间
      clipTimeMs:
        seg.clip.kind === 'loop' ? seg.elapsed % duration : Math.min(seg.elapsed, duration),
      playbackRate: seg.rate,
      x: this.x,
      y: this.airY ?? this.env.floor.yAt(this.d),
      scale: this.finalScale(),
      mirrored: seg.mirrored,
      depth: this.d,
      pose: seg.clip.fromPose,
    };
  }

  /** 离当前姿势最近、能长时间待着的基础姿势。走不到的话是站着（到时候硬切）。 */
  private restPose(): BasePose {
    const rest = this.graph.nearestRestPose(this.pose);
    return rest !== undefined && isBasePose(rest) ? rest : 'stand';
  }

  private requireClip(name: string): Clip {
    const clip = this.library.first(name);
    // StageCore 只为必需片段齐全的猫建 CatActor，正常走不到这里
    if (clip === undefined) throw new Error(`cat ${this.id} has no clip ${name}`);
    return clip;
  }
}

/** 这个版本能不能朝 facing 那边移动：朝向对得上或者能镜像，而且移动速度大于 0。 */
function canMoveToward(clip: Clip, facing: Facing): boolean {
  return clip.speed > 0 && (clip.facing === facing || clip.mirrorable);
}
