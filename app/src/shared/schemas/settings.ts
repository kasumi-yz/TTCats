// 设置：只由主进程修改并存档（ADR-0004）。M1 定稿（#18）。
// 只放 M1 已经能用的设置项。设计方案 D10、D11、D13 里的其他设置项（声音、勿扰、快捷键、开机启动、
// 喂饭时间、窗口模式等），等对应功能做出来时再加，靠存档迁移补上默认值（硬性规则 8）。
import { z } from 'zod';
import { IdSchema, UnitSchema } from './common';

/** 活跃度（ActivityLevel）：安静、慵懒、自然、活泼、闹腾。 */
export const ActivityLevelSchema = z.enum(['quiet', 'lazy', 'natural', 'lively', 'rowdy']);
export type ActivityLevel = z.infer<typeof ActivityLevelSchema>;

export const SettingsSchema = z.strictObject({
  /**
   * 显示哪几只猫（猫 id），可以一只都不显示。托盘里显示或隐藏某只猫、右键菜单里"暂时隐藏它"，
   * 改的都是这里。猫咪包被停用的猫留在这里也没关系，只是不会出现。
   */
  visibleCats: z.array(IdSchema),
  activityLevel: ActivityLevelSchema,
  /** 缩放，0.5～2。1 表示标准猫站着约 150 像素高（D13）。 */
  scale: z.number().min(0.5).max(2),
  /** 地板纵深，0～1。0 表示地板没有纵深，猫都在同一条线上。 */
  floorDepth: UnitSchema,
  /** 截图和会议里是否显示猫（D10）。false 时用 setContentProtection 隐藏。 */
  showInScreenCapture: z.boolean(),
});
export type Settings = z.infer<typeof SettingsSchema>;

/** 第一次运行时的设置。allCats 是已经加载成功的全部猫。 */
export function defaultSettings(allCats: readonly string[]): Settings {
  return {
    visibleCats: [...allCats],
    activityLevel: 'natural',
    scale: 1,
    floorDepth: 0.5,
    showInScreenCapture: false,
  };
}
