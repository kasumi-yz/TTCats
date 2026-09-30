// npm run gen:schemas：把 zod schema 生成为 JSON Schema，放到仓库根目录的 schemas/。
// npm run check:schemas（加 --check）：只检查 schemas/ 是不是最新的，不写文件。
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zh } from '../src/shared/strings.zh-CN';
import { renderJsonSchemas } from './lib/json-schemas';
import { schemasDir } from './lib/paths';

const checkOnly = process.argv.includes('--check');
const expected = renderJsonSchemas();

function readExisting(): Map<string, string> {
  const existing = new Map<string, string>();
  let names: string[];
  try {
    names = readdirSync(schemasDir).filter((n) => n.endsWith('.schema.json'));
  } catch {
    return existing;
  }
  for (const name of names) {
    existing.set(name, readFileSync(join(schemasDir, name), 'utf8').replaceAll('\r\n', '\n'));
  }
  return existing;
}

if (checkOnly) {
  const existing = readExisting();
  const names = new Set([...expected.keys(), ...existing.keys()]);
  const outdated = [...names].filter((n) => expected.get(n) !== existing.get(n)).sort();
  if (outdated.length > 0) {
    console.error(zh.schemas.outdated(outdated));
    process.exit(1);
  }
  console.log(zh.schemas.upToDate);
} else {
  mkdirSync(schemasDir, { recursive: true });
  for (const name of readExisting().keys()) {
    if (!expected.has(name)) rmSync(join(schemasDir, name));
  }
  for (const [name, text] of expected) writeFileSync(join(schemasDir, name), text);
  console.log(zh.schemas.written(expected.size));
}
