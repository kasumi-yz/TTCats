// 草稿，M0 后定稿。
// 素材工厂（AssetFactory）的输出格式：每个候选（Candidate）文件夹里的 manifest.json（ADR-0006）。
// 素材工厂是 Python 写的，用 schemas/candidate-manifest.schema.json 校验这份文件。
import { z } from 'zod';
import { IdSchema, JsonSchemaRefField, SchemaVersionSchema } from './common';
import { ClipSchema } from './clip';

/** 素材档案（AssetLog）：这个候选是怎么生成出来的。 */
export const AssetLogSchema = z.strictObject({
  /** 生成器（Generator）名字，比如 `wan2.2-flf2v`、`minimax-h3`、`manual-inbox`。 */
  generator: z.string().min(1),
  /** 用到的模型文件名（带版本），手动放进收件箱的可以留空。 */
  modelFiles: z.array(z.string().min(1)),
  /** 工作流文件名和版本，没有就不写。 */
  workflow: z.string().min(1).optional(),
  prompt: z.string(),
  /** 生成参数，原样记录，比如步数、种子、CFG。 */
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  /** 这个片段名下的第几次生成，从 1 开始。 */
  attempt: z.int().min(1),
  /** 首帧和尾帧用的姿势帧文件名。 */
  startPoseFrame: z.string().min(1),
  endPoseFrame: z.string().min(1),
  /** 原始视频在素材库里的路径。原始视频不进仓库（D22）。 */
  rawVideo: z.string().min(1),
  /** 生成时间，ISO 8601。 */
  createdAt: z.iso.datetime({ offset: true }),
});
export type AssetLog = z.infer<typeof AssetLogSchema>;

export const CandidateManifestSchema = z.strictObject({
  ...JsonSchemaRefField,
  schemaVersion: SchemaVersionSchema,
  /** 候选 id，在同一只猫、同一个片段名下唯一，比如 `walk-003`。 */
  candidateId: IdSchema,
  cat: IdSchema,
  /**
   * 挑选状态：
   * - pending：工具处理完，等人确认
   * - accepted：人已确认，`clip` 里的数据可以直接放进猫咪包
   * - rejected：不合格
   */
  status: z.enum(['pending', 'accepted', 'rejected']),
  /** 不合格的原因，或者挑选时的备注。 */
  note: z.string().optional(),
  assetLog: AssetLogSchema,
  /**
   * 片段元数据。pending 时是工具给的建议（裁剪、循环点、落脚锚点、步速），
   * 由人确认或修改后改成 accepted。文件路径相对于候选文件夹。
   */
  clip: ClipSchema,
});
export type CandidateManifest = z.infer<typeof CandidateManifestSchema>;
