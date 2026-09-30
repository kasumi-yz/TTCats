// 证明硬性规则 1、3、6 已经变成自动检查：在不该出现的地方写这些代码，ESLint 会报错。
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
    ["export * from 'electron';", 'no-restricted-imports'],
    ["export const e = import('electron');", 'no-restricted-syntax'],
    ["import e = require('electron');\nexport { e };", 'no-restricted-syntax'],
    [
      "import { Application } from 'pixi.js';\nexport const a = Application;",
      'no-restricted-imports',
    ],
    ["import { useState } from 'react';\nexport const s = useState;", 'no-restricted-imports'],
    [
      "import { readFileSync } from 'node:fs';\nexport const r = readFileSync;",
      'no-restricted-imports',
    ],
    ["import { readFileSync } from 'fs';\nexport const r = readFileSync;", 'no-restricted-imports'],
    // 导入主进程、渲染进程的代码，包括直接导入目录（会解析到 index.ts）
    ["import '../../main';", 'no-restricted-imports'],
    ["import '../../main/index';", 'no-restricted-imports'],
    ["import '../../renderer/panels/App';", 'no-restricted-imports'],
    ['export const el = document.body;', 'no-restricted-globals'],
    ['export const w = window;', 'no-restricted-globals'],
    ['export const d = globalThis.document;', 'no-restricted-globals'],
    ["export const p = process.env['X'];", 'no-restricted-globals'],
  ])('src/core 里的 %s 会被拦下', async (code, ruleId) => {
    expect(await ruleIdsFor('src/core/game/probe.ts', code)).toContain(ruleId);
  });

  it('src/shared 同样受限', async () => {
    expect(await ruleIdsFor('src/shared/probe.ts', "import 'electron';")).toContain(
      'no-restricted-imports',
    );
  });

  it('纯 TypeScript 的代码不会被拦，core 内部可以互相导入', async () => {
    const code = [
      "import { a } from '../stage/domain';",
      "import { b } from './maintenance';",
      'export const x = a + b;',
      '',
    ].join('\n');
    expect(await ruleIdsFor('src/core/game/probe.ts', code)).toEqual([]);
  });
});

describe('core 不读系统时钟（硬性规则 6）', () => {
  it.each([
    ['export const t = Date.now();', 'no-restricted-properties'],
    ['export const t = performance.now();', 'no-restricted-properties'],
    ['export const t = new Date().getTime();', 'no-restricted-syntax'],
    ['export const t = Date();', 'no-restricted-syntax'],
    ['export const t = globalThis.Date.now();', 'no-restricted-globals'],
  ])('src/core 里的 %s 会被拦下', async (code, ruleId) => {
    expect(await ruleIdsFor('src/core/game/probe.ts', code)).toContain(ruleId);
  });

  it('用传入的时间构造日期是允许的', async () => {
    const code = [
      'export function hourOf(now: number): number {',
      '  return new Date(now).getUTCHours() + Date.UTC(2026, 0, 1);',
      '}',
      '',
    ].join('\n');
    expect(await ruleIdsFor('src/core/game/probe.ts', code)).toEqual([]);
  });
});

describe('平台代码的位置限制（硬性规则 3）', () => {
  const platformProbes = [
    "export const isWin = process.platform === 'win32';\n",
    'export const { platform } = process;\n',
    "import { platform } from 'node:os';\nexport const isWin = platform() === 'win32';\n",
    "import { platform as p } from 'os';\nexport const isWin = p() === 'win32';\n",
    "import * as nodeOs from 'node:os';\nexport const isWin = nodeOs.platform() === 'win32';\n",
    "import { platform } from 'node:process';\nexport const isWin = platform === 'win32';\n",
    "import 'koffi';\n",
    // Codex 复审时的两个复现：默认导入 process、动态导入 os
    "import nodeProcess from 'node:process';\nexport const isWin = nodeProcess.platform === 'win32';\n",
    "export async function f() {\n  const { platform } = await import('node:os');\n  return platform() === 'win32';\n}\n",
    // 换个名字、换种写法
    "const p = process;\nexport const isWin = p.platform === 'win32';\n",
    "export const isWin = process['platform'] === 'win32';\n",
    "export const koffi = import('koffi');\n",
    "const name = 'node:os';\nexport const os = import(name);\n",
  ];

  it.each([
    "export const debug = process.env['DEBUG'] === '1';\n",
    "export const loadApp = () => import('./App');\n",
  ])('src/main 里的普通代码 %s 不会被误拦', async (code) => {
    expect(await ruleIdsFor('src/main/probe.ts', code)).toEqual([]);
  });

  it('构建脚本和测试可以用 os 模块', async () => {
    const code = "import { tmpdir } from 'node:os';\nexport const dir = tmpdir();\n";
    expect(await ruleIdsFor('scripts/probe.ts', code)).toEqual([]);
  });

  it.each(platformProbes)('src/main/platform 以外的 %s 会被拦下', async (code) => {
    const ruleIds = await ruleIdsFor('src/main/probe.ts', code);
    expect(ruleIds.some((id) => id.startsWith('no-restricted-'))).toBe(true);
  });

  it.each(platformProbes)('src/main/platform 里可以写 %s', async (code) => {
    expect(await ruleIdsFor('src/main/platform/win/probe.ts', code)).toEqual([]);
  });
});
