import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    // ESLint 规则测试要加载 TypeScript 项目，第一次比较慢
    testTimeout: 60_000,
  },
});
