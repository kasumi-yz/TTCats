// M1 定稿（#18），M2 新增 CatSound（#52）。
// 猫咪包（CatPack）里的 cat.json：一只猫的身份、体型、性格参数、关系和声音位（ADR-0005）。
// 代码只能根据这里的性格参数和关系来决定行为，不能为某一只猫写死行为。
import { z } from 'zod';
import { zh } from '../strings.zh-CN';
import {
  DateSchema,
  IdSchema,
  JsonSchemaRefField,
  PackPathSchema,
  SchemaVersionSchema,
  UnitSchema,
} from './common';

/** 性格参数（Personality）：每项 0～1。 */
export const PersonalitySchema = z.strictObject({
  /** 活跃：多爱走动、跑酷、追东西。 */
  activity: UnitSchema,
  /** 黏人：多爱靠近用户和鼠标。 */
  clinginess: UnitSchema,
  /** 主动：黏人时是主动凑过来（1），还是安静地待在旁边（0）。 */
  initiative: UnitSchema,
  /** 强势：多爱抢位置、抢关注。 */
  dominance: UnitSchema,
  /** 耐心：被撸、被戳时多久才会走开。 */
  patience: UnitSchema,
});
export type Personality = z.infer<typeof PersonalitySchema>;

/** 关系（Relationship）：这只猫对另一只猫的亲近程度，以及谁更强势。 */
export const RelationshipSchema = z.strictObject({
  /** 对方的猫 id。对方可以来自别的猫咪包；没写到的猫按"普通友好"处理。 */
  cat: IdSchema,
  /** 亲近程度，0～1。 */
  closeness: UnitSchema,
  /** 谁更强势，-1～1。正数表示这只猫更强势。 */
  dominance: z.number().min(-1).max(1),
});
export type Relationship = z.infer<typeof RelationshipSchema>;

/** 声音位：每一类声音可以放几个文件，播放时随机挑一个。暂时只有喵叫和呼噜（D11）。 */
export const SoundSlotsSchema = z.strictObject({
  meow: z.array(PackPathSchema),
  purr: z.array(PackPathSchema),
});
export type SoundSlots = z.infer<typeof SoundSlotsSchema>;

/** 猫的声音种类（M2，#52）：喵叫、呼噜。 */
export const CatSoundSchema = SoundSlotsSchema.keyof();
export type CatSound = z.infer<typeof CatSoundSchema>;

export const CatSchema = z
  .strictObject({
    ...JsonSchemaRefField,
    schemaVersion: SchemaVersionSchema,
    /** 猫的 id，必须和猫咪包文件夹同名。 */
    id: IdSchema,
    /** 显示用的名字。 */
    name: z.string().min(1),
    /** 生日。不知道可以不写，用户之后能在设置里补。 */
    birthday: DateSchema.optional(),
    /** 到家日。不知道可以不写，用户之后能在设置里补。 */
    homeDate: DateSchema.optional(),
    /**
     * 相对体型：站立时的高度相对标准猫的比例。
     * 标准猫在 100% 缩放下站着约 150 像素高（D13）。
     */
    relativeSize: z.number().min(0.5).max(1.5),
    personality: PersonalitySchema,
    relationships: z.array(RelationshipSchema),
    sounds: SoundSlotsSchema,
  })
  .superRefine((cat, ctx) => {
    const seen = new Set<string>();
    cat.relationships.forEach((rel, i) => {
      if (rel.cat === cat.id) {
        ctx.addIssue({
          code: 'custom',
          path: ['relationships', i, 'cat'],
          message: zh.validation.relationshipWithSelf,
        });
      }
      if (seen.has(rel.cat)) {
        ctx.addIssue({
          code: 'custom',
          path: ['relationships', i, 'cat'],
          message: zh.validation.duplicateRelationship(rel.cat),
        });
      }
      seen.add(rel.cat);
    });
  });
export type Cat = z.infer<typeof CatSchema>;
