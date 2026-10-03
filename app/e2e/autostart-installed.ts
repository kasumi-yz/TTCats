// 手动安装版验证：npx tsx e2e/autostart-installed.ts <安装目录/TTCats.exe> toggle|boot|disabled
// 使用当前用户的正式设置；运行前备份 appData/TTCats，结束后还原。
import { _electron as electron, expect } from '@playwright/test';
import { zh } from '../src/shared/strings.zh-CN';
import type { StateSnapshot } from '../src/shared/ipc';

const executablePath = process.argv[2];
const mode = process.argv[3];
if (!executablePath || !['toggle', 'boot', 'disabled'].includes(mode ?? ''))
  throw new Error('需要安装版路径和 toggle、boot 或 disabled 模式。');
const env = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);
delete env['ELECTRON_RUN_AS_NODE'];
delete env['ELECTRON_RENDERER_URL'];
const app = await electron.launch({
  executablePath,
  args: mode === 'boot' ? ['--autostart', '--settings'] : ['--settings'],
  env,
});
try {
  await expect
    .poll(() => app.windows().some((page) => page.url().includes('/overlay/')), { timeout: 30_000 })
    .toBe(true);
  const overlay = app.windows().find((page) => page.url().includes('/overlay/'));
  if (!overlay) throw new Error('安装版缺少桌面层。');
  await overlay.waitForFunction('Boolean(window.ttcats)');
  const login = () =>
    app.evaluate(({ app }) => app.getLoginItemSettings({ args: ['--autostart'] }));
  const before = await login();
  const snapshot = () => overlay.evaluate<StateSnapshot>('window.ttcats.getSnapshot()');
  if (mode === 'boot') {
    expect(app.windows()).toHaveLength(1);
    expect((await snapshot()).silencedBy).toContain('startupQuiet');
    expect(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id ?? null),
    ).toBeNull();
    await overlay.evaluate('window.ttcats.sendCommand({type:"debug/advanceClock",minutes:1})');
    await expect.poll(async () => (await snapshot()).silencedBy).not.toContain('startupQuiet');
  } else if (mode === 'disabled') {
    expect(before.launchItems).toContainEqual(
      expect.objectContaining({ name: 'top.ttcats.desktop', enabled: false }),
    );
    expect((await snapshot()).settings.launchAtLogin).toBe(true);
    expect(before.executableWillLaunchAtLogin).toBe(false);
  } else {
    expect(before.openAtLogin).toBe(true);
    expect(before.launchItems).toContainEqual(
      expect.objectContaining({ name: 'top.ttcats.desktop', enabled: true }),
    );
    await expect
      .poll(() => app.windows().some((page) => page.url().includes('panel=settings')))
      .toBe(true);
    const settings = app.windows().find((page) => page.url().includes('panel=settings'));
    if (!settings) throw new Error('安装版缺少设置窗口。');
    await settings.getByRole('tab', { name: zh.panels.tabs.app, exact: true }).click();
    const checkbox = settings.getByRole('checkbox', { name: zh.panels.launchAtLogin, exact: true });
    await checkbox.uncheck();
    await expect
      .poll(async () =>
        (await login()).launchItems.some((item) => item.name === 'top.ttcats.desktop'),
      )
      .toBe(false);
    await checkbox.check();
    await expect.poll(async () => (await login()).openAtLogin).toBe(true);
  }
  console.log(
    JSON.stringify(
      {
        mode,
        packaged: await app.evaluate(({ app }) => app.isPackaged),
        before,
        after: await login(),
        snapshot: await snapshot(),
      },
      null,
      2,
    ),
  );
} finally {
  await app.close();
}
