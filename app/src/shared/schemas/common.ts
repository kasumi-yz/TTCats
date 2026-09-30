// 草稿，M0 后定稿。
// 各个 schema 共用的小类型。
import { z } from 'zod';
import { zh } from '../strings.zh-CN';

/** 内容文件的格式版本。改了不兼容的字段就加 1，并在读取处做迁移（硬性规则 7）。 */
export const SchemaVersionSchema = z.literal(1);

/** 猫、片段、事件等的 id：小写英文、数字和连字符，比如 `doudou`、`idle-stand`。 */
export const IdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { error: zh.validation.idFormat });

/** 公历日期，格式 YYYY-MM-DD。 */
export const DateSchema = z.iso.date({ error: zh.validation.dateFormat });

/** 一天中的时刻，格式 HH:MM（24 小时制）。 */
export const TimeOfDaySchema = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, { error: zh.validation.timeOfDayFormat });

/** 猫咪包内部的相对路径，用正斜杠，不能跳出猫咪包。 */
export const PackPathSchema = z
  .string()
  .regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\:]+$/, { error: zh.validation.packPathFormat });

/** 0～1 之间的参数值。 */
export const UnitSchema = z.number().min(0).max(1);

/** 片段画面里的一个像素坐标，原点在左上角。 */
export const PointSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
});
export type Point = z.infer<typeof PointSchema>;

/** 内容文件可以写 `"$schema": "..."`，让编辑器按 JSON Schema 提示字段。 */
export const JsonSchemaRefField = { $schema: z.string().optional() };
