// @ts-check
import { builtinModules } from 'node:module';
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// 浏览器专有的全局变量（去掉和 Node / ES 共有的那些），core 和 shared 里禁止使用。
const browserOnlyGlobals = Object.keys(globals.browser).filter(
  (name) => !(name in globals.node) && !(name in globals.es2021),
);

const RULE1 = '（硬性规则 1）。';
const RULE3 = '按操作系统区分的代码只能放在 src/main/platform/ 里（硬性规则 3）。';
const RULE6 = 'core 不读系统时钟，时间由调用方传入（硬性规则 6）。';

// Node 的内置模块，包括 `fs` 和 `node:fs` 两种写法。
const nodeBuiltins = builtinModules.filter((name) => !name.startsWith('_'));

// 硬性规则 1：core 不能依赖 Electron、DOM、PixiJS、React，也不能碰 Node 的系统模块，
// 更不能导入主进程或渲染进程的代码（包括 `../../main` 这样直接导入目录的写法）。
const coreRestrictedImports = {
  paths: [
    { name: 'electron', message: `core 不能依赖 Electron${RULE1}` },
    { name: 'react', message: `core 不能依赖 React${RULE1}` },
    { name: 'react-dom', message: `core 不能依赖 React${RULE1}` },
    { name: 'koffi', message: `core 不能调用系统接口${RULE1}` },
    ...nodeBuiltins.map((name) => ({
      name,
      message: `core 必须是纯 TypeScript，不能用 Node 的系统模块${RULE1}`,
    })),
  ],
  patterns: [
    { group: ['pixi.js', 'pixi.js/*', '@pixi/*'], message: `core 不能依赖 PixiJS${RULE1}` },
    { group: ['electron/*', 'react-dom/*'], message: `core 不能依赖 Electron 或 DOM${RULE1}` },
    { group: ['node:*'], message: `core 必须是纯 TypeScript，不能用 Node 的系统模块${RULE1}` },
    {
      regex: String.raw`^\.{1,2}/(?:.*/)?(?:main|renderer)(?:/.*)?$`,
      message: 'core 和 shared 不能导入主进程或渲染进程的代码。',
    },
  ],
};

// core 里额外禁止的写法。
const coreRestrictedSyntax = [
  {
    selector: 'ImportExpression',
    message: `core 不能用动态 import()，依赖必须写成静态导入，才能被自动检查${RULE1}`,
  },
  { selector: 'TSImportEqualsDeclaration', message: `core 不能用 import = require()${RULE1}` },
  { selector: 'NewExpression[callee.name="Date"][arguments.length=0]', message: RULE6 },
  { selector: 'CallExpression[callee.name="Date"]', message: RULE6 },
];

// 硬性规则 3：和操作系统打交道的 API 只能在 src/main/platform/ 里用。
// 全局的 process 仍然可以用（比如 process.env），但不能导入 process 模块，也不能读任何对象的 platform 属性
// ——这样 `import p from 'node:process'`、`const p = process; p.platform` 这类换个名字的写法也会被拦下。
const platformRestrictedImports = {
  paths: ['koffi', 'os', 'node:os', 'process', 'node:process'].map((name) => ({
    name,
    message: RULE3,
  })),
};
const platformRestrictedSyntax = [
  {
    selector: 'ImportExpression[source.value=/^(?:(?:node:)?(?:os|process)|koffi)$/]',
    message: RULE3,
  },
  {
    selector: 'ImportExpression[source.type!="Literal"]',
    message: `动态 import() 只能写固定的模块名，才能被自动检查。${RULE3}`,
  },
  // x.platform、x['platform']、{ platform } = x、{ ['platform']: y } = x；
  // 但 x[platform] 这种用变量做下标的普通字典查询不算
  { selector: 'MemberExpression[computed=false][property.name="platform"]', message: RULE3 },
  { selector: 'MemberExpression[property.value="platform"]', message: RULE3 },
  { selector: 'ObjectPattern > Property[computed=false][key.name="platform"]', message: RULE3 },
  { selector: 'ObjectPattern > Property[key.value="platform"]', message: RULE3 },
];

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'test-results/**', 'playwright-report/**'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // 硬性规则 3 管的是应用代码；构建脚本和测试是开发工具，可以用 os 等模块
    files: ['src/**'],
    rules: {
      'no-restricted-imports': ['error', platformRestrictedImports],
      'no-restricted-syntax': ['error', ...platformRestrictedSyntax],
    },
  },
  {
    files: ['src/main/platform/**'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-syntax': 'off',
    },
  },
  {
    files: ['src/core/**', 'src/shared/**'],
    languageOptions: { globals: {} },
    rules: {
      'no-restricted-imports': ['error', coreRestrictedImports],
      'no-restricted-globals': [
        'error',
        ...browserOnlyGlobals.map((name) => ({
          name,
          message: `core 和 shared 不能使用 DOM${RULE1}`,
        })),
        // 通过全局对象可以绕过上面的检查（比如 globalThis.Date.now()），所以直接禁止；process 也不该出现在 core 里
        ...['globalThis', 'global', 'process'].map((name) => ({
          name,
          message: `core 和 shared 不能直接访问全局对象${RULE1}`,
        })),
      ],
      'no-restricted-syntax': ['error', ...coreRestrictedSyntax, ...platformRestrictedSyntax],
      'no-restricted-properties': [
        'error',
        { object: 'Date', property: 'now', message: RULE6 },
        { object: 'performance', property: 'now', message: RULE6 },
      ],
    },
  },
  {
    files: ['src/renderer/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: ['scripts/**', 'e2e/**', '*.config.ts'],
    languageOptions: { globals: globals.node },
  },
  prettier,
);
