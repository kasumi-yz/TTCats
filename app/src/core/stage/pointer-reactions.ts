import type { PointerInput } from '../../shared/core-api';
import type { Fact, SimulatedInteraction } from '../../shared/ipc';
import type { Point } from '../../shared/schemas';
import { zh } from '../../shared/strings.zh-CN';
import type { ActorEnv, CatActor } from './actor';
import { STANDARD_CAT_HEIGHT } from './floor';

const STROKE_WINDOW_MS = 1500;
const PET_IDLE_MS = 600;
const POKE_WINDOW_MS = 2000;
const NEARBY_CLICK_WINDOW_MS = 2000;
const PROXIMITY_COOLDOWN_MS = 30000;
const PROXIMITY_DWELL_MS = 1000;
const AVOID_WAIT_MS = 5000;
const IMPATIENCE_COOLDOWN_MS = 10000;
const BUBBLE_MS = 2000;
export const HEARTS_MS = 600;

/** 单一鼠标的互动状态。命中判定和右键菜单由桌面层负责。 */
export class PointerReactions {
  private ghost = false;
  private press:
    | { actor: CatActor; origin: Point; offset: Point; dragging: boolean; simulated: boolean }
    | undefined;
  private stroke: { actor: CatActor; origin: Point; direction: Point; times: number[] } | undefined;
  private pet:
    | {
        actor: CatActor;
        start: number;
        lastMove: number;
        deadline: number;
        heartAt: number;
        simulated: boolean;
      }
    | undefined;
  private readonly pokes = new Map<CatActor, number[]>();
  private readonly nearbyClicks = new Map<CatActor, { x: number; at: number }[]>();
  private readonly proximity = new Map<CatActor, number>();
  private readonly dwell = new Map<CatActor, number>();
  private readonly impatience = new Map<CatActor, number>();
  private nearbyPointer: Point | undefined;
  private facts: Fact[] = [];
  private bubbles: { cat: string; text: string; at: number }[] = [];

  constructor(
    private readonly actors: () => readonly CatActor[],
    private readonly env: ActorEnv,
  ) {}

  handle(input: PointerInput, now: number): void {
    // 穿透点击也包括幽灵模式；它没有被桌面层接收，不能变成单击或拖动。
    if (input.type === 'clickThrough') {
      if (this.press === undefined && !this.pet?.simulated) this.clickThrough(input, now);
      return;
    }
    // 调试模拟只由调试命令结束，不跟随真实鼠标，也不被真实松手或取消打乱。
    if (this.press?.simulated || this.pet?.simulated) return;
    if (input.type === 'cancel' || input.type === 'up') {
      const press = this.press;
      this.press = undefined;
      if (press?.dragging) {
        if (input.type === 'up') this.drag(press, input);
        this.drop(press.actor, now);
      } else if (press !== undefined && !this.ghost && input.type === 'up') {
        // 按下后在原处松开才算单击；移开或丢失松手不产生误戳。
        if (
          Math.hypot(input.x - press.origin.x, input.y - press.origin.y) <
          this.dragThreshold(press.actor)
        )
          this.poke(press.actor, now);
      }
      return;
    }
    if (this.press?.dragging) {
      if (input.type === 'move') this.drag(this.press, input);
      return;
    }
    if (this.ghost) return;
    this.nearbyPointer = undefined;
    if (input.type !== 'move' || input.cat !== null) this.dwell.clear();
    const actor = this.actors().find((a) => a.id === input.cat && !a.isAirborne());
    if (input.type === 'down') {
      if (this.press !== undefined) return;
      this.finishPet(now);
      this.stroke = undefined;
      if (actor === undefined) return;
      const p = actor.placement();
      this.press = {
        actor,
        origin: input,
        offset: { x: p.x - input.x, y: p.y - input.y },
        dragging: false,
        simulated: false,
      };
      return;
    }
    if (this.press !== undefined) {
      const press = this.press;
      if (
        Math.hypot(input.x - press.origin.x, input.y - press.origin.y) >=
          this.dragThreshold(press.actor) &&
        press.actor.pickUp(now)
      ) {
        press.dragging = true;
        this.facts.push({ type: 'cat/pickedUp', cat: press.actor.id, at: now });
        this.drag(press, input);
      }
      return;
    }
    if (this.pet !== undefined && this.pet.actor !== actor) this.finishPet(now);
    if (actor !== undefined) this.strokeMove(actor, input, now);
    else {
      this.stroke = undefined;
      this.nearbyPointer = input;
      this.nearPointer(input, now);
    }
  }

  setGhost(active: boolean, now: number): void {
    this.ghost = active;
    this.stroke = undefined;
    this.nearbyPointer = undefined;
    this.dwell.clear();
    if (active) {
      this.finishPet(now);
      if (!this.press?.dragging) this.press = undefined;
    }
  }

  /** 超时在准确的截止时刻结束，Stage 在这个时刻拆开推进，避免帧率影响时长。 */
  expiry(): number | undefined {
    const pet = this.pet;
    return pet === undefined
      ? undefined
      : Math.min(pet.deadline, pet.simulated ? Infinity : pet.lastMove + PET_IDLE_MS);
  }

  expire(now: number): void {
    const pet = this.pet;
    if (pet === undefined) return;
    const impatient = now >= pet.deadline;
    this.finishPet(now);
    if (impatient) {
      this.impatience.set(pet.actor, now);
      this.walkAway(pet.actor, pet.actor.x, now);
    }
  }

  refresh(now: number): void {
    if (
      this.nearbyPointer !== undefined &&
      !this.ghost &&
      this.press === undefined &&
      this.pet === undefined
    )
      this.nearPointer(this.nearbyPointer, now);
    if (this.pet !== undefined && now - this.pet.heartAt >= HEARTS_MS) this.hearts(now);
    this.bubbles = this.bubbles.filter((b) => now - b.at < BUBBLE_MS);
  }

  frameBubbles(now: number) {
    return this.bubbles.map((b) => ({ cat: b.cat, text: b.text, ageMs: Math.max(0, now - b.at) }));
  }

  drainFacts(): Fact[] {
    const out = this.facts;
    this.facts = [];
    return out;
  }

  simulate(actor: CatActor, interaction: SimulatedInteraction, now: number): void {
    if (interaction === 'nearbyClicks') {
      if (this.press !== undefined || actor.isAirborne()) return;
      this.finishPet(now);
      const p = actor.placement();
      const unit = STANDARD_CAT_HEIGHT * p.scale;
      const x = p.x + (p.x < this.env.floor.width / 2 ? 1 : -1) * unit * 1.5;
      for (let i = 0; i < this.nearbyClickThreshold(actor); i++)
        this.clickThrough({ type: 'clickThrough', x, y: p.y - unit / 2, cat: null }, now, actor);
      return;
    }
    if (interaction === 'drop') {
      if (this.press?.actor === actor && this.press.dragging) {
        this.press = undefined;
        this.drop(actor, now);
      }
      return;
    }
    if (this.ghost || this.press !== undefined || actor.isAirborne()) return;
    this.finishPet(now);
    this.stroke = undefined;
    this.nearbyPointer = undefined;
    this.dwell.clear();
    if (interaction === 'poke') this.poke(actor, now);
    else if (interaction === 'pet') this.startPet(actor, now, true);
    else if (actor.pickUp(now)) {
      const p = actor.placement();
      this.press = { actor, origin: p, offset: { x: 0, y: 0 }, dragging: true, simulated: true };
      actor.dragTo(p.x, p.y - STANDARD_CAT_HEIGHT * p.scale);
      this.facts.push({ type: 'cat/pickedUp', cat: actor.id, at: now });
    }
  }

  cancelFor(actor: CatActor, now: number, removed = false): void {
    if (this.pet?.actor === actor) this.finishPet(now);
    if (this.stroke?.actor === actor) this.stroke = undefined;
    if (this.press?.actor === actor) {
      if (this.press.dragging) this.drop(actor, now);
      this.press = undefined;
    }
    this.pokes.delete(actor);
    this.nearbyClicks.delete(actor);
    this.dwell.delete(actor);
    if (removed) {
      this.proximity.delete(actor);
      this.impatience.delete(actor);
    }
    this.bubbles = this.bubbles.filter((b) => b.cat !== actor.id);
  }

  shiftTime(dt: number): void {
    if (this.pet !== undefined) {
      this.pet.start += dt;
      this.pet.lastMove += dt;
      this.pet.deadline += dt;
      this.pet.heartAt += dt;
    }
    if (this.stroke !== undefined) this.stroke.times = this.stroke.times.map((t) => t + dt);
    for (const [actor, times] of this.pokes)
      this.pokes.set(
        actor,
        times.map((t) => t + dt),
      );
    for (const [actor, t] of this.proximity) this.proximity.set(actor, t + dt);
    for (const [actor, t] of this.dwell) this.dwell.set(actor, t + dt);
    for (const [actor, t] of this.impatience) this.impatience.set(actor, t + dt);
    for (const clicks of this.nearbyClicks.values()) for (const click of clicks) click.at += dt;
    for (const bubble of this.bubbles) bubble.at += dt;
  }

  private dragThreshold(actor: CatActor): number {
    return 0.04 * STANDARD_CAT_HEIGHT * actor.finalScale();
  }

  private nearbyClickThreshold(actor: CatActor): number {
    return 3 + Math.round(2 * actor.cat.personality.patience);
  }

  private clickThrough(
    input: Extract<PointerInput, { type: 'clickThrough' }>,
    now: number,
    only?: CatActor,
  ): void {
    for (const actor of only === undefined ? this.actors() : [only]) {
      if (actor.id === input.cat || actor.isAirborne() || this.isImpatient(actor, now)) continue;
      const p = actor.placement();
      const unit = STANDARD_CAT_HEIGHT * p.scale;
      if (Math.hypot(input.x - p.x, input.y - (p.y - unit / 2)) > unit * 2) continue;
      const clicks = (this.nearbyClicks.get(actor) ?? []).filter(
        (click) => now - click.at <= NEARBY_CLICK_WINDOW_MS,
      );
      clicks.push({ x: input.x, at: now });
      this.nearbyClicks.set(actor, clicks);
      if (clicks.length < this.nearbyClickThreshold(actor)) continue;
      this.nearbyClicks.delete(actor);
      const fromX = clicks.reduce((sum, click) => sum + click.x, 0) / clicks.length;
      const range = this.env.floor.xRange(actor.cat.relativeSize);
      const dir =
        actor.x > fromX ? 1 : actor.x < fromX ? -1 : actor.x < this.env.floor.width / 2 ? 1 : -1;
      let x = this.env.floor.clampX(actor.x + dir * unit * 2, actor.cat.relativeSize);
      // 边缘不能继续走时，只在另一端确实离点击更远时换方向，不能反而凑上去。
      if (Math.abs(x - actor.x) < actor.stopTolerance()) {
        const other = dir > 0 ? range.min : range.max;
        if (Math.abs(other - fromX) <= Math.abs(actor.x - fromX) + actor.stopTolerance()) continue;
        x = other;
      }
      if (this.pet?.actor === actor) this.finishPet(now);
      this.stroke = undefined;
      this.dwell.delete(actor);
      this.impatience.set(actor, now);
      this.proximity.set(actor, now);
      actor.avoidNearbyClicks(x, now);
    }
  }

  private drag(press: NonNullable<PointerReactions['press']>, point: Point): void {
    press.actor.dragTo(point.x + press.offset.x, point.y + press.offset.y);
  }

  private drop(actor: CatActor, now: number): void {
    actor.drop(now);
    this.facts.push({ type: 'cat/dropped', cat: actor.id, at: now });
  }

  private poke(actor: CatActor, now: number): void {
    this.facts.push({ type: 'cat/poked', cat: actor.id, at: now });
    if (this.isImpatient(actor, now)) return;
    const times = (this.pokes.get(actor) ?? []).filter((t) => now - t <= POKE_WINDOW_MS);
    times.push(now);
    this.pokes.set(actor, times);
    this.bubble(
      actor,
      actor.cat.personality.clinginess >= 0.5 ? zh.stagePointer.friendly : zh.stagePointer.reserved,
      now,
    );
    if (times.length >= 3 + Math.round(5 * actor.cat.personality.patience)) {
      this.pokes.delete(actor);
      this.impatience.set(actor, now);
      this.walkAway(actor, actor.x, now);
      return;
    }
    const name = actor.library.has('poked')
      ? 'poked'
      : actor.library.has('meow')
        ? 'meow'
        : undefined;
    if (name !== undefined) actor.react(name, { kind: 'poked' }, false, now);
    else actor.startSound('meow', now);
  }

  private strokeMove(actor: CatActor, point: Point, now: number): void {
    if (this.isImpatient(actor, now)) {
      this.stroke = undefined;
      return;
    }
    if (this.pet?.actor === actor) {
      // 原地的 move 不延长撸猫；必须真的继续移动。
      if (
        this.stroke !== undefined &&
        Math.hypot(point.x - this.stroke.origin.x, point.y - this.stroke.origin.y) >=
          2 * actor.finalScale()
      ) {
        this.pet.lastMove = now;
        this.stroke.origin = point;
      }
      return;
    }
    if (this.stroke?.actor !== actor) {
      this.stroke = { actor, origin: point, direction: { x: 0, y: 0 }, times: [] };
      return;
    }
    const stroke = this.stroke;
    const dx = point.x - stroke.origin.x;
    const dy = point.y - stroke.origin.y;
    const distance = Math.hypot(dx, dy);
    if (distance < STANDARD_CAT_HEIGHT * actor.finalScale() * 0.12) return;
    // 第一划、以及随后方向反转的完整一划才计数；同向滑动和抖动不算来回划。
    if (stroke.direction.x * dx + stroke.direction.y * dy <= 0) {
      stroke.times = stroke.times.filter((t) => now - t <= STROKE_WINDOW_MS);
      stroke.times.push(now);
      stroke.direction = { x: dx / distance, y: dy / distance };
      if (stroke.times.length >= 3) this.startPet(actor, now, false);
    }
    stroke.origin = point;
  }

  private startPet(actor: CatActor, now: number, simulated: boolean): void {
    if (this.isImpatient(actor, now) || !actor.library.has('purr')) return;
    actor.react('purr', { kind: 'petted' }, true, now);
    this.pet = {
      actor,
      start: now,
      lastMove: now,
      deadline: now + 2000 + 10000 * actor.cat.personality.patience,
      heartAt: now,
      simulated,
    };
    this.hearts(now);
  }

  private finishPet(now: number): void {
    const pet = this.pet;
    if (pet === undefined) return;
    this.pet = undefined;
    this.stroke = undefined;
    pet.actor.releaseReaction(now);
    this.facts.push({
      type: 'cat/petted',
      cat: pet.actor.id,
      at: now,
      durationMs: Math.max(0, now - pet.start),
    });
  }

  private hearts(now: number): void {
    if (this.pet === undefined) return;
    this.pet.heartAt = now;
    const p = this.pet.actor.placement();
    this.env.addEffect('hearts', p.x, p.y - STANDARD_CAT_HEIGHT * p.scale * 0.5, now);
  }

  private bubble(actor: CatActor, text: string, now: number): void {
    this.bubbles = this.bubbles.filter((b) => b.cat !== actor.id);
    this.bubbles.push({ cat: actor.id, text, at: now });
  }

  private walkAway(actor: CatActor, fromX: number, now: number): void {
    const range = this.env.floor.xRange(actor.cat.relativeSize);
    const dir =
      actor.x === fromX ? (actor.x < this.env.floor.width / 2 ? 1 : -1) : actor.x > fromX ? 1 : -1;
    const distance = STANDARD_CAT_HEIGHT * actor.finalScale() * 2;
    let x = this.env.floor.clampX(actor.x + dir * distance, actor.cat.relativeSize);
    if (Math.abs(x - actor.x) < actor.stopTolerance()) x = dir > 0 ? range.min : range.max;
    actor.interrupt(
      [
        { kind: 'move', gait: 'walk', x, d: actor.d },
        { kind: 'clip', name: 'idle-stand', holdMs: AVOID_WAIT_MS },
      ],
      { kind: 'avoid' },
      'cut',
      now,
    );
    this.proximity.set(actor, now);
  }

  private nearPointer(point: Point, now: number): void {
    for (const actor of this.actors()) {
      if (
        actor.isDoNotDisturb() ||
        !['idle', 'rest', 'wander', 'action'].includes(actor.behavior.kind) ||
        actor.currentPose() === 'sleep' ||
        actor.isAirborne() ||
        this.isImpatient(actor, now) ||
        now - (this.proximity.get(actor) ?? -Infinity) < PROXIMITY_COOLDOWN_MS
      ) {
        this.dwell.delete(actor);
        continue;
      }
      const p = actor.placement();
      const unit = STANDARD_CAT_HEIGHT * p.scale;
      if (Math.hypot(point.x - p.x, point.y - (p.y - unit / 2)) > unit * 2) {
        this.dwell.delete(actor);
        continue;
      }
      const since = this.dwell.get(actor);
      if (since === undefined) {
        this.dwell.set(actor, now);
        continue;
      }
      if (now - since < PROXIMITY_DWELL_MS) continue;
      this.dwell.delete(actor);
      // 不反应也消耗这次尝试，避免每帧重新掷骰子。
      this.proximity.set(actor, now);
      const { clinginess, initiative } = actor.cat.personality;
      const probability =
        clinginess < 0.5 ? (0.5 - clinginess) * 2 : (clinginess - 0.5) * 2 * initiative;
      if (this.env.random() >= probability) continue;
      if (clinginess < 0.5) this.walkAway(actor, point.x, now);
      else {
        const x = point.x + (actor.x <= point.x ? -1 : 1) * unit * 0.7;
        actor.interrupt(
          [
            { kind: 'move', gait: 'walk', x, d: actor.d },
            { kind: 'face', towardX: point.x },
            { kind: 'clip', name: 'idle-stand', holdMs: AVOID_WAIT_MS },
          ],
          { kind: 'approach' },
          'cut',
          now,
        );
        this.proximity.set(actor, now);
      }
    }
  }

  private isImpatient(actor: CatActor, now: number): boolean {
    const since = this.impatience.get(actor);
    if (since === undefined) return false;
    if (actor.behavior.kind === 'avoid' || now - since < IMPATIENCE_COOLDOWN_MS) return true;
    this.impatience.delete(actor);
    return false;
  }
}
