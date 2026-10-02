import { z } from 'zod';
import { IdSchema, PointSchema } from '../shared/schemas/common';
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
  z.strictObject({
    type: z.literal('debug/playClip'),
    cat: IdSchema,
    clip: z.string(),
    variant: z.int().nonnegative().optional(),
  }),
  z.strictObject({
    type: z.literal('debug/simulate'),
    cat: IdSchema,
    interaction: z.enum(['poke', 'pet', 'pickUp', 'drop']),
  }),
  z.strictObject({ type: z.literal('debug/crashOverlay') }),
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
