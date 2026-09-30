// 证明硬性规则 1 和 3 已经变成自动检查：在不该出现的地方写这些代码，ESLint 会报错。
import { resolve } from 'node:path';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

const appRoot = resolve(import.meta.dirname, '..');
// 被测的规则都不需要类型信息；关掉类型检查，才能 lint 磁盘上不存在的探针文件。
const eslint = new ESLint({
  cwd: appRoot,
  overrideConfig: [{ files: ['**/*.ts'], ...tseslint.configs.disableTypeChecked }],
});

async function ruleIdsFor(relativePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: resolve(appRoot, relativePath) });
  return (result?.messages ?? []).map((m) => m.ruleId ?? `fatal: ${m.message}`);
}

describe('core 的依赖限制（硬性规则 1）', () => {
  it.each([
    ["import 'electron';", 'no-restricted-imports'],
    [
      "import { Application } from 'pixi.js';\nexport const a = Application;",
      'no-restricted-imports',
    ],
    ["import { useState } from 'react';\nexport const s = useState;", 'no-restricted-imports'],
    [
      "import { readFileSync } from 'node:fs';\nexport const r = readFileSync;",
      'no-restricted-imports',
    ],
    ['export const el = document.body;', 'no-restricted-globals'],
    ['export const w = window;', 'no-restricted-globals'],
    ['export const t = Date.now();', 'no-restricted-properties'],
  ])('src/core 里的 %s 会被拦下', async (code, ruleId) => {
    expect(await ruleIdsFor('src/core/game/probe.ts', code)).toContain(ruleId);
  });

  it('src/shared 同样受限', async () => {
    expect(await ruleIdsFor('src/shared/probe.ts', "import 'electron';")).toContain(
      'no-restricted-imports',
    );
  });

  it('纯 TypeScript 的代码不会被拦', async () => {
    expect(await ruleIdsFor('src/core/stage/probe.ts', 'export const x = 1 + 1;\n')).toEqual([]);
  });
});

describe('平台代码的位置限制（硬性规则 3）', () => {
  const platformCode = "export const isWin = process.platform === 'win32';\n";

  it('src/main/platform 以外不能按操作系统分支', async () => {
    expect(await ruleIdsFor('src/main/probe.ts', platformCode)).toContain(
      'no-restricted-properties',
    );
  });

  it('src/main/platform 以外不能用 koffi', async () => {
    expect(await ruleIdsFor('src/main/probe.ts', "import 'koffi';")).toContain(
      'no-restricted-imports',
    );
  });

  it('src/main/platform 里可以用', async () => {
    expect(await ruleIdsFor('src/main/platform/win/probe.ts', platformCode)).toEqual([]);
  });
});
