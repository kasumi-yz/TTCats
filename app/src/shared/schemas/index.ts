// M1 定稿（#18），M2 新增勿扰模式（#52），M3 定稿事件（event，#106）。素材工厂的候选 manifest 还是草稿，在素材工厂 v0（#4）定稿。
export * from './common';
export * from './pose';
export * from './cat';
export * from './clip';
export * from './event';
export * from './settings';
export * from './do-not-disturb';
export * from './save';
export * from './candidate-manifest';
export * from './validate';

import { CandidateManifestSchema } from './candidate-manifest';
import { CatSchema } from './cat';
import { ClipSchema } from './clip';
import { EventSchema } from './event';

/**
 * 要导出成 JSON Schema 的内容格式（npm run gen:schemas → 仓库根目录的 schemas/）。
 * 键是输出文件名（不含 .schema.json）。
 */
export const EXPORTED_SCHEMAS = {
  cat: CatSchema,
  clip: ClipSchema,
  event: EventSchema,
  'candidate-manifest': CandidateManifestSchema,
} as const;
