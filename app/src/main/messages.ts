import { z } from 'zod';
import type { Fact, ToMainCommand } from '../shared/ipc';
import { CatSoundSchema } from '../shared/schemas/cat';
import { IdSchema, PointSchema } from '../shared/schemas/common';
import { DoNotDisturbDurationSchema } from '../shared/schemas/do-not-disturb';
import { SettingsSchema } from '../shared/schemas/settings';

// 只校验已有 IPC 消息，不增加共享命令或存档字段。
export const CommandSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('settings/update'), patch: SettingsSchema.partial() }),
  z.strictObject({
    type: z.literal('cat/summon'),
    cat: IdSchema.optional(),
    to: PointSchema.optional(),
  }),
  z.strictObject({ type: z.literal('cat/setVisible'), cat: IdSchema, visible: z.boolean() }),
  z.strictObject({ type: z.literal('cat/sleep'), cat: IdSchema }),
  z.strictObject({ type: z.literal('doNotDisturb/start'), duration: DoNotDisturbDurationSchema }),
  z.strictObject({ type: z.literal('doNotDisturb/end') }),
  z.strictObject({ type: z.literal('hideAll/toggle') }),
  z.strictObject({
    type: z.literal('debug/playClip'),
    cat: IdSchema,
    clip: z.string(),
    variant: z.int().nonnegative().optional(),
  }),
  z.strictObject({
    type: z.literal('debug/simulate'),
    cat: IdSchema,
    interaction: z.enum(['poke', 'pet', 'pickUp', 'drop', 'nearbyClicks']),
  }),
  z.strictObject({
    type: z.literal('debug/advanceClock'),
    minutes: z
      .int()
      .min(1)
      .max(7 * 24 * 60),
  }),
  z.strictObject({ type: z.literal('debug/startupQuiet') }),
  z.strictObject({ type: z.literal('debug/entrance') }),
  z.strictObject({ type: z.literal('debug/sound'), cat: IdSchema, sound: CatSoundSchema }),
  z.strictObject({ type: z.literal('photo/take') }),
  z.strictObject({ type: z.literal('diagnostics/export') }),
  z.strictObject({ type: z.literal('update/check') }),
  z.strictObject({ type: z.literal('update/install') }),
  z.strictObject({ type: z.literal('debug/simulateIdle') }),
  z.strictObject({ type: z.literal('debug/crashOverlay') }),
  z.strictObject({ type: z.literal('debug/simulateFullscreen'), active: z.boolean() }),
]);

export const FactSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('cat/petted'),
    cat: IdSchema,
    at: z.number(),
    durationMs: z.number().nonnegative(),
  }),
  ...(['cat/poked', 'cat/pickedUp', 'cat/dropped'] as const).map((type) =>
    z.strictObject({ type: z.literal(type), cat: IdSchema, at: z.number() }),
  ),
]);

// 双向可赋值检查字段类型与必填性；逐消息比较字段名，补上可选字段遗漏。
type KeysOf<U, K> = U extends { type: infer T } ? (K extends T ? keyof U : never) : never;
type SameKeys<A extends { type: string }, B extends { type: string }> = {
  [K in A['type'] | B['type']]: [KeysOf<A, K>] extends [KeysOf<B, K>]
    ? [KeysOf<B, K>] extends [KeysOf<A, K>]
      ? true
      : false
    : false;
}[A['type'] | B['type']];
type Assert<T extends true> = T;
export type MessageTypeAssertions = [
  Assert<[SameKeys<z.infer<typeof CommandSchema>, ToMainCommand>] extends [true] ? true : false>,
  Assert<[SameKeys<z.infer<typeof FactSchema>, Fact>] extends [true] ? true : false>,
  Assert<[z.infer<typeof CommandSchema>] extends [ToMainCommand] ? true : false>,
  Assert<[ToMainCommand] extends [z.infer<typeof CommandSchema>] ? true : false>,
  Assert<[z.infer<typeof FactSchema>] extends [Fact] ? true : false>,
  Assert<[Fact] extends [z.infer<typeof FactSchema>] ? true : false>,
];
