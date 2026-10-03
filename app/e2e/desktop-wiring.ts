// #66 本机桌面验证：正式入口、真实 SendInput 和真实全屏查询，不替换原生边界。
// 运行：npx tsx app/e2e/desktop-wiring.ts（先 build；不要同时运行其他 TTCats）。
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect } from '@playwright/test';
import { createTestInput } from '../src/main/platform/win/test-input';
import type { AppStatus, StateSnapshot, StageCommand } from '../src/shared/ipc';

const directory = mkdtempSync(join(tmpdir(), 'ttcats-desktop-m2-wiring-'));
const env = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);
delete env['ELECTRON_RUN_AS_NODE'];
delete env['ELECTRON_RENDERER_URL'];
env['TTCATS_TEST_APP_DATA'] = directory;
const application = await electron.launch({
  args: [resolve(import.meta.dirname, '..'), '--test-content', '--settings'],
  env,
});
const input = createTestInput();
const key = (codes: number[]): void => {
  for (const code of codes) input.key(code, true);
  for (const code of codes.toReversed()) input.key(code, false);
};
const results: Record<string, unknown> = { directory };
try {
  await expect
    .poll(() => application.windows().some((page) => page.url().includes('panel=settings')), {
      timeout: 30_000,
    })
    .toBe(true);
  const settings = application.windows().find((page) => page.url().includes('panel=settings'));
  const overlay = application.windows().find((page) => page.url().includes('/overlay/'));
  if (!settings || !overlay) throw new Error('正式窗口没有就绪');
  await settings.waitForFunction('Boolean(window.ttcats)');
  await expect
    .poll(() => settings.evaluate<AppStatus>('window.ttcats.getAppStatus()'))
    .toMatchObject({ hideAllShortcut: { registered: true } });
  const snapshot = () => settings.evaluate<StateSnapshot>('window.ttcats.getSnapshot()');
  const visible = () =>
    application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some(
        (window) => window.webContents.getURL().includes('/overlay/') && window.isVisible(),
      ),
    );
  await expect.poll(visible).toBe(true);
  await overlay.evaluate(
    'window.nativeCommands = []; window.ttcats.onStageCommand(c => window.nativeCommands.push(c));',
  );
  // 普通可输入窗口代表用户正在打字的程序；创建在测试应用内，收尾随应用关闭。
  const fixtureId = await application.evaluate(async ({ BrowserWindow }) => {
    const fixture = new BrowserWindow({
      width: 700,
      height: 400,
      title: 'TTCats 原生验证输入窗口',
    });
    await fixture.loadURL(
      'data:text/html,<textarea autofocus style="width:95vw;height:80vh"></textarea>',
    );
    fixture.show();
    fixture.focus();
    return fixture.id;
  });
  const fixture = application.windows().find((page) => page.url().startsWith('data:text/html'));
  if (!fixture) throw new Error('输入窗口没有就绪');
  await fixture.locator('textarea').focus();
  const foreground = input.foregroundWindow();
  input.typeText('before');
  await expect(fixture.locator('textarea')).toHaveValue('before');
  key([0x11, 0x12, 0x10, 0x48]);
  await expect.poll(async () => (await snapshot()).hideAll).toBe(true);
  await expect.poll(visible).toBe(false);
  expect(input.foregroundWindow()).toBe(foreground);
  key([0x11, 0x12, 0x10, 0x48]);
  await expect.poll(visible).toBe(true);
  expect(input.foregroundWindow()).toBe(foreground);
  input.typeText('after');
  await expect(fixture.locator('textarea')).toHaveValue('beforeafter');
  await expect
    .poll(() => overlay.evaluate<StageCommand[]>('window.nativeCommands'))
    .toContainEqual({ type: 'cat/entrance' });
  results['nativeShortcutAndFocus'] = 'passed';

  await overlay.evaluate('window.nativeCommands = []');
  await application.evaluate(({ BrowserWindow }, id) => {
    BrowserWindow.fromId(id)?.setFullScreen(true);
    BrowserWindow.fromId(id)?.focus();
  }, fixtureId);
  await expect.poll(visible, { timeout: 15_000 }).toBe(false);
  await application.evaluate(({ BrowserWindow }, id) => {
    BrowserWindow.fromId(id)?.setFullScreen(false);
    BrowserWindow.fromId(id)?.close();
  }, fixtureId);
  await expect.poll(visible, { timeout: 15_000 }).toBe(true);
  await expect
    .poll(() => overlay.evaluate<StageCommand[]>('window.nativeCommands'))
    .toEqual([{ type: 'cat/entrance' }]);
  results['nativeFullscreenEntrance'] = 'passed';
} catch (error) {
  results['failure'] = String(error);
  throw error;
} finally {
  input.releaseAll();
  await application.close();
  const output = resolve(import.meta.dirname, '../test-results/native-m2-wiring.json');
  mkdirSync(resolve(import.meta.dirname, '../test-results'), { recursive: true });
  writeFileSync(output, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
}
