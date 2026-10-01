// 片段库和姿势网络（PoseGraph）。
// 网络只用猫咪包里实际有的片段来建：过渡片段是边，姿势是点。缺了可选片段时，
// 相应的路走不通，调用方按 #1 的"动作—素材—功能对照表"降级。
import type { BasePose, Clip, Pose } from '../../shared/schemas';

/** 片段一遍的时长（毫秒，按 1 倍速）。 */
export function clipDurationMs(clip: Clip): number {
  return (clip.frameCount / clip.fps) * 1000;
}

/** 每个基础姿势用哪个循环片段来"待着"。这些都是必需片段（CLIP_SLOTS）。 */
export const REST_LOOPS = {
  stand: 'idle-stand',
  sit: 'idle-sit',
  sleep: 'sleep',
} as const satisfies Record<BasePose, string>;

export function isBasePose(pose: Pose): pose is BasePose {
  return Object.hasOwn(REST_LOOPS, pose);
}

/** 一只猫的全部片段，按片段名分组，每组按版本号排好。 */
export class ClipLibrary {
  private readonly byName = new Map<string, Clip[]>();

  constructor(clips: readonly Clip[]) {
    for (const clip of clips) {
      const list = this.byName.get(clip.name) ?? [];
      list.push(clip);
      this.byName.set(clip.name, list);
    }
    for (const list of this.byName.values()) list.sort((a, b) => a.variant - b.variant);
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  names(): string[] {
    return [...this.byName.keys()];
  }

  variants(name: string): readonly Clip[] {
    return this.byName.get(name) ?? [];
  }

  /** 片段名的第一个版本，用来读类型和起止姿势。 */
  first(name: string): Clip | undefined {
    return this.byName.get(name)?.[0];
  }

  /** 在这个姿势下"待着"用的循环片段名；不能长时间待着的姿势返回 undefined。 */
  restLoop(pose: Pose): string | undefined {
    if (!isBasePose(pose)) return undefined;
    const name = REST_LOOPS[pose];
    return this.has(name) ? name : undefined;
  }
}

/** 从一个姿势到另一个姿势要依次播的过渡片段。 */
export class PoseGraph {
  /** 每个姿势出发的边：过渡片段名、到达的姿势、时长。 */
  private readonly edges = new Map<Pose, { clip: string; to: Pose; cost: number }[]>();

  constructor(private readonly library: ClipLibrary) {
    for (const name of library.names().sort()) {
      const variants = library.variants(name);
      const clip = variants[0];
      if (clip?.kind !== 'transition') continue;
      const cost = Math.min(...variants.map(clipDurationMs));
      const list = this.edges.get(clip.fromPose) ?? [];
      list.push({ clip: name, to: clip.toPose, cost });
      this.edges.set(clip.fromPose, list);
    }
  }

  /**
   * 从 from 到 to 用时最短的一串过渡片段名。from 和 to 相同时是空数组；走不通时是 undefined。
   */
  path(from: Pose, to: Pose): string[] | undefined {
    return this.search(from, (pose) => pose === to)?.clips;
  }

  /** 离 from 最近、能长时间待着的姿势（from 自己能待着就是 from）。走不到任何一个时是 undefined。 */
  nearestRestPose(from: Pose): Pose | undefined {
    return this.search(from, (pose) => this.library.restLoop(pose) !== undefined)?.pose;
  }

  /** Dijkstra：姿势只有几个，直接线性找最小值。 */
  private search(
    from: Pose,
    isGoal: (pose: Pose) => boolean,
  ): { pose: Pose; clips: string[] } | undefined {
    const best = new Map<Pose, { cost: number; clips: string[] }>([[from, { cost: 0, clips: [] }]]);
    const done = new Set<Pose>();
    for (;;) {
      let current: Pose | undefined;
      let currentCost = Infinity;
      for (const [pose, entry] of best) {
        if (!done.has(pose) && entry.cost < currentCost) {
          current = pose;
          currentCost = entry.cost;
        }
      }
      if (current === undefined) return undefined;
      const entry = best.get(current);
      if (entry === undefined) return undefined;
      if (isGoal(current)) return { pose: current, clips: entry.clips };
      done.add(current);
      for (const edge of this.edges.get(current) ?? []) {
        const cost = entry.cost + edge.cost;
        const known = best.get(edge.to);
        if (known === undefined || cost < known.cost) {
          best.set(edge.to, { cost, clips: [...entry.clips, edge.clip] });
        }
      }
    }
  }
}
