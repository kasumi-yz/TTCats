// 设置：只由主进程修改并存档（ADR-0004）。M1 定稿（#18），M2 新增（#52）。
// 只放已经要做的设置项。设计方案 D13 里的其他设置项（喂饭时间、生日和到家日、久坐提醒、窗口模式等），
// 等对应功能做出来时再加，靠存档迁移补上默认值（硬性规则 8）。
// 新增设置项时：在 save.ts 加一个迁移步骤补上默认值，并在 strings.zh-CN.ts 的 fields 里加上中文名。
import { z } from 'zod';
import { hideAllShortcutProblem } from '../accelerator';
import { IdSchema, TimeOfDaySchema, UnitSchema } from './common';

/** 活跃度（ActivityLevel）：安静、慵懒、自然、活泼、闹腾。 */
export const ActivityLevelSchema = z.enum(['quiet', 'lazy', 'natural', 'lively', 'rowdy']);
export type ActivityLevel = z.infer<typeof ActivityLevelSchema>;

/**
 * 记住的是哪块显示器（D12）。只靠 Electron 的 Display.id 认不准：Windows 重启、插拔后 id 可能变，
 * 所以同时记下型号名和分辨率，认法见 `src/shared/display.ts` 的 findDisplay。
 */
export const DisplayRefSchema = z.strictObject({
  /** Electron 的 Display.id。 */
  id: z.number(),
  /** 显示器型号名（Electron 的 Display.label）；拿不到时是空字符串。 */
  label: z.string(),
  /** 选的时候的物理分辨率（像素）。 */
  width: z.int().positive(),
  height: z.int().positive(),
});
export type DisplayRef = z.infer<typeof DisplayRefSchema>;

/** 一键隐藏的全局快捷键（Electron accelerator 字符串），规则见 `src/shared/accelerator.ts`。 */
export const HideAllShortcutSchema = z.string().superRefine((value, ctx) => {
  const problem = hideAllShortcutProblem(value);
  if (problem !== undefined) ctx.addIssue({ code: 'custom', message: problem });
});

/**
 * 一键隐藏的默认快捷键：Ctrl+Alt+Shift+H（H 是 hide）。三个修饰键一起用的组合很少被常用软件占用，
 * 避开了 QQ、微信的 Ctrl+Alt+字母，以及调试台的 Ctrl+Shift+F10。
 */
export const DEFAULT_HIDE_ALL_SHORTCUT = 'CommandOrControl+Alt+Shift+H';

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

  // ---------- M2（#52） ----------

  /** 呼噜声开关（D11：默认开）。 */
  purrEnabled: z.boolean(),
  /** 呼噜声音量，0～1。 */
  purrVolume: UnitSchema,
  /** 喵叫开关（D11：默认开）。 */
  meowEnabled: z.boolean(),
  /** 喵叫音量，0～1（D11：默认偏轻，比呼噜低）。 */
  meowVolume: UnitSchema,
  /**
   * 安静时段（QuietHours，D11）的开始和结束时刻，按本地时间，格式 HH:MM。默认 23:00～08:00。
   * 包括开始的那一分钟，不包括结束的那一分钟：23:00～08:00 表示 23:00 到第二天 07:59 都不出声。
   * 开始比结束晚表示跨午夜。开始等于结束表示没有安静时段（相当于关掉）。
   */
  quietHoursStart: TimeOfDaySchema,
  quietHoursEnd: TimeOfDaySchema,
  /**
   * 一键隐藏（HideAll，D10）的全局快捷键。按一下，猫立刻消失；再按一下，猫从屏幕边走回来；
   * 重启程序后猫照常出现。
   */
  hideAllShortcut: HideAllShortcutSchema,
  /** 开机启动（D10、D13）。默认开（2026-10-02 用户决定）。只在安装版生效。 */
  launchAtLogin: z.boolean(),
  /** 自动检查和下载更新（D1、D13）。关掉以后不自动检查，手动"检查更新"仍然可以用。 */
  autoUpdate: z.boolean(),
  /**
   * 猫待在哪块显示器（D12）。null 表示主显示器（默认）。
   * 设置的那块认不出来（比如拔掉了）时用主显示器，但不改这里，接回来以后猫回到它上面。
   */
  display: DisplayRefSchema.nullable(),
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
    purrEnabled: true,
    purrVolume: 0.6,
    meowEnabled: true,
    meowVolume: 0.3,
    quietHoursStart: '23:00',
    quietHoursEnd: '08:00',
    hideAllShortcut: DEFAULT_HIDE_ALL_SHORTCUT,
    launchAtLogin: true,
    autoUpdate: true,
    display: null,
  };
}
