// M3 定稿（#106）。
// 事件（Event）配置：content/events/ 下每个 *.json 是一个事件（D6）。
// 事件什么时候触发、哪几只猫参与由 core/game 在主进程里判断（ADR-0004）；怎么演由 core/stage 在桌面层执行。
// 事件对所有猫都一样，猫和猫的差别只来自性格参数和关系（ADR-0005），所以这里不能写某只猫的 id。
import { z } from 'zod';
import { zh } from '../strings.zh-CN';
import { PersonalitySchema, SoundSlotsSchema } from './cat';
import { IdSchema, JsonSchemaRefField, SchemaVersionSchema, TimeOfDaySchema } from './common';
import { BasePoseSchema } from './pose';

/** 公历的月和日，格式 MM-DD。按月份检查天数，2 月 29 日算合法（只有闰年才有这一天）。 */
export const MonthDaySchema = z
  .string()
  .regex(
    /^(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|02-(?:0[1-9]|1[0-9]|2[0-9]))(?![\s\S])/,
    { error: zh.validation.monthDayFormat },
  );

/** 农历的月和日，格式 MM-DD：月 01～12，日 01～30。 */
export const LunarMonthDaySchema = z
  .string()
  .regex(/^(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|30)(?![\s\S])/, {
    error: zh.validation.lunarMonthDayFormat,
  });

/**
 * 触发条件。按真实时间（加上调试台快进的偏移）判断，日期和时刻都按用户的本地时间。
 * 勿扰模式、全屏被自动隐藏、一键隐藏、安全模式、没有显示中的猫时一律不触发；错过的不补发（D16）。
 */
export const EventTriggerSchema = z.discriminatedUnion('type', [
  /** 随机：平均每小时触发几次。实际频率还会按活跃度和参与的猫的性格参数调整（core/game 定）。 */
  z.strictObject({ type: z.literal('random'), perHour: z.number().positive() }),
  /**
   * 当天第一次开机（早安）：按本地日期，一天只一次。程序启动、系统睡眠或锁屏后回来，如果是当天第一次见到用户，都算。
   * 这一天的早安被勿扰等挡住了也算处理过，不补发（存档的 events.firstLaunchHandledOn）。
   */
  z.strictObject({ type: z.literal('firstLaunchOfDay') }),
  /** 每天的某个时间段内（比如深夜犯困）。可以跨午夜，比如 23:00～05:00。包括开始那一分钟，不包括结束那一分钟。 */
  z.strictObject({ type: z.literal('timeOfDay'), from: TimeOfDaySchema, to: TimeOfDaySchema }),
  /**
   * 用户状态变化：离开（away）、回来（back）、坐太久（sedentary）。
   * 只根据系统空闲时间和锁屏、睡眠判断（D6，见 core-api.ts 的 UserStateSignal）。坐太久在设置里关掉久坐提醒时不触发。
   */
  z.strictObject({
    type: z.literal('userState'),
    state: z.enum(['away', 'back', 'sedentary']),
  }),
  /**
   * 今天是某只显示中的猫的生日或到家纪念日（按本地日期，每年这一天）。用设置里用户填的日期，没填用猫咪包里的。
   * 2 月 29 日的日期在平年怎么算由 core/game 定。
   */
  z.strictObject({ type: z.literal('catDate'), date: z.enum(['birthday', 'homeDate']) }),
  /** 每年固定公历日期的节日，比如元旦 01-01、国庆 10-01。 */
  z.strictObject({ type: z.literal('holiday'), date: MonthDaySchema }),
  /**
   * 每年固定农历日期的节日，比如春节 01-01、中秋 08-15。按 `src/shared/lunar-calendar.ts` 换算（农历 2000～2099 年）。
   * 只在不闰的那个月触发：闰月里的同一天不算（比如闰五月初五不是端午）。
   * 写 30 日时，那个月只有 29 天的年份不触发。
   */
  z.strictObject({ type: z.literal('lunarHoliday'), date: LunarMonthDaySchema }),
]);
export type EventTrigger = z.infer<typeof EventTriggerSchema>;

/** 性格参数的名字，比如 activity（活跃）。 */
export const PersonalityTraitSchema = PersonalitySchema.keyof();
export type PersonalityTrait = z.infer<typeof PersonalityTraitSchema>;

/**
 * 哪几只猫参与。候选只算显示中、猫咪包已加载、有 requiredClips 里全部片段的猫；
 * 同一只猫同一时间只参与一个事件（core/game 管）。凑不够时整个事件不触发。
 */
export const EventCatsSchema = z.discriminatedUnion('pick', [
  /** 全部候选的猫，比如"你离开了""你回来了"。 */
  z.strictObject({ pick: z.literal('all') }),
  /** 今天过生日或到家纪念日的猫（几只同一天就一起参加）。只能和 catDate 触发条件一起用。 */
  z.strictObject({ pick: z.literal('dateOwner') }),
  /**
   * 按某项性格参数随机挑 min～max 只：prefer 为 high 时参数越高越容易被挑中，low 时越低越容易。
   * 具体怎么加权由 core/game 定，参数为 0 的猫也要有机会。
   */
  z.strictObject({
    pick: z.literal('weighted'),
    by: PersonalityTraitSchema,
    prefer: z.enum(['high', 'low']),
    min: z.int().min(1),
    max: z.int().min(1),
  }),
]);
export type EventCats = z.infer<typeof EventCatsSchema>;

/** 移动的目标。 */
export const EventTargetSchema = z.enum([
  /** 地板上随机的一个位置。 */
  'random',
  /** 屏幕的另一侧：猫在左半边就去右边，在右半边就去左边（跑酷来回跑）。 */
  'oppositeSide',
  /** 鼠标附近（迎接）。桌面层不知道鼠标在哪时，去地板中间。 */
  'pointer',
  /**
   * 这只猫在本事件里最近一次放出的特效，比如飞虫。只能用在放特效的步骤之后。
   * 特效已经播完（比如片段比预想的长、随机等待太久）时：face 跳过这一步，moveTo 走到特效最后在的位置。
   */
  'effect',
]);
export type EventTarget = z.infer<typeof EventTargetSchema>;

/**
 * 事件能放的特效（M3）。桌面层按 id 画（#110），位置由 core/stage 定，特效不挡鼠标：
 * - hearts：爱心，在猫身边冒出来（和撸猫的一样）
 * - bug：飞虫，出现在猫前方的半空，之后由 core/stage 每帧算它的位置（绕着飞、会停顿）
 * - confetti：彩纸和小星星，从猫的头顶上方散开、落下（节日、生日）
 * - lantern：灯笼，放在猫脚边的地板上（地板装饰）
 * - gift：小礼物盒，放在猫脚边的地板上（地板装饰）
 */
export const EventEffectSchema = z.enum(['hearts', 'bug', 'confetti', 'lantern', 'gift']);
export type EventEffect = z.infer<typeof EventEffectSchema>;

/** 气泡文字里可以写的占位：{name} 换成这只猫的名字。 */
export const BUBBLE_PLACEHOLDERS = ['name'] as const;

const BubbleTextSchema = z
  .string()
  .min(1)
  .superRefine((text, ctx) => {
    for (const match of text.matchAll(/\{([^{}]*)\}/g)) {
      const name = match[1] ?? '';
      if (!(BUBBLE_PLACEHOLDERS as readonly string[]).includes(name)) {
        ctx.addIssue({ code: 'custom', message: zh.validation.unknownPlaceholder(name) });
      }
    }
  });

/**
 * 事件的一步。每只参与的猫各自按顺序执行全部步骤（各演各的，同时开始），所以多只猫参与时，
 * 用 wait 的随机时长让它们错开（比如"陆续去睡觉"）。
 * 会等它做完再做下一步的：goToPose、playClip、moveTo、face、wait、stay。
 * 不等、马上接着做下一步的：bubble、effect、sound。
 */
export const EventStepSchema = z.discriminatedUnion('do', [
  /** 按姿势网络走到某个基础姿势（站、坐、睡）。用必需片段就一定能走到。 */
  z.strictObject({ do: z.literal('goToPose'), pose: BasePoseSchema }),
  /**
   * 播放某个片段若干次（默认 1 次）。这只猫没有这个片段时跳过这一步；
   * 想要"缺了这个片段就不参加"，把它写进事件的 requiredClips。
   */
  z.strictObject({
    do: z.literal('playClip'),
    clip: IdSchema,
    times: z.int().min(1).optional(),
  }),
  /**
   * 走或跑到某个位置，到了以后面朝目标（random、oppositeSide 面朝走的方向）。
   * 跑（run）要用 run 片段，没有时改成走；想要"没有 run 就不参加"，把 run 写进 requiredClips。
   */
  z.strictObject({
    do: z.literal('moveTo'),
    target: EventTargetSchema,
    gait: z.enum(['walk', 'run']),
  }),
  /** 原地转向目标所在的一侧，比如盯住飞虫。 */
  z.strictObject({
    do: z.literal('face'),
    target: EventTargetSchema.extract(['pointer', 'effect']),
  }),
  /** 在猫头顶冒一个气泡，从 texts 里随机挑一句。气泡显示 durationMs 毫秒。 */
  z.strictObject({
    do: z.literal('bubble'),
    texts: z.array(BubbleTextSchema).min(1),
    durationMs: z.int().positive(),
  }),
  /** 放一个特效，持续 durationMs 毫秒。特效的位置见 EventEffectSchema。 */
  z.strictObject({
    do: z.literal('effect'),
    effect: EventEffectSchema,
    durationMs: z.int().positive(),
  }),
  /** 发出猫咪包声音位里的一种声音。照样受声音开关、安静时段、勿扰的限制。 */
  z.strictObject({ do: z.literal('sound'), slot: SoundSlotsSchema.keyof() }),
  /** 等 minMs～maxMs 毫秒（每只猫各自随机）。两个数一样就是固定时长。 */
  z.strictObject({ do: z.literal('wait'), minMs: z.int().min(0), maxMs: z.int().positive() }),
  /**
   * 保持现在的样子，一直到被打断，或者被新的事件接管（比如"你离开了"睡着，等"你回来了"）。只能是最后一步。
   * 停在这一步的猫一直算在这个事件里，不管多久都不会因为时间到了自己结束（桌面层重新加载除外），随机事件不会挑它。
   */
  z.strictObject({ do: z.literal('stay') }),
]);
export type EventStep = z.infer<typeof EventStepSchema>;

export const EventSchema = z
  .strictObject({
    ...JsonSchemaRefField,
    schemaVersion: SchemaVersionSchema,
    /** 事件 id，必须和文件名（不含 .json）一样。 */
    id: IdSchema,
    /** 在调试台里显示的名字。 */
    name: z.string().min(1),
    trigger: EventTriggerSchema,
    /** 冷却时间（分钟），从上次触发的那一刻起，按真实经过的时间计算（ADR-0004）。 */
    cooldownMinutes: z.number().min(0),
    cats: EventCatsSchema,
    /**
     * 参与的猫必须有的片段名（任何一个版本都行）。缺了其中任何一个的猫不参加这个事件；
     * 候选的猫因此凑不够时，整个事件不触发。不在这里的片段，缺了只跳过那一步。
     */
    requiredClips: z.array(IdSchema),
    steps: z.array(EventStepSchema).min(1),
  })
  .superRefine((event, ctx) => {
    const v = zh.validation;
    if (event.cats.pick === 'weighted' && event.cats.max < event.cats.min) {
      ctx.addIssue({ code: 'custom', path: ['cats', 'max'], message: v.maxBelowMin });
    }
    if (event.cats.pick === 'dateOwner' && event.trigger.type !== 'catDate') {
      ctx.addIssue({ code: 'custom', path: ['cats', 'pick'], message: v.dateOwnerNeedsCatDate });
    }
    if (event.trigger.type === 'timeOfDay' && event.trigger.from === event.trigger.to) {
      ctx.addIssue({ code: 'custom', path: ['trigger', 'to'], message: v.emptyTimeRange });
    }
    let effectPlaced = false;
    event.steps.forEach((step, i) => {
      if (step.do === 'stay' && i !== event.steps.length - 1) {
        ctx.addIssue({ code: 'custom', path: ['steps', i], message: v.stayMustBeLast });
      }
      if (step.do === 'wait' && step.maxMs < step.minMs) {
        ctx.addIssue({ code: 'custom', path: ['steps', i, 'maxMs'], message: v.maxMsBelowMinMs });
      }
      if (
        (step.do === 'moveTo' || step.do === 'face') &&
        step.target === 'effect' &&
        !effectPlaced
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['steps', i, 'target'],
          message: v.effectTargetFirst,
        });
      }
      if (step.do === 'effect') effectPlaced = true;
    });
  });
export type EventConfig = z.infer<typeof EventSchema>;
