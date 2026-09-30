import { resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

test('应用能启动并打开面板窗口', async () => {
  const app = await electron.launch({ args: [resolve(import.meta.dirname, '..')] });
  try {
    const window = await app.firstWindow();
    await expect(window).toHaveTitle('TTCats');
    await expect(window.getByTestId('placeholder')).toBeVisible();
  } finally {
    await app.close();
  }
});
