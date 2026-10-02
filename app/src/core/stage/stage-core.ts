// core/stage 的入口：实现 shared/core-api.ts 里的 StageCore。
// 管理可以随时丢掉的画面状态（ADR-0004）：每只猫在哪、正在播哪个片段、接下来要做什么。
import type {
  ContentCatalog,
  CreateStageCore,
  PointerInput,
  StageBounds,
  StageCore,
  StageEffect,
  StageFrame,
  SoundCue,
} from '../../shared/core-api';
import type { Fact, StageCommand, StageDebugReport, StateSnapshot } from '../../shared/ipc';
import { missingRequiredClips, type Point, type Settings } from '../../shared/schemas';
import { zh } from '../../shared/strings.zh-CN';
import { CatActor, type ActorEnv, type StageObserver } from './actor';
import type { Behavior } from './behavior';
import { Floor, STANDARD_CAT_HEIGHT } from './floor';
import { pick, uniform, type Random } from './random';
import { HEARTS_MS, PointerReactions } from './pointer-reactions';

/**
 * 两次推进之间隔了这么久（毫秒），就当作是隐藏后恢复：当前的计划照真实时间推进完，
 * 但不再接着补选新行为、补播片段（见 CatActor.advance）。
 */
export const LONG_GAP_MS = 1_000;
/** 打断时盖住切换处的小特效持续多久（M0-A 用的是 260ms 的烟团）。 */
export const CUT_EFFECT_MS = 300;
/** 召唤时，离鼠标最近的猫停在鼠标旁边多远（标准猫身高的几倍）。 */
const SUMMON_SIDE_RATIO = 0.7;
/** 召唤多只猫时，同一侧相邻两只猫之间至少隔多远（标准猫身高的几倍）。 */
const SUMMON_SPACING_RATIO = 1.1;

interface ActiveEffect {
  id: number;
  effect: StageEffect;
  x: number;
  y: number;
  at: number;
}

export type StageOptions = Parameters<CreateStageCore>[0] & {
  /** 测试用：每个片段开始播放时通知。 */
  observer?: StageObserver;
};

export class Stage implements StageCore {
  private readonly content: ContentCatalog;
  private readonly random: Random;
  private readonly env: ActorEnv;
  private settings: Settings;
  private revision: number;
  private bounds: StageBounds;
  private actors: CatActor[] = [];
  private lastNow: number;
  private pointer: Point | undefined;
  private effects: ActiveEffect[] = [];
  private nextEffectId = 1;
  private sounds: { cue: SoundCue; at: number }[] = [];
  private readonly debugPurrUntil = new Map<string, number>();
  private readonly pointerReactions: PointerReactions;

  constructor(options: StageOptions) {
    this.content = options.content;
    this.random = options.random;
    this.settings = options.snapshot.settings;
    this.revision = options.snapshot.revision;
    this.bounds = options.bounds;
    this.lastNow = options.now;
    this.env = {
      random: options.random,
      floor: this.makeFloor(),
      scale: this.settings.scale,
      activityLevel: this.settings.activityLevel,
      addEffect: (effect, x, y, at) => {
        this.effects.push({ id: this.nextEffectId++, effect, x, y, at });
      },
      observer: options.observer,
      addSound: (cue, at) => {
        this.sounds.push({ cue, at });
      },
    };
    this.pointerReactions = new PointerReactions(() => this.actors, this.env);
    this.syncActors(options.now);
  }

  applySnapshot(snapshot: StateSnapshot, now: number): void {
    this.advanceTo(now);
    if (snapshot.revision <= this.revision) return;
    this.revision = snapshot.revision;
    this.settings = snapshot.settings;
    this.env.scale = this.settings.scale;
    this.env.activityLevel = this.settings.activityLevel;
    this.env.floor = this.makeFloor();
    for (const actor of this.actors) actor.clampToFloor();
    this.syncActors(now);
  }

  handleCommand(command: StageCommand, now: number): void {
    this.advanceTo(now);
    // 重新入场在 #59 里实现。
    if (command.type === 'cat/entrance') return;
    if (command.type === 'debug/sound') {
      const actor = this.actor(command.cat);
      actor?.startSound(command.sound, now);
      if (actor && command.sound === 'purr') this.debugPurrUntil.set(actor.id, now + 3000);
      return;
    }
    if (command.type !== 'debug/simulate' && command.type !== 'cat/summon') {
      const actor = this.actor(command.cat);
      if (actor?.isAirborne()) return;
      if (actor !== undefined) this.pointerReactions.cancelFor(actor, now);
    }
    switch (command.type) {
      case 'cat/summon':
        this.summon(command.cats, command.to, now);
        break;
      case 'cat/sleep':
        this.actor(command.cat)?.sleep(now);
        break;
      case 'debug/playClip':
        this.actor(command.cat)?.playDebugClip(command.clip, command.variant, now);
        break;
      case 'debug/simulate':
        {
          const actor = this.actor(command.cat);
          if (actor !== undefined) this.pointerReactions.simulate(actor, command.interaction, now);
        }
        break;
    }
  }

  handlePointer(input: PointerInput, now: number): void {
    this.advanceTo(now);
    // 召唤没写目标时，走到最后一次看到鼠标的地方
    if (input.type !== 'cancel') this.pointer = { x: input.x, y: input.y };
    this.pointerReactions.handle(input, now);
  }

  setGhostMode(active: boolean, now: number): void {
    this.advanceTo(now);
    this.pointerReactions.setGhost(active, now);
  }

  setBounds(bounds: StageBounds, now: number): void {
    this.advanceTo(now);
    const factor = this.bounds.width > 0 ? bounds.width / this.bounds.width : 1;
    this.bounds = bounds;
    this.env.floor = this.makeFloor();
    for (const actor of this.actors) actor.rescaleX(factor);
  }

  update(now: number): StageFrame {
    this.advanceTo(now);
    this.pointerReactions.refresh(now);
    this.effects = this.effects.filter(
      (e) => now - e.at < (e.effect === 'hearts' ? HEARTS_MS : CUT_EFFECT_MS),
    );
    const cats = this.actors
      .map((actor, order) => ({ placement: actor.placement(), order }))
      // 离得远的先画，离得近的后画、挡住远的；一样远时按显示顺序
      .sort((a, b) => a.placement.depth - b.placement.depth || a.order - b.order)
      .map((entry) => entry.placement);
    return {
      cats,
      bubbles: this.pointerReactions.frameBubbles(now),
      effects: this.effects.map((e) => ({
        id: e.id,
        effect: e.effect,
        x: e.x,
        y: e.y,
        ageMs: Math.max(0, now - e.at),
      })),
      sounds: this.drainSounds(now),
    };
  }

  drainFacts(): Fact[] {
    return this.pointerReactions.drainFacts();
  }

  debugReport(now: number): StageDebugReport {
    return {
      at: now,
      cats: this.actors.map((actor) => {
        const placement = actor.placement();
        return {
          cat: actor.id,
          pose: actor.currentPose(),
          clip: placement.clip,
          variant: placement.variant,
          behavior: describeBehavior(actor.behavior),
          x: placement.x,
          y: placement.y,
        };
      }),
    };
  }

  // ---------- 内部 ----------

  /** 把所有猫推进到 now。时间倒退（比如改了系统时间）时不推进，从新的时间接着算。 */
  private advanceTo(now: number): void {
    const dt = now - this.lastNow;
    if (dt < 0) {
      for (const sound of this.sounds) sound.at += dt;
      for (const [cat, until] of this.debugPurrUntil) this.debugPurrUntil.set(cat, until + dt);
      for (const effect of this.effects) effect.at += dt;
      this.pointerReactions.shiftTime(dt);
    } else if (dt > 0) {
      const catchUp = dt > LONG_GAP_MS;
      let from = this.lastNow;
      const expiry = this.pointerReactions.expiry();
      if (expiry !== undefined && expiry <= now) {
        const at = Math.max(from, expiry);
        for (const actor of this.actors) actor.advance(from, at, catchUp);
        this.pointerReactions.expire(at);
        from = at;
      }
      for (const actor of this.actors) actor.advance(from, now, catchUp);
    }
    this.lastNow = now;
    for (const [cat, until] of this.debugPurrUntil) {
      if (now >= until) {
        this.sounds.push({ cue: { cat, sound: 'purr', action: 'stop' }, at: until });
        this.debugPurrUntil.delete(cat);
      }
    }
  }

  private drainSounds(now: number): SoundCue[] {
    const sounds = this.sounds;
    this.sounds = [];
    return sounds
      .filter(({ cue, at }) => this.actor(cue.cat) && (cue.action === 'stop' || now - at <= 1000))
      .sort((a, b) => a.at - b.at)
      .map(({ cue }) => cue);
  }

  private makeFloor(): Floor {
    return new Floor({
      bounds: this.bounds,
      scale: this.settings.scale,
      floorDepth: this.settings.floorDepth,
    });
  }

  private actor(cat: string): CatActor | undefined {
    return this.actors.find((actor) => actor.id === cat);
  }

  /** 按 settings.visibleCats 增减猫。猫咪包里缺必需片段的猫不出现。 */
  private syncActors(now: number): void {
    const visible = [...new Set(this.settings.visibleCats)].filter((id) => {
      const entry = this.content.cats[id];
      return (
        entry !== undefined && missingRequiredClips(entry.clips.map((c) => c.name)).length === 0
      );
    });
    for (const actor of this.actors) {
      if (!visible.includes(actor.id)) {
        this.pointerReactions.cancelFor(actor, now, true);
        this.debugPurrUntil.delete(actor.id);
        this.sounds = this.sounds.filter(({ cue }) => cue.cat !== actor.id);
      }
    }
    this.actors = visible.map((id) => this.actor(id) ?? this.createActor(id, now));
  }

  private createActor(id: string, now: number): CatActor {
    const entry = this.content.cats[id];
    if (entry === undefined) throw new Error(`unknown cat ${id}`);
    const range = this.env.floor.xRange(entry.cat.relativeSize);
    return new CatActor(entry.cat, entry.clips, this.env, {
      x: uniform(this.random, range.min, range.max),
      d: uniform(this.random, 0, 1),
      facing: pick(this.random, ['left', 'right'] as const) ?? 'right',
      now,
    });
  }

  /**
   * 召唤：猫走到鼠标旁边。从左边来的停在鼠标左边，从右边来的停在右边，
   * 同一侧有好几只时依次往外排，免得叠在一起。
   */
  private summon(cats: readonly string[], to: Point | undefined, now: number): void {
    const floor = this.env.floor;
    const target = to ?? this.pointer ?? { x: floor.width / 2, y: floor.nearY };
    const unit = STANDARD_CAT_HEIGHT * this.settings.scale;
    const actors = this.actors.filter((actor) => cats.includes(actor.id) && !actor.isAirborne());
    for (const actor of actors) this.pointerReactions.cancelFor(actor, now);
    const left = actors.filter((actor) => actor.x <= target.x).sort((a, b) => b.x - a.x);
    const right = actors.filter((actor) => actor.x > target.x).sort((a, b) => a.x - b.x);
    for (const [side, group] of [
      [-1, left],
      [1, right],
    ] as const) {
      // 猫只能在走完整遍时停下，停的位置和目标最多差 stopTolerance，所以间隔要把它算进去
      let x = target.x;
      let previousTolerance: number | undefined;
      for (const actor of group) {
        const tolerance = actor.stopTolerance();
        x +=
          side *
          (previousTolerance === undefined
            ? SUMMON_SIDE_RATIO * unit + tolerance
            : SUMMON_SPACING_RATIO * unit + previousTolerance + tolerance);
        previousTolerance = tolerance;
        actor.summon(x, floor.depthAtY(target.y) ?? actor.d, target.x, now);
      }
    }
  }
}

function describeBehavior(behavior: Behavior): string {
  const b = zh.stage.behaviors;
  switch (behavior.kind) {
    case 'idle':
      return b.idle;
    case 'rest':
      return b.rest[behavior.pose];
    case 'wander':
      return b.wander;
    case 'action':
      return b.action(behavior.clip);
    case 'summon':
      return b.summon;
    case 'sleepCommand':
      return b.sleepCommand;
    case 'debugClip':
      return b.debugClip(behavior.clip);
    case 'poked':
    case 'petted':
    case 'pickedUp':
    case 'dropped':
    case 'approach':
    case 'avoid':
      return zh.stagePointer.behaviors[behavior.kind];
  }
}

export const createStageCore: CreateStageCore = (options) => new Stage(options);
