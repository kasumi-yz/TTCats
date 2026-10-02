// 存档的格式和迁移（硬性规则 7、ADR-0004）。M1 定稿（#18），M2 升到版本 2（#52）。
// 存档模块（src/main/save/）负责读写、按版本调用迁移步骤和备份；这里只定格式和迁移步骤。
import { z } from 'zod';
import { zh } from '../strings.zh-CN';
import { DoNotDisturbSchema } from './do-not-disturb';
import { defaultSettings, SettingsSchema } from './settings';

/**
 * 当前程序写出的存档版本。GameState 改了字段就加 1，并在 SAVE_MIGRATIONS 里
 * 补一个把上一版升到这一版的迁移步骤。
 */
export const CURRENT_SAVE_VERSION = 2;

/**
 * 需要存档的游戏状态，由 core/game 管理。以后需要什么，靠存档迁移再加（硬性规则 8）。
 * 一键隐藏、开机静默、调试台快进的时钟偏移都是临时的，不进存档；存档里的时刻都是真实时间，不带快进的偏移。
 */
export const GameStateSchema = z.strictObject({
  settings: SettingsSchema,
  /** 勿扰模式（M2）。 */
  doNotDisturb: DoNotDisturbSchema,
});
export type GameState = z.infer<typeof GameStateSchema>;

/** 第一次运行（或者没有能用的存档）时的状态。allCats 是已经加载成功的全部猫。 */
export function defaultGameState(allCats: readonly string[]): GameState {
  return { settings: defaultSettings(allCats), doNotDisturb: { mode: 'off' } };
}

/**
 * 存档文件的外层。读取时先按这个校验，拿到版本号；state 按版本迁移到当前版本以后，
 * 再用 GameStateSchema 校验。
 */
export const SaveEnvelopeSchema = z.strictObject({
  saveVersion: z.int().min(1),
  /** 保存时刻（Unix 毫秒）。 */
  savedAt: z.number(),
  state: z.unknown(),
});
export type SaveEnvelope = z.infer<typeof SaveEnvelopeSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 版本 1 → 2（M2，#52）：设置补上声音、安静时段、一键隐藏快捷键、开机启动、自动更新、显示器的默认值；
 * 勿扰模式为"没开"。
 * 默认值照抄当时的值写死在这里，以后改 defaultSettings 不影响这一步。已经有的字段保持原样，
 * 不认识的字段也原样留着，交给最后的 GameStateSchema 校验报出来。
 */
function migrateV1ToV2(state: unknown): unknown {
  if (!isRecord(state) || !isRecord(state.settings)) {
    throw new Error(zh.interfaces.migrationBadShape(1));
  }
  return {
    ...state,
    settings: {
      purrEnabled: true,
      purrVolume: 0.6,
      meowEnabled: true,
      meowVolume: 0.3,
      quietHoursStart: '23:00',
      quietHoursEnd: '08:00',
      hideAllShortcut: 'CommandOrControl+Alt+Shift+H',
      launchAtLogin: true,
      autoUpdate: true,
      display: null,
      ...state.settings,
    },
    doNotDisturb: { mode: 'off' },
  };
}

/**
 * 存档迁移步骤，传给 SaveStore 的 migrations。键是来源版本：SAVE_MIGRATIONS[1] 把版本 1 升到版本 2。
 * 每一步都是纯函数：不改传进来的对象，格式不对时抛错（SaveStore 会记中文日志，改读备份）。
 */
export const SAVE_MIGRATIONS: Readonly<Record<number, (state: unknown) => unknown>> = {
  1: migrateV1ToV2,
};
