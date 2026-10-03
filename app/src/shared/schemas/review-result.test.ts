import { describe, expect, it } from 'vitest';
import { CandidateAssessmentSchema } from './candidate-manifest';
import { ReviewResultSchema, validateReviewResult, type ReviewResult } from './review-result';

function result(): ReviewResult {
  return {
    schemaVersion: 1,
    cat: 'test-cat',
    candidateId: 'walk-001',
    candidateManifestSha256: 'a'.repeat(64),
    source: { sha256: 'b'.repeat(64), width: 100, height: 80, fps: 24, frameCount: 6 },
    kind: 'loop',
    selection: {
      trimStart: 1,
      trimEnd: 6,
      loopStart: 2,
      loopEnd: 5,
      footAnchors: Array.from({ length: 6 }, () => ({ x: 50, y: 79 })),
      keypoints: { nose: [null, ...Array.from({ length: 5 }, () => ({ x: 70, y: 20 }))] },
      speed: 0,
      soundStartFrame: 2,
    },
    accepted: true,
    note: '人工已确认，保留看不见的关键点为 null',
    manualSeconds: 12.5,
  };
}

describe('挑片台的挑选结果', () => {
  it('保留所有原始帧的点，只在导出时裁剪；草稿也能保存', () => {
    const data = result();
    expect(ReviewResultSchema.parse(data)).toEqual(data);
    expect(ReviewResultSchema.parse({ ...data, accepted: false }).accepted).toBe(false);
    delete data.selection.soundStartFrame;
    expect(ReviewResultSchema.parse(data).selection.soundStartFrame).toBeUndefined();
  });

  it.each([
    { trimStart: 3, trimEnd: 3 },
    { trimStart: 4, trimEnd: 2 },
    { trimEnd: 7 },
    { trimStart: -1 },
    { trimEnd: 5.5 },
    { loopStart: 0 },
    { loopStart: 4, loopEnd: 4 },
    { loopEnd: 7 },
    { loopStart: 5, loopEnd: 2 },
  ])('拒绝空区间、反向、越界和非整数帧号：%j', (patch) => {
    const data = result();
    expect(
      ReviewResultSchema.safeParse({ ...data, selection: { ...data.selection, ...patch } }).success,
    ).toBe(false);
  });

  it.each(['loop', 'transition', 'action'] as const)(
    '%s 的声音使用实际导出区间，结束帧不可用',
    (kind) => {
      const data = { ...result(), kind };
      const [start, end] = kind === 'loop' ? [2, 5] : [1, 6];
      for (const frame of [start, end - 1]) {
        data.selection.soundStartFrame = frame;
        expect(ReviewResultSchema.safeParse(data).success).toBe(true);
      }
      for (const frame of [start - 1, end]) {
        data.selection.soundStartFrame = frame;
        expect(ReviewResultSchema.safeParse(data).success).toBe(false);
      }
    },
  );

  it('逐帧数量必须覆盖原始帧，坐标必须在原始尺寸内', () => {
    const data = result();
    data.selection.footAnchors = data.selection.footAnchors.slice(2, 5);
    data.selection.keypoints['nose'] = [{ x: 100, y: 20 }];
    const validation = validateReviewResult(data, { cat: data.cat, candidateId: data.candidateId });
    expect(validation.ok).toBe(false);
    if (validation.ok) throw new Error('expected invalid result');
    expect(validation.problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('footAnchors（落脚锚点）'),
        expect.stringContaining('keypoints.nose'),
        expect.stringContaining('原始画面内'),
      ]),
    );
  });

  it.each([
    { x: -1, y: 10 },
    { x: 10, y: -1 },
    { x: 100, y: 10 },
    { x: 10, y: 80 },
    { x: NaN, y: 10 },
    { x: 10, y: Infinity },
  ])('锚点和关键点都拒绝无效坐标：%j', (point) => {
    for (const track of ['footAnchors', 'keypoints'] as const) {
      const data = result();
      if (track === 'footAnchors') data.selection.footAnchors[0] = point;
      else data.selection.keypoints['nose'] = [point, ...data.selection.footAnchors.slice(1)];
      expect(ReviewResultSchema.safeParse(data).success).toBe(false);
    }
  });

  it.each([
    { schemaVersion: 2 },
    { candidateManifestSha256: 'A'.repeat(64) },
    { candidateManifestSha256: `${'a'.repeat(64)}\n` },
    { manualSeconds: Infinity },
    { manualSeconds: -1 },
    { unexpected: true },
  ])('拒绝未知版本、伪校验值、无效用时和未知字段：%j', (patch) => {
    expect(ReviewResultSchema.safeParse({ ...result(), ...patch }).success).toBe(false);
  });

  it('源信息拒绝无效哈希、尺寸、帧率和未知字段', () => {
    for (const patch of [
      { sha256: 'x'.repeat(64) },
      { width: 0 },
      { height: 2.5 },
      { frameCount: 0 },
      { fps: 0 },
      { fps: 121 },
      { fps: Infinity },
      { filename: '../other.mp4' },
    ]) {
      const data = result();
      expect(
        ReviewResultSchema.safeParse({ ...data, source: { ...data.source, ...patch } }).success,
      ).toBe(false);
    }
  });

  it('缺字段时用中文指出猫、候选和字段，身份不能串到别的候选', () => {
    const data = result();
    const expected = { cat: data.cat, candidateId: data.candidateId };
    expect(validateReviewResult({ ...data, selection: undefined }, expected)).toEqual({
      ok: false,
      problems: ['猫「test-cat」候选「walk-001」：缺少必填字段 selection（人工挑选参数）'],
    });
    expect(validateReviewResult({ ...data, cat: 'other-cat' }, expected)).toEqual({
      ok: false,
      problems: [expect.stringContaining('猫或候选 id')],
    });
    expect(validateReviewResult({ ...data, candidateId: 'walk-002' }, expected).ok).toBe(false);
    expect(validateReviewResult(data, expected)).toEqual({ ok: true, value: data });
  });
});

describe('候选的自动评分只供参考', () => {
  it('允许 0～100 的分数，必须带非空原因', () => {
    expect(CandidateAssessmentSchema.parse({ score: 89.5, reasons: ['首尾轮廓接近'] })).toEqual({
      score: 89.5,
      reasons: ['首尾轮廓接近'],
    });
    for (const assessment of [
      { score: -1, reasons: ['原因'] },
      { score: 101, reasons: ['原因'] },
      { score: Infinity, reasons: ['原因'] },
      { score: 80, reasons: [] },
      { score: 80, reasons: ['  '] },
      { score: 80, reasons: ['原因'], accepted: true },
    ]) {
      expect(CandidateAssessmentSchema.safeParse(assessment).success).toBe(false);
    }
  });
});
