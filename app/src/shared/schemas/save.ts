// 存档的格式（硬性规则 7、ADR-0004）。M1 定稿（#18）。
// 存档模块（src/main/save/）负责读写、迁移和备份；这里只定格式。
import { z } from 'zod';
import { SettingsSchema } from './settings';

/**
 * 当前程序写出的存档版本。GameState 改了不兼容的字段就加 1，
 * 并补一个把上一版升到这一版的迁移步骤。
 */
export const CURRENT_SAVE_VERSION = 1;

/** 需要存档的游戏状态，由 core/game 管理。以后需要什么，靠存档迁移再加（硬性规则 8）。 */
export const GameStateSchema = z.strictObject({
  settings: SettingsSchema,
});
export type GameState = z.infer<typeof GameStateSchema>;

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
