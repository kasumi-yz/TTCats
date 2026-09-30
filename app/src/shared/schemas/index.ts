// 草稿，M0 后定稿。
export * from './common';
export * from './pose';
export * from './cat';
export * from './clip';
export * from './event';
export * from './settings';
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
