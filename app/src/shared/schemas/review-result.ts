// #129：挑片台（#104）与素材工厂（#105）共用的人工挑选结果。
// 帧号和坐标始终来自 ingest 拆帧，不能混用已裁剪、对齐或镜像的候选画面。
import { z } from 'zod';
import { zh } from '../strings.zh-CN';
import { ClipKindSchema } from './clip';
import { IdSchema, JsonSchemaRefField, SchemaVersionSchema } from './common';
import { validateWith, type ValidationResult } from './validate';

const FrameSchema = z.int().min(0);
const SourcePointSchema = z.strictObject({ x: z.number().min(0), y: z.number().min(0) });
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}(?![\s\S])/, {
  error: zh.reviewResult.sha256Format,
});

/** 与 ingest.json 对照；sha256 是原始视频的字节哈希，尺寸/帧数来自实际拆帧。 */
export const ReviewSourceSchema = z.strictObject({
  sha256: Sha256Schema,
  width: z.int().positive(),
  height: z.int().positive(),
  fps: z.number().positive().max(120),
  frameCount: z.int().positive(),
});

export const ReviewResultSchema = z
  .strictObject({
    ...JsonSchemaRefField,
    schemaVersion: SchemaVersionSchema,
    cat: IdSchema,
    candidateId: IdSchema,
    /** 加载时 manifest.json 的原始字节哈希；保存/导出时防止候选被替换。 */
    candidateManifestSha256: Sha256Schema,
    source: ReviewSourceSchema,
    /** 必须与候选 clip.kind 一致，决定导出用循环区间还是裁剪区间。 */
    kind: ClipKindSchema,
    selection: z.strictObject({
      /** 从 0 算起，区间为 [start, end)，end 不包含在内。 */
      trimStart: FrameSchema,
      trimEnd: z.int().positive(),
      loopStart: FrameSchema,
      loopEnd: z.int().positive(),
      /** 所有源帧都保留；坐标是未镜像、未对齐的原始画面像素。 */
      footAnchors: z.array(SourcePointSchema),
      keypoints: z.record(IdSchema, z.array(SourcePointSchema.nullable())),
      /** 原始画面中像素/秒，与素材工厂 Suggestion.speed 一致。 */
      speed: z.number().min(0),
      /** 原始帧号；没写则从最终片段的第 0 帧开始。 */
      soundStartFrame: FrameSchema.optional(),
    }),
    /** 只有人主动确认才能为 true；自动评分不改变这个值。 */
    accepted: z.boolean(),
    note: z.string(),
    /** 人实际花费的秒数；按真实经过的时间计，不包含自动处理用时。 */
    manualSeconds: z.number().min(0),
  })
  .superRefine((result, ctx) => {
    const text = zh.reviewResult;
    const { source, selection } = result;
    const add = (path: (string | number)[], message: string): void => {
      ctx.addIssue({ code: 'custom', path, message });
    };
    if (!(selection.trimStart < selection.trimEnd && selection.trimEnd <= source.frameCount)) {
      add(['selection', 'trimEnd'], text.trimRange);
    }
    if (!(
      selection.trimStart <= selection.loopStart &&
      selection.loopStart < selection.loopEnd &&
      selection.loopEnd <= selection.trimEnd
    )) {
      add(['selection', 'loopEnd'], text.loopRange);
    }
    const start = result.kind === 'loop' ? selection.loopStart : selection.trimStart;
    const end = result.kind === 'loop' ? selection.loopEnd : selection.trimEnd;
    if (
      selection.soundStartFrame !== undefined &&
      !(start <= selection.soundStartFrame && selection.soundStartFrame < end)
    ) {
      add(['selection', 'soundStartFrame'], text.soundRange);
    }
    const tracks = [
      { path: ['selection', 'footAnchors'], points: selection.footAnchors },
      ...Object.entries(selection.keypoints).map(([key, points]) => ({
        path: ['selection', 'keypoints', key],
        points,
      })),
    ];
    for (const { path, points } of tracks) {
      if (points.length !== source.frameCount) {
        add(path, zh.validation.perFrameLength(points.length, source.frameCount));
      }
      for (const [frame, point] of points.entries()) {
        if (point !== null && (point.x >= source.width || point.y >= source.height)) {
          add([...path, frame], text.pointBounds(source.width, source.height));
        }
      }
    }
  });

export type ReviewSource = z.infer<typeof ReviewSourceSchema>;
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

/** 调用方传入所加载候选的身份，让缺字段等错误也能指出是哪只猫、哪个候选。 */
export function validateReviewResult(
  data: unknown,
  expected: { cat: string; candidateId: string },
): ValidationResult<ReviewResult> {
  const result = validateWith(ReviewResultSchema, data);
  const context = zh.reviewResult.context(expected.cat, expected.candidateId);
  if (!result.ok) {
    return { ok: false, problems: result.problems.map((problem) => `${context}${problem}`) };
  }
  if (result.value.cat !== expected.cat || result.value.candidateId !== expected.candidateId) {
    return { ok: false, problems: [`${context}${zh.reviewResult.identityMismatch}`] };
  }
  return result;
}
