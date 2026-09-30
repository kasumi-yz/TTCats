// 草稿，M0 后定稿。
// 片段（Clip）元数据：猫咪包里 clips/ 下每个 *.webm 旁边的同名 *.json（设计方案第三章）。
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
import { PoseSchema, type Pose } from './pose';

/**
 * 片段类型：循环片段（LoopClip）、过渡片段（TransitionClip）、动作片段（ActionClip）。
 * 互动片段和事件片段到第二阶段再加。
 */
export const ClipKindSchema = z.enum(['loop', 'transition', 'action']);
export type ClipKind = z.infer<typeof ClipKindSchema>;

interface ClipSlot {
  kind: ClipKind;
  from: Pose;
  to: Pose;
}

/**
 * 第一阶段每只猫都要做的片段（PRD 的"动作—素材—功能对照表"）。
 * 用这些名字的片段，类型和起止姿势必须和这里一致。
 * 哪些是必需的、缺失时怎么降级，由 core/stage 决定，不写在这里。
 * "从各种姿势被拎起"要等 M0 的衔接实测结果，暂不列出。
 */
export const CLIP_SLOTS = {
  'idle-stand': { kind: 'loop', from: 'stand', to: 'stand' },
  walk: { kind: 'loop', from: 'stand', to: 'stand' },
  'idle-sit': { kind: 'loop', from: 'sit', to: 'sit' },
  sleep: { kind: 'loop', from: 'sleep', to: 'sleep' },
  run: { kind: 'loop', from: 'stand', to: 'stand' },
  'stand-to-sit': { kind: 'transition', from: 'stand', to: 'sit' },
  'sit-to-stand': { kind: 'transition', from: 'sit', to: 'stand' },
  'sit-to-sleep': { kind: 'transition', from: 'sit', to: 'sleep' },
  'sleep-to-sit': { kind: 'transition', from: 'sleep', to: 'sit' },
  groom: { kind: 'action', from: 'sit', to: 'sit' },
  stretch: { kind: 'action', from: 'stand', to: 'stand' },
  yawn: { kind: 'action', from: 'sit', to: 'sit' },
  meow: { kind: 'action', from: 'sit', to: 'sit' },
  poked: { kind: 'action', from: 'sit', to: 'sit' },
  purr: { kind: 'loop', from: 'sit', to: 'sit' },
  dangle: { kind: 'loop', from: 'dangle', to: 'dangle' },
  fall: { kind: 'loop', from: 'dangle', to: 'dangle' },
  land: { kind: 'transition', from: 'dangle', to: 'stand' },
  stalk: { kind: 'transition', from: 'stand', to: 'crouch' },
  pounce: { kind: 'transition', from: 'crouch', to: 'stand' },
  'jump-crouch': { kind: 'transition', from: 'stand', to: 'crouch' },
  airborne: { kind: 'loop', from: 'airborne', to: 'airborne' },
} as const satisfies Record<string, ClipSlot>;
export type ClipSlotName = keyof typeof CLIP_SLOTS;

export function isClipSlotName(name: string): name is ClipSlotName {
  return Object.hasOwn(CLIP_SLOTS, name);
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
    /** 点击遮罩文件（ADR-0003）。具体格式等素材工厂 v0 定。 */
    hitMask: PackPathSchema,
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
    /** 声音从第几帧开始播放（从 0 算起）。没有声音就不写。 */
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
