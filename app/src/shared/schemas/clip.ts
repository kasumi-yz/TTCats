// 片段（Clip）元数据：猫咪包里 clips/ 下每个 *.webm 旁边的同名 *.json（设计方案第三章）。
// M1 定稿（#18），M2 加了 CLIP_SOUNDS（#52）。片段格式在 M0-A 用合成片段验证过；ADR-0002 等豆豆的真实片段复测后再改成 accepted。
// 所有坐标都是片段画面里的像素坐标，原点在左上角。
import { z } from 'zod';
import { zh } from '../strings.zh-CN';
import {
  IdSchema,
  JsonSchemaRefField,
  PackPathSchema,
  PointSchema,
  SchemaVersionSchema,
} from './common';
import type { CatSound } from './cat';
import { PoseSchema, type Pose } from './pose';

/**
 * 片段类型：循环片段（LoopClip）、过渡片段（TransitionClip）、动作片段（ActionClip）。
 * 互动片段和事件片段到第二阶段再加。
 */
export const ClipKindSchema = z.enum(['loop', 'transition', 'action']);
export type ClipKind = z.infer<typeof ClipKindSchema>;

/**
 * 缺了某个标准片段时怎么办（PRD 的"动作—素材—功能对照表"最右一列）：
 * - required：猫咪包整只停用（内容加载时检查）。
 * - feature：只停用用到它的那个功能，比如没有 purr 就不能撸猫，没有 dangle 或 land 就不能拎起。
 * - optional：有就用，没有就降级，比如没有 run 时召唤改成走过来。
 * feature 和 optional 都由 core/stage 处理，猫咪包照常加载。
 */
export type ClipNeed = 'required' | 'feature' | 'optional';

interface ClipSlot {
  kind: ClipKind;
  from: Pose;
  to: Pose;
  need: ClipNeed;
}

/**
 * 第一阶段每只猫都要做的片段（PRD 的"动作—素材—功能对照表"）。
 * 用这些名字的片段，类型和起止姿势必须和这里一致。
 * 窗口模式用的 jump-crouch、airborne 到 M4 才用到，现在先算 optional，M4 再按需要改。
 * "从各种姿势被拎起"要等真实片段的衔接实测结果，暂不列出。
 */
export const CLIP_SLOTS = {
  'idle-stand': { kind: 'loop', from: 'stand', to: 'stand', need: 'required' },
  walk: { kind: 'loop', from: 'stand', to: 'stand', need: 'required' },
  'idle-sit': { kind: 'loop', from: 'sit', to: 'sit', need: 'required' },
  sleep: { kind: 'loop', from: 'sleep', to: 'sleep', need: 'required' },
  run: { kind: 'loop', from: 'stand', to: 'stand', need: 'optional' },
  'stand-to-sit': { kind: 'transition', from: 'stand', to: 'sit', need: 'required' },
  'sit-to-stand': { kind: 'transition', from: 'sit', to: 'stand', need: 'required' },
  'sit-to-sleep': { kind: 'transition', from: 'sit', to: 'sleep', need: 'required' },
  'sleep-to-sit': { kind: 'transition', from: 'sleep', to: 'sit', need: 'required' },
  groom: { kind: 'action', from: 'sit', to: 'sit', need: 'optional' },
  stretch: { kind: 'action', from: 'stand', to: 'stand', need: 'optional' },
  yawn: { kind: 'action', from: 'sit', to: 'sit', need: 'optional' },
  meow: { kind: 'action', from: 'sit', to: 'sit', need: 'optional' },
  poked: { kind: 'action', from: 'sit', to: 'sit', need: 'optional' },
  purr: { kind: 'loop', from: 'sit', to: 'sit', need: 'feature' },
  dangle: { kind: 'loop', from: 'dangle', to: 'dangle', need: 'feature' },
  /** 下落。没有时用 dangle 代替。 */
  fall: { kind: 'loop', from: 'dangle', to: 'dangle', need: 'optional' },
  land: { kind: 'transition', from: 'dangle', to: 'stand', need: 'feature' },
  stalk: { kind: 'transition', from: 'stand', to: 'crouch', need: 'optional' },
  pounce: { kind: 'transition', from: 'crouch', to: 'stand', need: 'optional' },
  'jump-crouch': { kind: 'transition', from: 'stand', to: 'crouch', need: 'optional' },
  airborne: { kind: 'loop', from: 'airborne', to: 'airborne', need: 'optional' },
} as const satisfies Record<string, ClipSlot>;
export type ClipSlotName = keyof typeof CLIP_SLOTS;

/**
 * 哪些片段会出声、出哪种声（D11，M2 #52）。声音文件来自 cat.json 的 sounds，
 * 什么时候开始和停止见 core-api.ts 的 SoundCue。
 */
export const CLIP_SOUNDS = {
  meow: 'meow',
  purr: 'purr',
} as const satisfies Partial<Record<ClipSlotName, CatSound>>;

export function isClipSlotName(name: string): name is ClipSlotName {
  return Object.hasOwn(CLIP_SLOTS, name);
}

/** 一只猫缺了哪些 required 片段（按 CLIP_SLOTS 的顺序）。缺任何一个，这只猫的猫咪包就要整只停用。 */
export function missingRequiredClips(clipNames: Iterable<string>): ClipSlotName[] {
  const have = new Set(clipNames);
  return (Object.keys(CLIP_SLOTS) as ClipSlotName[]).filter(
    (name) => CLIP_SLOTS[name].need === 'required' && !have.has(name),
  );
}

export const ClipSchema = z
  .strictObject({
    ...JsonSchemaRefField,
    schemaVersion: SchemaVersionSchema,
    /** 片段名。用 CLIP_SLOTS 里的名字，或者自己起名的可选片段（比如 `walk-toward-camera`）。 */
    name: IdSchema,
    /** 同一个片段名的第几个版本，从 1 开始（防止看腻，D7）。 */
    variant: z.int().min(1),
    kind: ClipKindSchema,
    fromPose: PoseSchema,
    toPose: PoseSchema,
    /** 是否可选：可选片段有就用，没有也不影响运行。 */
    optional: z.boolean(),
    /** 视频文件：带透明通道的 VP9 WebM（ADR-0002，待 M0 验证）。 */
    video: PackPathSchema,
    /** 点击遮罩文件（ADR-0003），格式见 `src/shared/hitmask.ts`。 */
    hitMask: PackPathSchema,
    /** 点击遮罩的缩小倍数：遮罩的每一格对应片段画面里 hitMaskScale × hitMaskScale 个像素。 */
    hitMaskScale: z.int().min(1).max(16),
    fps: z.number().positive(),
    frameCount: z.int().positive(),
    width: z.int().positive(),
    height: z.int().positive(),
    /** 落脚锚点（FootAnchor）：逐帧记录，长度必须等于 frameCount。 */
    footAnchors: z.array(PointSchema),
    /** 能不能左右镜像使用。 */
    mirrorable: z.boolean(),
    /** 猫在片段里朝向哪边。 */
    facing: z.enum(['left', 'right']),
    /** 移动速度：100% 缩放下每秒移动多少像素。原地不动的片段写 0。 */
    speed: z.number().min(0),
    /** 关键点：比如 `nose`。每个关键点逐帧记录，看不到的帧写 null。 */
    keypoints: z.record(IdSchema, z.array(PointSchema.nullable())),
    /**
     * 声音从第几帧开始播放（从 0 算起），没写就从片段开头。只对 CLIP_SOUNDS 里列出的片段
     * （meow 叫一声、purr 被撸时呼噜）有用，其他片段写了也不出声。规则见 core-api.ts 的 SoundCue。
     */
    soundStartFrame: z.int().min(0).optional(),
  })
  .superRefine((clip, ctx) => {
    const v = zh.validation;
    if (isClipSlotName(clip.name)) {
      const slot: ClipSlot = CLIP_SLOTS[clip.name];
      if (clip.kind !== slot.kind) {
        ctx.addIssue({ code: 'custom', path: ['kind'], message: v.slotKind(clip.name, slot.kind) });
      }
      if (clip.fromPose !== slot.from || clip.toPose !== slot.to) {
        ctx.addIssue({
          code: 'custom',
          path: ['fromPose'],
          message: v.slotPoses(clip.name, slot.from, slot.to),
        });
      }
    } else if (!clip.optional) {
      ctx.addIssue({ code: 'custom', path: ['name'], message: v.unknownSlotMustBeOptional });
    }
    if (clip.kind === 'transition' && clip.fromPose === clip.toPose) {
      ctx.addIssue({ code: 'custom', path: ['toPose'], message: v.transitionSamePose });
    }
    if (clip.kind !== 'transition' && clip.fromPose !== clip.toPose) {
      ctx.addIssue({ code: 'custom', path: ['toPose'], message: v.nonTransitionPoseChange });
    }
    if (clip.footAnchors.length !== clip.frameCount) {
      ctx.addIssue({
        code: 'custom',
        path: ['footAnchors'],
        message: v.perFrameLength(clip.footAnchors.length, clip.frameCount),
      });
    }
    for (const [key, frames] of Object.entries(clip.keypoints)) {
      if (frames.length !== clip.frameCount) {
        ctx.addIssue({
          code: 'custom',
          path: ['keypoints', key],
          message: v.perFrameLength(frames.length, clip.frameCount),
        });
      }
    }
    if (clip.soundStartFrame !== undefined && clip.soundStartFrame >= clip.frameCount) {
      ctx.addIssue({
        code: 'custom',
        path: ['soundStartFrame'],
        message: v.frameOutOfRange(clip.soundStartFrame, clip.frameCount),
      });
    }
  });
export type Clip = z.infer<typeof ClipSchema>;
