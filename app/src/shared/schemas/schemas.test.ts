import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { CandidateManifestSchema } from './candidate-manifest';
import { CatSchema } from './cat';
import { ClipSchema, type Clip } from './clip';
import { EventSchema } from './event';
import { zh } from '../strings.zh-CN';
import { DateSchema, PackPathSchema, TimeOfDaySchema } from './common';
import { EventTriggerSchema } from './event';
import { validateWith } from './validate';
import { CLIP_SLOTS, missingRequiredClips } from './clip';
import { defaultSettings, SettingsSchema } from './settings';
import {
  CURRENT_SAVE_VERSION,
  defaultGameState,
  GameStateSchema,
  SaveEnvelopeSchema,
} from './save';

function clip(overrides: Partial<Clip> = {}): Clip {
  return {
    schemaVersion: 1,
    name: 'stand-to-sit',
    variant: 1,
    kind: 'transition',
    fromPose: 'stand',
    toPose: 'sit',
    optional: false,
    video: 'clips/stand-to-sit.webm',
    hitMask: 'clips/stand-to-sit.hitmask.bin',
    hitMaskScale: 4,
    fps: 24,
    frameCount: 3,
    width: 512,
    height: 512,
    footAnchors: [
      { x: 256, y: 500 },
      { x: 256, y: 500 },
      { x: 256, y: 500 },
    ],
    mirrorable: true,
    facing: 'right',
    speed: 0,
    keypoints: {},
    ...overrides,
  };
}

function problemsOf(schema: z.ZodType, data: unknown): string[] {
  const result = validateWith(schema, data);
  return result.ok ? [] : result.problems;
}

describe('片段元数据', () => {
  it('合法的过渡片段能通过', () => {
    expect(problemsOf(ClipSchema, clip())).toEqual([]);
  });

  it('标准片段的起止姿势必须和片段表一致', () => {
    expect(problemsOf(ClipSchema, clip({ toPose: 'sleep' }))).toEqual([
      '字段 fromPose（开始姿势） 不对：片段「stand-to-sit」必须从「站」开始、在「坐」结束',
    ]);
  });

  it('落脚锚点必须逐帧记录', () => {
    expect(problemsOf(ClipSchema, clip({ footAnchors: [{ x: 0, y: 0 }] }))).toEqual([
      '字段 footAnchors（落脚锚点） 不对：需要逐帧记录，应有 3 项，实际有 1 项',
    ]);
  });

  it('不在片段表里的片段必须标成可选', () => {
    const custom = clip({ name: 'walk-toward-camera', kind: 'loop', toPose: 'stand' });
    expect(problemsOf(ClipSchema, custom)).toEqual([
      '字段 name（名字） 不对：不在标准片段表里的片段名，必须标成可选（optional: true）',
    ]);
    expect(problemsOf(ClipSchema, { ...custom, optional: true })).toEqual([]);
  });

  it('路径不能跳出猫咪包', () => {
    expect(problemsOf(ClipSchema, clip({ video: '../other/x.webm' }))).toEqual([
      `字段 video（视频文件） 不对：${zh.validation.packPathFormat}`,
    ]);
  });

  it.each([
    '../x.webm',
    'clips/../../x.webm',
    'clips/..',
    './x.webm',
    'clips/./x.webm',
    '/abs/x.webm',
    'clips//x.webm',
    'clips/',
    'clips\\x.webm',
    'C:/x.webm',
    '\n/../../../../outside.ogg',
    'clips/x.webm\n',
    '\r/../x.webm',
    'clips/\u0000x.webm',
    '',
  ])('不合法的猫咪包路径 %j 会被拒绝', (path) => {
    expect(PackPathSchema.safeParse(path).success).toBe(false);
  });

  it.each([
    'x.webm',
    'clips/walk.v2.webm',
    'sounds/meow-1.ogg',
    'a/b/c/..d.png',
    'clips/豆豆.webm',
  ])('合法的猫咪包路径 %j 能通过', (path) => {
    expect(PackPathSchema.safeParse(path).success).toBe(true);
  });
});

describe('猫咪包 cat.json', () => {
  const cat = {
    schemaVersion: 1,
    id: 'kubo',
    name: '库啵',
    relativeSize: 0.9,
    personality: { activity: 0.4, clinginess: 0.8, initiative: 0.3, dominance: 0.2, patience: 0.7 },
    relationships: [{ cat: 'majiang', closeness: 0.9, dominance: -0.4 }],
    sounds: { meow: [], purr: [] },
  };

  it('生日和到家日可以不写', () => {
    expect(problemsOf(CatSchema, cat)).toEqual([]);
  });

  it('不能和自己建立关系', () => {
    const selfRel = { ...cat, relationships: [{ cat: 'kubo', closeness: 1, dominance: 0 }] };
    expect(problemsOf(CatSchema, selfRel)).toEqual([
      '字段 relationships[0].cat（猫） 不对：不能和自己建立关系',
    ]);
  });

  it('嵌套对象里拼错的字段会带上路径', () => {
    const typo = { ...cat, personality: { ...cat.personality, activty: 0.5 } };
    expect(problemsOf(CatSchema, typo)).toEqual([
      'personality（性格参数） 里有不认识的字段：activty（是不是拼错了？）',
    ]);
  });

  it('日期格式错误时报中文', () => {
    expect(problemsOf(CatSchema, { ...cat, birthday: '2020/1/1' })).toEqual([
      '字段 birthday（生日） 不对：日期格式应为 YYYY-MM-DD',
    ]);
  });
});

describe('事件配置', () => {
  const event = {
    schemaVersion: 1,
    id: 'late-night-sleepy',
    name: '深夜犯困',
    trigger: { type: 'timeOfDay', from: '23:00', to: '05:00' },
    cooldownMinutes: 60,
    cats: { min: 1, max: 1 },
    steps: [
      { do: 'goToPose', pose: 'sit' },
      { do: 'playClip', clip: 'yawn' },
    ],
  };

  it('合法的事件能通过', () => {
    expect(problemsOf(EventSchema, event)).toEqual([]);
  });

  it.each(['01-31', '02-28', '02-29', '04-30', '12-31'])('节日日期 %s 合法', (date) => {
    expect(problemsOf(EventTriggerSchema, { type: 'holiday', date })).toEqual([]);
  });

  it.each(['02-30', '02-31', '04-31', '06-31', '09-31', '11-31', '13-01', '00-10', '01-00'])(
    '节日日期 %s 不存在，会被拒绝',
    (date) => {
      expect(problemsOf(EventTriggerSchema, { type: 'holiday', date })).toEqual([
        `字段 date 不对：${zh.validation.monthDayFormat}`,
      ]);
    },
  );

  // Python 的 \d 会接受阿拉伯文等非 ASCII 数字；素材工厂用同样的正则，所以这里只允许 ASCII 数字
  it.each(['02-2١', '0٢-01'])('节日日期 %s 含非 ASCII 数字，会被拒绝', (date) => {
    expect(problemsOf(EventTriggerSchema, { type: 'holiday', date })).toHaveLength(1);
  });

  it.each(['0١:3٠', '２３:００'])('时刻 %s 含非 ASCII 数字，会被拒绝', (time) => {
    expect(TimeOfDaySchema.safeParse(time).success).toBe(false);
  });

  it.each(['2024-10-3٠', '２０２４-10-30'])('日期 %s 含非 ASCII 数字，会被拒绝', (date) => {
    expect(DateSchema.safeParse(date).success).toBe(false);
  });

  it('参与猫数的上下限要合理', () => {
    expect(problemsOf(EventSchema, { ...event, cats: { min: 2, max: 1 } })).toEqual([
      '字段 cats.max（最多几只） 不对：最多几只猫不能小于最少几只猫',
    ]);
  });
});

describe('素材工厂的候选 manifest', () => {
  it('合法的 manifest 能通过', () => {
    const manifest = {
      schemaVersion: 1,
      candidateId: 'stand-to-sit-001',
      cat: 'doudou',
      status: 'pending',
      assetLog: {
        generator: 'wan2.2-flf2v',
        modelFiles: ['wan2.2_i2v_high_noise_14B_Q4_K_M.gguf'],
        workflow: 'flf2v-v1.json',
        prompt: 'a cat sits down',
        params: { steps: 20, seed: 42 },
        attempt: 1,
        startPoseFrame: 'stand.png',
        endPoseFrame: 'sit.png',
        rawVideo: 'D:/assets/raw/doudou/stand-to-sit-001.mp4',
        createdAt: '2026-10-01T12:00:00+08:00',
      },
      clip: clip(),
    };
    expect(problemsOf(CandidateManifestSchema, manifest)).toEqual([]);
    const scored = CandidateManifestSchema.parse({
      ...manifest,
      assessment: { score: 100, reasons: ['自动初筛通过，仍需人工挑选'] },
    });
    expect(scored.status).toBe('pending');
    expect(scored.assessment?.score).toBe(100);
  });
});

describe('必需片段', () => {
  it('列出缺了哪些 required 片段，feature 和 optional 的不算', () => {
    expect(
      missingRequiredClips(['idle-stand', 'walk', 'idle-sit', 'sleep', 'stand-to-sit']),
    ).toEqual(['sit-to-stand', 'sit-to-sleep', 'sleep-to-sit']);
    const required = Object.entries(CLIP_SLOTS)
      .filter(([, slot]) => slot.need === 'required')
      .map(([name]) => name);
    expect(missingRequiredClips(required)).toEqual([]);
  });
});

describe('点击遮罩缩小倍数', () => {
  it('必须是 1～16 的整数', () => {
    expect(problemsOf(ClipSchema, clip({ hitMaskScale: 0 }))).toHaveLength(1);
    expect(problemsOf(ClipSchema, clip({ hitMaskScale: 2.5 }))).toHaveLength(1);
    expect(problemsOf(ClipSchema, clip({ hitMaskScale: 16 }))).toEqual([]);
  });
});

describe('设置和存档', () => {
  it('默认设置能通过校验，显示全部猫', () => {
    const settings = defaultSettings(['test-a', 'test-b']);
    expect(problemsOf(SettingsSchema, settings)).toEqual([]);
    expect(settings.visibleCats).toEqual(['test-a', 'test-b']);
    expect(settings.showInScreenCapture).toBe(false);
  });

  it('设置不合法时报中文，说清楚是哪个字段', () => {
    expect(problemsOf(SettingsSchema, { ...defaultSettings([]), scale: 3 })).toEqual([
      expect.stringContaining('scale（缩放）'),
    ]);
  });

  it('存档外层先校验版本号，里面的状态按当前版本校验', () => {
    const state = defaultGameState(['test-a']);
    expect(problemsOf(GameStateSchema, state)).toEqual([]);
    expect(
      problemsOf(SaveEnvelopeSchema, { saveVersion: CURRENT_SAVE_VERSION, savedAt: 1, state }),
    ).toEqual([]);
    expect(problemsOf(SaveEnvelopeSchema, { saveVersion: 0, savedAt: 1, state })).toHaveLength(1);
    expect(problemsOf(GameStateSchema, { ...state, extra: 1 })).toEqual([
      '有不认识的字段：extra（是不是拼错了？）',
    ]);
  });
});
