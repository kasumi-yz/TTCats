// 草稿，M0 后定稿。
// 设置：只由主进程修改并存档（ADR-0004），内容对应设计方案 D10、D11、D13 的设置窗口。
import { z } from 'zod';
import { DateSchema, IdSchema, TimeOfDaySchema, UnitSchema } from './common';

/** 活跃度（ActivityLevel）：安静、慵懒、自然、活泼、闹腾。 */
export const ActivityLevelSchema = z.enum(['quiet', 'lazy', 'natural', 'lively', 'rowdy']);
export type ActivityLevel = z.infer<typeof ActivityLevelSchema>;

/** 地板模式（FloorMode）/ 窗口模式（WindowMode）。 */
export const StageModeSchema = z.enum(['floor', 'window']);
export type StageMode = z.infer<typeof StageModeSchema>;

export const SettingsSchema = z.strictObject({
  /** 显示哪几只猫（猫 id），可以一只都不显示。 */
  visibleCats: z.array(IdSchema),
  mode: StageModeSchema,
  activityLevel: ActivityLevelSchema,
  /** 缩放，0.5～2。 */
  scale: z.number().min(0.5).max(2),
  /** 地板纵深，0～1。 */
  floorDepth: UnitSchema,
  /** 猫待在哪块屏幕；不写表示主屏。 */
  displayId: z.string().optional(),
  sound: z.strictObject({
    meow: z.boolean(),
    purr: z.boolean(),
    /** 总音量，0～1。 */
    volume: UnitSchema,
    /** 安静时段（QuietHours），可以跨午夜。 */
    quietHours: z.strictObject({ from: TimeOfDaySchema, to: TimeOfDaySchema }),
  }),
  /** 截图和会议里是否显示猫。 */
  showInScreenCapture: z.boolean(),
  /** 勿扰模式（DoNotDisturb）结束的时刻（Unix 毫秒）；不写表示没开。 */
  doNotDisturbUntil: z.number().optional(),
  /** 全局快捷键，Electron accelerator 格式。 */
  hotkeys: z.strictObject({
    toggleHidden: z.string(),
  }),
  launchAtLogin: z.boolean(),
  /** 喂饭时间。 */
  feedingTimes: z.array(TimeOfDaySchema),
  /** 用户在设置里补填或修改的生日、到家日，优先于猫咪包里的值。 */
  catDates: z.record(
    IdSchema,
    z.strictObject({ birthday: DateSchema.optional(), homeDate: DateSchema.optional() }),
  ),
  sedentaryReminder: z.strictObject({
    enabled: z.boolean(),
    afterMinutes: z.int().positive(),
  }),
  autoUpdate: z.boolean(),
});
export type Settings = z.infer<typeof SettingsSchema>;
