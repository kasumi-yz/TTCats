// M2 定稿（#52）。
// 勿扰模式（DoNotDisturb，D10）：猫都聚到角落里睡觉，不触发事件、不出声，直到用户关掉或者设定的时间结束。
// 勿扰期间仍然可以点、撸、拎、召唤（2026-10-02 用户决定）。勿扰不算离线（D16）。
import { z } from 'zod';

/**
 * 勿扰模式的状态，存进存档：退出再打开，没到时间的勿扰继续有效。
 * - off：没开
 * - timed：开到 until 那一刻自动结束（core/game 的 tick 到点结束）
 * - untilOff：一直开着，直到用户关掉
 */
export const DoNotDisturbSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('off') }),
  z.strictObject({
    mode: z.literal('timed'),
    /**
     * 结束时刻（Unix 毫秒），是 core/game 看到的时间（真实时间加上调试台快进的偏移，见 StateSnapshot.clockOffsetMs）。
     * 桌面层不用它自己判断到点，只看 mode 是不是 off。
     */
    until: z.number(),
  }),
  z.strictObject({ mode: z.literal('untilOff') }),
]);
export type DoNotDisturb = z.infer<typeof DoNotDisturbSchema>;

/** 开始勿扰时可选的时长（2026-10-02 用户决定）：30 分钟、1 小时、2 小时、直到我关掉。 */
export const DoNotDisturbDurationSchema = z.enum(['30m', '1h', '2h', 'untilOff']);
export type DoNotDisturbDuration = z.infer<typeof DoNotDisturbDurationSchema>;

/** 每种定时时长是多少毫秒。 */
export const DO_NOT_DISTURB_DURATION_MS = {
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '2h': 120 * 60_000,
} as const satisfies Record<Exclude<DoNotDisturbDuration, 'untilOff'>, number>;
