// 草稿，M0 后定稿。
// 姿势（Pose）：片段开头和结尾时猫必须处在的规范身体状态（ADR-0002）。
// "腾空能不能和悬空共用"要等 M0 确认，所以这里暂时分开列出。
import { z } from 'zod';

/** 基础姿势（BasePose）：站、坐、睡。猫可以长时间保持。 */
export const BasePoseSchema = z.enum(['stand', 'sit', 'sleep']);
export type BasePose = z.infer<typeof BasePoseSchema>;

/** 连接姿势（LinkPose）：悬空、伏低、腾空。只在特定动作中短暂经过。 */
export const LinkPoseSchema = z.enum(['dangle', 'crouch', 'airborne']);
export type LinkPose = z.infer<typeof LinkPoseSchema>;

export const PoseSchema = z.enum([...BasePoseSchema.options, ...LinkPoseSchema.options]);
export type Pose = z.infer<typeof PoseSchema>;
