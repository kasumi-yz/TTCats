// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// 浏览器专有的全局变量（去掉和 Node / ES 共有的那些），core 和 shared 里禁止使用。
const browserOnlyGlobals = Object.keys(globals.browser).filter(
  (name) => !(name in globals.node) && !(name in globals.es2021),
);

// 硬性规则 1：core 不能依赖 Electron、DOM、PixiJS、React，也不能碰 Node 的系统模块。
const coreRestrictedImports = {
  paths: [
    { name: 'electron', message: 'core 不能依赖 Electron（硬性规则 1）。' },
    { name: 'react', message: 'core 不能依赖 React（硬性规则 1）。' },
    { name: 'react-dom', message: 'core 不能依赖 React（硬性规则 1）。' },
    { name: 'koffi', message: '系统接口只能在 src/main/platform/ 里用（硬性规则 3）。' },
  ],
  patterns: [
    { group: ['pixi.js', 'pixi.js/*', '@pixi/*'], message: 'core 不能依赖 PixiJS（硬性规则 1）。' },
    {
      group: ['electron/*', 'react-dom/*'],
      message: 'core 不能依赖 Electron 或 DOM（硬性规则 1）。',
    },
    {
      group: ['node:*'],
      message: 'core 必须是纯 TypeScript，不能用 Node 的系统模块（硬性规则 1）。',
    },
    {
      group: ['**/main/**', '**/renderer/**'],
      message: 'core 和 shared 不能导入主进程或渲染进程的代码。',
    },
  ],
};

// 硬性规则 3：和操作系统打交道的 API 只能在 src/main/platform/ 里用。
const platformRestrictedImports = {
  paths: [{ name: 'koffi', message: '系统接口只能在 src/main/platform/ 里用（硬性规则 3）。' }],
};
const platformRestrictedProperties = [
  {
    object: 'process',
    property: 'platform',
    message: '按操作系统分支的代码只能放在 src/main/platform/ 里（硬性规则 3）。',
  },
  {
    object: 'os',
    property: 'platform',
    message: '按操作系统分支的代码只能放在 src/main/platform/ 里（硬性规则 3）。',
  },
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
      'no-restricted-imports': ['error', platformRestrictedImports],
      'no-restricted-properties': ['error', ...platformRestrictedProperties],
    },
  },
  {
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['src/main/platform/**'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-properties': 'off',
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
          message: 'core 和 shared 不能使用 DOM（硬性规则 1）。',
        })),
      ],
      'no-restricted-properties': [
        'error',
        ...platformRestrictedProperties,
        {
          object: 'Date',
          property: 'now',
          message: 'core 不读系统时钟，时间由调用方传入（硬性规则 6）。',
        },
        {
          object: 'performance',
          property: 'now',
          message: 'core 不读系统时钟，时间由调用方传入（硬性规则 6）。',
        },
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
