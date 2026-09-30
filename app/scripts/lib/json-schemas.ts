import { z } from 'zod';
import { EXPORTED_SCHEMAS } from '../../src/shared/schemas';

/** 把 zod schema 转成 JSON Schema 文件内容。键是文件名。 */
export function renderJsonSchemas(): Map<string, string> {
  const files = new Map<string, string>();
  for (const [name, schema] of Object.entries(EXPORTED_SCHEMAS)) {
    const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' });
    const withHeader = {
      $comment: '由 app/src/shared/schemas 自动生成，不要手改。修改后运行 npm run gen:schemas。',
      ...json,
    };
    files.set(`${name}.schema.json`, `${JSON.stringify(withHeader, null, 2)}\n`);
  }
  return files;
}
