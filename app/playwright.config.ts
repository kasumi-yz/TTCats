import { defineConfig } from '@playwright/test';

// 只用于冒烟测试：启动构建好的 Electron 应用（先运行 npm run build）。
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: process.env['CI'] === undefined ? 0 : 1,
  reporter: [['list']],
});
