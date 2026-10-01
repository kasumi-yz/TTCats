// 行为（Behavior）选择：猫自己决定接下来做什么。
// 只看性格参数和猫咪包里有哪些片段，不为某一只猫写死行为（ADR-0005）。
// 活跃度（ActivityLevel）只改变整体频率（每件事持续多久），不改变各个行为的权重，
// 所以不管选哪一档，猫与猫之间的性格差异都保持不变。
import type { ActivityLevel, BasePose, Personality } from '../../shared/schemas';
import type { ClipLibrary } from './pose-graph';
import { pickWeighted, uniform, type Random } from './random';

/** 猫自己选的行为。 */
export type AutonomousBehavior =
  /** 在当前姿势里待着 */
  | { kind: 'idle' }
  /** 换个姿势待着 */
  | { kind: 'rest'; pose: BasePose }
  /** 走到地板上的某处 */
  | { kind: 'wander' }
  /** 做一个日常动作片段 */
  | { kind: 'action'; clip: string };

/** 用户或调试台让猫做的事。 */
export type CommandedBehavior =
  { kind: 'summon' } | { kind: 'sleepCommand' } | { kind: 'debugClip'; clip: string };

export type Behavior = AutonomousBehavior | CommandedBehavior;

/**
 * 这些动作片段是对用户的反应（单击、喂饭提醒、迎接），不在日常里自己做（#1 对照表）。
 * 这里说的是片段的用途，不针对某只猫。
 */
const REACTION_ACTIONS: ReadonlySet<string> = new Set(['poked', 'meow']);

/** 活跃度五档对应的整体节奏：数值越大，每件事持续得越短、换得越勤。 */
export const ACTIVITY_LEVEL_TEMPO: Record<ActivityLevel, number> = {
  quiet: 0.5,
  lazy: 0.75,
  natural: 1,
  lively: 1.35,
  rowdy: 1.8,
};

/** 性格里的活跃程度对应的个人节奏，0.6～1.4。 */
export function personalTempo(personality: Personality): number {
  return 0.6 + 0.8 * personality.activity;
}

/** 猫在日常里会自己做的动作片段：猫咪包里有的、不是反应用的动作片段。 */
export function dailyActions(library: ClipLibrary): string[] {
  return library
    .names()
    .filter((name) => library.first(name)?.kind === 'action' && !REACTION_ACTIONS.has(name))
    .sort();
}

export interface ChoiceContext {
  personality: Personality;
  /** 猫现在所处的、能长时间待着的姿势。 */
  pose: BasePose;
  library: ClipLibrary;
  /** 上一个做过的动作片段名。同一个动作不连续出现两次（D7）。 */
  lastAction: string | undefined;
}

/** 当前情境下每个候选行为的权重。 */
export function behaviorWeights(
  context: ChoiceContext,
): { behavior: AutonomousBehavior; weight: number }[] {
  const a = context.personality.activity;
  const out: { behavior: AutonomousBehavior; weight: number }[] = [
    { behavior: { kind: 'idle' }, weight: 0.4 + 0.8 * (1 - a) },
  ];
  const rests: { pose: BasePose; weight: number }[] = [
    { pose: 'stand', weight: 0.3 + 0.4 * a },
    { pose: 'sit', weight: 0.3 + 0.5 * (1 - a) },
    { pose: 'sleep', weight: 0.1 + 0.4 * (1 - a) },
  ];
  for (const rest of rests) {
    if (rest.pose !== context.pose) {
      out.push({ behavior: { kind: 'rest', pose: rest.pose }, weight: rest.weight });
    }
  }
  out.push({ behavior: { kind: 'wander' }, weight: 0.2 + 1.2 * a });
  const actions = dailyActions(context.library).filter((name) => name !== context.lastAction);
  for (const clip of actions) {
    out.push({ behavior: { kind: 'action', clip }, weight: 0.6 / actions.length });
  }
  return out;
}

export function chooseBehavior(random: Random, context: ChoiceContext): AutonomousBehavior {
  return (
    pickWeighted(random, behaviorWeights(context), (c) => c.weight)?.behavior ?? { kind: 'idle' }
  );
}

/** 各个基础姿势下"待着"一次的基本时长（毫秒，个人节奏和活跃度都是 1 时）。 */
const REST_DURATION_MS: Record<BasePose, readonly [number, number]> = {
  stand: [4_000, 10_000],
  sit: [6_000, 16_000],
  sleep: [60_000, 180_000],
};

/** 在某个姿势里待多久（毫秒，真实时间）：随机，再按个人节奏和活跃度缩放。 */
export function restDurationMs(
  random: Random,
  pose: BasePose,
  personality: Personality,
  level: ActivityLevel,
): number {
  const [min, max] = REST_DURATION_MS[pose];
  return uniform(random, min, max) / (personalTempo(personality) * ACTIVITY_LEVEL_TEMPO[level]);
}

/** 召唤过来以后，在鼠标旁边站着等多久（毫秒）。这是对用户的回应，不随活跃度变。 */
export const SUMMON_WAIT_MS: readonly [number, number] = [5_000, 10_000];
/** 让猫睡觉（右键菜单）以后睡多久（毫秒）。 */
export const COMMANDED_SLEEP_MS: readonly [number, number] = [600_000, 900_000];
