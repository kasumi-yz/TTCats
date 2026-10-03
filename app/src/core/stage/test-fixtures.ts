// 只给单元测试用：测试猫咪包的元数据（D24）。格式和真实片段一样，能通过 ClipSchema。
// 时长参照 M0-A 的合成片段：循环片段 2 秒，过渡片段 0.75 秒。
import type { ContentCatalog, StageBounds } from '../../shared/core-api';
import type { StateSnapshot } from '../../shared/ipc';
import {
  CLIP_SLOTS,
  defaultSettings,
  type Cat,
  type Clip,
  type ClipSlotName,
  type Personality,
  type Settings,
} from '../../shared/schemas';
import type { Random } from './random';

const FPS = 24;
const FRAMES: Record<Clip['kind'], number> = { loop: 48, transition: 18, action: 36 };
const SPEED: Partial<Record<ClipSlotName, number>> = { walk: 80, run: 240 };

export function testClip(name: ClipSlotName, overrides: Partial<Clip> = {}): Clip {
  const slot = CLIP_SLOTS[name];
  // 奔跑一遍比走路短
  const frameCount = overrides.frameCount ?? (name === 'run' ? 16 : FRAMES[slot.kind]);
  return {
    schemaVersion: 1,
    name,
    variant: 1,
    kind: slot.kind,
    fromPose: slot.from,
    toPose: slot.to,
    optional: slot.need !== 'required',
    video: `clips/${name}.webm`,
    hitMask: `clips/${name}.hitmask.bin`,
    hitMaskScale: 4,
    fps: FPS,
    frameCount,
    width: 256,
    height: 256,
    footAnchors: Array.from({ length: frameCount }, () => ({ x: 128, y: 240 })),
    mirrorable: true,
    facing: 'right',
    speed: SPEED[name] ?? 0,
    keypoints: {},
    ...overrides,
  };
}

/** CLIP_SLOTS 里的全部片段，可以去掉一些。 */
export function testClips(omit: readonly string[] = []): Clip[] {
  return (Object.keys(CLIP_SLOTS) as ClipSlotName[])
    .filter((name) => !omit.includes(name))
    .map((name) => testClip(name));
}

export const NEUTRAL: Personality = {
  activity: 0.5,
  clinginess: 0.5,
  initiative: 0.5,
  dominance: 0.5,
  patience: 0.5,
};

export function testCat(id: string, overrides: Partial<Cat> = {}): Cat {
  return {
    schemaVersion: 1,
    id,
    name: id,
    relativeSize: 1,
    personality: NEUTRAL,
    relationships: [],
    sounds: { meow: [], purr: [] },
    ...overrides,
  };
}

export function catalog(entries: { cat: Cat; clips?: Clip[] }[]): ContentCatalog {
  return {
    cats: Object.fromEntries(
      entries.map((e) => [e.cat.id, { cat: e.cat, clips: e.clips ?? testClips() }]),
    ),
    disabled: [],
    events: {},
  };
}

export function snapshot(
  cats: readonly string[],
  settings: Partial<Settings> = {},
  revision = 1,
): StateSnapshot {
  return {
    revision,
    at: 0,
    settings: { ...defaultSettings(cats), ...settings },
    doNotDisturb: { mode: 'off' },
    hideAll: false,
    silencedBy: [],
    clockOffsetMs: 0,
    events: { lastTriggeredAt: {}, firstLaunchHandledOn: null },
  };
}

/** 固定种子的伪随机数（mulberry32），每次运行得到同样的序列。 */
export function seeded(seed: number): Random {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const SCREEN: StageBounds = { width: 1920, height: 1032 };

/** 测试里取数组的某一项，没有就直接报错。负数从末尾算。 */
export function at<T>(items: readonly T[], index: number): T {
  return defined(items.at(index));
}

export function defined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('测试数据里缺了预期的值');
  return value;
}
