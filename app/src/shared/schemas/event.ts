// 草稿，M3（事件）定稿。
// 事件（Event）配置：content/events/ 下每个 *.json 是一个事件（D6）。
// 事件什么时候触发、冷却多久由 core/game 在主进程里判断；怎么演由 core/stage 在桌面层执行。
import { z } from 'zod';
import { zh } from '../strings.zh-CN';
import { IdSchema, JsonSchemaRefField, SchemaVersionSchema, TimeOfDaySchema } from './common';
import { PoseSchema } from './pose';

/** 触发条件。 */
export const EventTriggerSchema = z.discriminatedUnion('type', [
  /** 随机：平均每小时触发几次。实际频率还会按活跃度和猫的性格参数调整。 */
  z.strictObject({ type: z.literal('random'), perHour: z.number().positive() }),
  /** 当天第一次开机（早安）。 */
  z.strictObject({ type: z.literal('firstLaunchOfDay') }),
  /** 每天的某个时间段内（比如深夜犯困）。可以跨午夜，比如 23:00～05:00。 */
  z.strictObject({ type: z.literal('timeOfDay'), from: TimeOfDaySchema, to: TimeOfDaySchema }),
  /** 到了用户在设置里填的喂饭时间。 */
  z.strictObject({ type: z.literal('feedingTime') }),
  /** 用户状态变化：离开、回来、坐太久。只根据系统空闲时间判断。 */
  z.strictObject({
    type: z.literal('userState'),
    state: z.enum(['away', 'back', 'sedentary']),
  }),
  /** 某只参与的猫的生日或到家纪念日。 */
  z.strictObject({ type: z.literal('catDate'), date: z.enum(['birthday', 'homeDate']) }),
  /** 每年固定公历日期的节日，格式 MM-DD。按月份检查天数，2 月 29 日算合法（闰年才触发）。 */
  z.strictObject({
    type: z.literal('holiday'),
    date: z
      .string()
      .regex(
        /^(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|02-(?:0[1-9]|1[0-9]|2[0-9]))(?![\s\S])/,
        { error: zh.validation.monthDayFormat },
      ),
  }),
]);
export type EventTrigger = z.infer<typeof EventTriggerSchema>;

/** 事件的一步。每只参与的猫都按顺序执行这些步骤。 */
export const EventStepSchema = z.discriminatedUnion('do', [
  /** 先按姿势网络走到某个姿势。 */
  z.strictObject({ do: z.literal('goToPose'), pose: PoseSchema }),
  /** 播放某个片段若干次。猫咪包里没有这个片段时，整个事件不会被触发。 */
  z.strictObject({
    do: z.literal('playClip'),
    clip: IdSchema,
    times: z.int().min(1).optional(),
  }),
  /** 在猫身边冒一个气泡。 */
  z.strictObject({
    do: z.literal('bubble'),
    text: z.string().min(1),
    durationMs: z.int().positive(),
  }),
  /** 播放一个特效，比如爱心、飞虫、节日装饰。 */
  z.strictObject({ do: z.literal('effect'), effect: IdSchema }),
  /** 播放猫咪包声音位里的一种声音。 */
  z.strictObject({ do: z.literal('sound'), slot: z.enum(['meow', 'purr']) }),
  /** 等一会儿。 */
  z.strictObject({ do: z.literal('wait'), ms: z.int().positive() }),
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
    /** 冷却时间（分钟），按真实经过的时间计算。 */
    cooldownMinutes: z.number().min(0),
    /** 需要几只猫参与。 */
    cats: z.strictObject({
      min: z.int().min(1),
      max: z.int().min(1),
    }),
    steps: z.array(EventStepSchema).min(1),
  })
  .superRefine((event, ctx) => {
    if (event.cats.max < event.cats.min) {
      ctx.addIssue({ code: 'custom', path: ['cats', 'max'], message: zh.validation.maxBelowMin });
    }
  });
export type EventConfig = z.infer<typeof EventSchema>;
