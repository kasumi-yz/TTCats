import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
  type Locator,
} from '@playwright/test';
import type { ContentCatalog } from '../src/shared/core-api';
import type { AppStatus, StageCommand, StageDebugReport, StateSnapshot } from '../src/shared/ipc';
import { CURRENT_SAVE_VERSION, defaultGameState, defaultSettings } from '../src/shared/schemas';
import { zh } from '../src/shared/strings.zh-CN';

interface Smoke {
  trays: Electron.Tray[];
  menus: Electron.Menu[];
  popups: Electron.Menu[];
  popupWindows: { id: number; focusable: boolean }[];
  dialogs: Electron.MessageBoxOptions[];
  saveBlocked: boolean;
  saveDialogResolvers: ((response: number) => void)[];
  shortcuts: Map<string, () => void>;
  fullscreen: boolean;
  crashes: number;
  slowRequests: number;
}
const ids = ['test-active', 'test-calm', 'test-close'];
test.describe.configure({ mode: 'default' });
test.setTimeout(120_000);
async function launch(directory: string, slow = false): Promise<ElectronApplication> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env['TTCATS_TEST_APP_DATA'] = directory;
  delete env['ELECTRON_RUN_AS_NODE'];
  delete env['ELECTRON_RENDERER_URL'];
  if (slow) env['TTCATS_SMOKE_SLOW_OVERLAY'] = '1';
  else delete env['TTCATS_SMOKE_SLOW_OVERLAY'];
  return electron.launch({
    args: [resolve(import.meta.dirname, 'launch.js'), '--test-content', '--settings'],
    env,
  });
}
async function pageFor(app: ElectronApplication, part: string): Promise<Page> {
  await expect
    .poll(() => app.windows().some((page) => page.url().includes(part)), { timeout: 30_000 })
    .toBe(true);
  const page = app.windows().find((page) => page.url().includes(part));
  if (!page) throw new Error(`找不到窗口：${part}`);
  await page.waitForFunction('Boolean(window.ttcats)');
  return page;
}
async function snapshot(page: Page): Promise<StateSnapshot> {
  return page.evaluate<StateSnapshot>('window.ttcats.getSnapshot()');
}
async function catalog(page: Page): Promise<ContentCatalog> {
  return page.evaluate<ContentCatalog>('window.ttcats.getContent()');
}
async function openDebug(app: ElectronApplication): Promise<Page> {
  await app.evaluate(({ globalShortcut }) => {
    if (!globalShortcut.isRegistered('CommandOrControl+Shift+F10'))
      throw new Error('原生调试快捷键注册失败');
    const callback = (globalThis as unknown as { smoke: Smoke }).smoke.shortcuts.get(
      'CommandOrControl+Shift+F10',
    );
    if (!callback) throw new Error('正式调试快捷键未注册');
    callback();
  });
  const page = await pageFor(app, 'panel=debug');
  await page.evaluate('window.ttcats.onStageDebug(report => { window.smokeReport = report; })');
  return page;
}
async function report(page: Page): Promise<StageDebugReport | undefined> {
  return page.evaluate<StageDebugReport | undefined>('window.smokeReport');
}
async function setRange(locator: Locator, value: number): Promise<void> {
  const current = Number(await locator.inputValue());
  const step = value > current ? 1 : -1;
  for (let next = current + step; step > 0 ? next <= value : next >= value; next += step) {
    await locator.press(step > 0 ? 'ArrowRight' : 'ArrowLeft');
    // 等主进程确认并让 React 呈现快照，避免下一次按键读取尚未确认的滑块草稿。
    await expect.poll(async () => (await snapshot(locator.page())).settings.scale).toBe(next / 100);
    await locator
      .page()
      .evaluate(
        'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
      );
    await expect(locator).toHaveValue(String(next));
  }
}
async function overlayVisible(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some(
      (window) => window.webContents.getURL().includes('/overlay/') && window.isVisible(),
    ),
  );
}
async function setFullscreen(app: ElectronApplication, active: boolean): Promise<void> {
  await app.evaluate((_, value) => {
    (globalThis as unknown as { smoke: Smoke }).smoke.fullscreen = value;
  }, active);
}
async function menuClick(app: ElectronApplication, id: string): Promise<void> {
  await app.evaluate(({ BrowserWindow }, itemId) => {
    const item = (globalThis as unknown as { smoke: Smoke }).smoke.menus
      .at(-1)
      ?.getMenuItemById(itemId);
    if (!item?.enabled) throw new Error(`菜单项不可用：${itemId}`);
    // Electron 的 click 包装器会先切换 checkbox，再调用正式菜单回调。
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Electron 将原生菜单 click 声明为 Function。
    item.click({}, BrowserWindow.getFocusedWindow() ?? undefined, undefined);
  }, id);
}

test('正式入口：双窗口桥、三只测试猫、真实托盘与退出保存', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ttcats-smoke-save-'));
  let app = await launch(directory);
  try {
    const settings = await pageFor(app, 'panel=settings');
    const overlay = await pageFor(app, '/overlay/');
    expect((await snapshot(overlay)).settings.visibleCats.slice().sort()).toEqual(ids);
    expect((await snapshot(settings)).settings).toEqual((await snapshot(overlay)).settings);
    expect(Object.keys((await catalog(settings)).cats).sort()).toEqual(ids);
    await expect(overlay.locator('canvas')).toBeVisible();
    await expect.poll(() => overlayVisible(app)).toBe(true);
    await setFullscreen(app, true);
    await expect.poll(() => overlayVisible(app)).toBe(false);
    await setFullscreen(app, false);
    await expect.poll(() => overlayVisible(app)).toBe(true);
    expect(
      await app.evaluate(({ app }) => [app.getPath('appData'), app.getPath('userData')]),
    ).toEqual([directory, join(directory, 'TTCats')]);
    expect(
      await app.evaluate(() =>
        (globalThis as unknown as { smoke: Smoke }).smoke.trays.map((tray) => tray.isDestroyed()),
      ),
    ).toEqual([false]);
    await menuClick(app, 'settings');
    expect(app.windows().filter((page) => page.url().includes('panel=settings'))).toHaveLength(1);
    await settings
      .getByRole('combobox', { name: zh.panels.activityLevel, exact: true })
      .selectOption('quiet');
    await setRange(settings.getByRole('slider', { name: zh.panels.scale, exact: true }), 125);
    await menuClick(app, 'capture');
    await menuClick(app, 'visible:test-close');
    await expect
      .poll(async () => (await snapshot(overlay)).settings)
      .toMatchObject({
        activityLevel: 'quiet',
        scale: 1.25,
        showInScreenCapture: true,
        visibleCats: ['test-active', 'test-calm'],
      });
    const saved = (await snapshot(settings)).settings;
    await app.close();
    app = await launch(directory);
    const restored = await pageFor(app, 'panel=settings');
    expect((await snapshot(restored)).settings).toEqual(saved);
    await expect(restored.getByRole('slider', { name: zh.panels.scale, exact: true })).toHaveValue(
      '125',
    );
  } finally {
    await app.close();
  }
});

test('正式重载中再次崩溃、快速连点后仍可继续恢复，额度不被重建清零', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ttcats-smoke-loading-'));
  const app = await launch(directory, true);
  try {
    await pageFor(app, 'panel=settings');
    const debug = await openDebug(app);
    await expect.poll(async () => (await report(debug))?.cats.length).toBe(3);
    for (let count = 1; count <= 4; count++) {
      if (count > 1) {
        await expect
          .poll(() =>
            app.evaluate(() => (globalThis as unknown as { smoke: Smoke }).smoke.slowRequests),
          )
          .toBe(count - 1);
        expect(
          await app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()
              .find((window) => window.webContents.getURL().includes('/overlay/'))
              ?.webContents.isLoadingMainFrame(),
          ),
        ).toBe(true);
      }
      // 同步快速连点，下一轮仍必须能终止新的进程，不能永久锁住崩溃命令。
      await debug.evaluate(
        'window.ttcats.sendCommand({type:"debug/crashOverlay"}); window.ttcats.sendCommand({type:"debug/crashOverlay"});',
      );
      await expect
        .poll(() => app.evaluate(() => (globalThis as unknown as { smoke: Smoke }).smoke.crashes))
        .toBe(count);
    }
    await expect
      .poll(() =>
        app.evaluate(() => (globalThis as unknown as { smoke: Smoke }).smoke.dialogs.length),
      )
      .toBe(1);
    const settings = await pageFor(app, 'panel=settings');
    await expect.poll(async () => Object.keys((await catalog(settings)).cats)).toEqual([]);
    expect(await overlayVisible(app)).toBe(false);
    expect(readFileSync(join(directory, 'TTCats/logs/main.log'), 'utf8')).toContain(
      '没有可用的备份存档',
    );
  } finally {
    await app.close();
  }
});

test('正式调试台：命令抵达桌面层、三猫画面报告、双窗口异常落盘', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ttcats-smoke-debug-'));
  const app = await launch(directory);
  try {
    await pageFor(app, 'panel=settings');
    const overlay = await pageFor(app, '/overlay/');
    const debug = await openDebug(app);
    // 调试台从程序状态看到桌面层在哪块显示器上：没设置时是主显示器（#65）
    const primary = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().id);
    await expect
      .poll(() => debug.evaluate<AppStatus>('window.ttcats.getAppStatus()'))
      .toMatchObject({
        overlayDisplayId: primary,
        displays: expect.arrayContaining([expect.objectContaining({ id: primary, primary: true })]),
      });
    await expect
      .poll(async () => (await report(debug))?.cats.map((cat) => cat.cat).sort(), {
        timeout: 30_000,
      })
      .toEqual(ids);
    await expect(debug.locator('article')).toHaveCount(3);
    await debug
      .getByRole('combobox', { name: zh.panels.cat, exact: true })
      .selectOption('test-calm');
    const current = async () => (await report(debug))?.cats.find((cat) => cat.cat === 'test-calm');
    await overlay.evaluate(
      'window.smokeCommands = []; window.ttcats.onStageCommand(command => window.smokeCommands.push(command))',
    );
    const commands = () => overlay.evaluate<StageCommand[]>('window.smokeCommands');
    for (const interaction of ['poke', 'pet'] as const) {
      await debug
        .getByRole('button', { name: zh.panels.simulations[interaction], exact: true })
        .click();
      await expect
        .poll(commands)
        .toContainEqual({ type: 'debug/simulate', cat: 'test-calm', interaction });
    }
    await debug.getByRole('button', { name: zh.panels.summonAll, exact: true }).click();
    await expect.poll(commands).toContainEqual({ type: 'cat/summon', cats: ids });
    await debug.getByRole('button', { name: zh.panels.summon, exact: true }).click();
    await expect.poll(commands).toContainEqual({ type: 'cat/summon', cats: ['test-calm'] });
    await menuClick(app, 'summon:test-calm');
    await expect
      .poll(async () =>
        (await commands()).some(
          (command) =>
            command.type === 'cat/summon' &&
            command.cats[0] === 'test-calm' &&
            command.to !== undefined,
        ),
      )
      .toBe(true);
    const content = await catalog(debug);
    const clip = content.cats['test-calm']?.clips.find((item) => item.name === 'idle-sit');
    if (!clip) throw new Error('测试猫缺少 idle-sit');
    await debug
      .getByRole('combobox', { name: zh.panels.clip, exact: true })
      .selectOption(`idle-sit:${clip.variant}`);
    await debug.getByRole('button', { name: zh.panels.playClip, exact: true }).click();
    await expect.poll(async () => (await current())?.clip, { timeout: 15_000 }).toBe('idle-sit');
    await debug.getByRole('button', { name: zh.panels.sleep, exact: true }).click();
    await expect.poll(async () => (await current())?.pose, { timeout: 15_000 }).toBe('sleep');
    await debug.getByRole('button', { name: zh.panels.simulations.pickUp, exact: true }).click();
    await expect.poll(async () => (await current())?.clip).toBe('dangle');
    await debug.getByRole('button', { name: zh.panels.simulations.drop, exact: true }).click();
    await expect.poll(async () => (await current())?.clip).not.toBe('dangle');
    await debug.getByRole('button', { name: zh.panels.hide, exact: true }).click();
    await expect
      .poll(async () => (await report(debug))?.cats.map((cat) => cat.cat))
      .not.toContain('test-calm');
    await debug.getByRole('button', { name: zh.panels.show, exact: true }).click();
    await expect
      .poll(async () => (await report(debug))?.cats.map((cat) => cat.cat))
      .toContain('test-calm');
    for (let index = 0; index < 4; index++) {
      await overlay.evaluate('window.ttcats.sendOverlay({ type: "catMenu", cat: "test-calm" })');
      await expect
        .poll(() =>
          app.evaluate(() => (globalThis as unknown as { smoke: Smoke }).smoke.popups.length),
        )
        .toBe(index + 1);
      expect(
        await app.evaluate(
          () => (globalThis as unknown as { smoke: Smoke }).smoke.popupWindows.at(-1)?.focusable,
        ),
      ).toBe(false);
      const labels = await app.evaluate(({ BrowserWindow }, chosen) => {
        const menu = (globalThis as unknown as { smoke: Smoke }).smoke.popups.at(-1);
        const item = menu?.items[chosen];
        if (!item) throw new Error('右键菜单项缺失');
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- 调用 Electron 原生菜单包装器。
        item.click(
          {},
          BrowserWindow.getAllWindows().find((window) => !window.isFocusable()),
          undefined,
        );
        return menu.items.map((item) => item.label);
      }, index);
      expect(labels).toEqual([
        zh.integration.come,
        zh.integration.sleep,
        zh.integration.hide,
        zh.integration.profile,
      ]);
      if (index === 2) {
        await expect
          .poll(async () => (await snapshot(debug)).settings.visibleCats)
          .not.toContain('test-calm');
        await menuClick(app, 'visible:test-calm');
      }
    }
    const profile = await pageFor(app, 'panel=profile');
    await expect(
      profile.getByRole('heading', { name: content.cats['test-calm']?.cat.name, exact: true }),
    ).toBeVisible();
    for (const [page, source] of [
      [debug, 'panel'],
      [overlay, 'overlay'],
    ] as const) {
      await page.evaluate(
        `setTimeout(() => { throw new Error('smoke-${source}-uncaught'); }, 0); void Promise.reject(new Error('smoke-${source}-rejection')); 0`,
      );
      for (const kind of ['uncaught', 'rejection']) {
        await expect
          .poll(() => readFileSync(join(directory, 'TTCats/logs/main.log'), 'utf8'))
          .toContain(`smoke-${source}-${kind}`);
      }
    }
  } finally {
    await app.close();
  }
});

test('四次真实渲染崩溃：安全模式回退、设置不唤醒猫且不覆盖存档', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ttcats-smoke-recovery-'));
  const data = join(directory, 'TTCats');
  mkdirSync(data);
  const originalSettings = {
    ...defaultSettings(ids),
    scale: 1.4,
    visibleCats: ['test-active', 'test-calm'],
  };
  const backupSettings = { ...defaultSettings(ids), scale: 0.8 };
  const envelope = (settings: typeof originalSettings) =>
    JSON.stringify({
      saveVersion: CURRENT_SAVE_VERSION,
      savedAt: Date.now(),
      state: { ...defaultGameState(ids), settings },
    });
  const original = envelope(originalSettings);
  const backup = envelope(backupSettings);
  writeFileSync(join(data, 'save.json'), original);
  writeFileSync(join(data, 'save.backup.0000000000000001.json'), backup);
  const app = await launch(directory);
  try {
    await pageFor(app, 'panel=settings');
    const debug = await openDebug(app);
    const content = await catalog(debug);
    const before = (await snapshot(debug)).revision;
    const oldMenu = await app.evaluate(
      () => (globalThis as unknown as { smoke: Smoke }).smoke.menus.length - 1,
    );
    for (let count = 1; count <= 4; count++) {
      await debug.getByRole('button', { name: zh.panels.crash, exact: true }).click();
      await expect
        .poll(() => app.evaluate(() => (globalThis as unknown as { smoke: Smoke }).smoke.crashes))
        .toBe(count);
      if (count < 4) {
        await expect
          .poll(
            async () => {
              try {
                return await app.evaluate(async ({ BrowserWindow }) => {
                  const window = BrowserWindow.getAllWindows().find((window) =>
                    window.webContents.getURL().includes('/overlay/'),
                  );
                  if (!window || window.webContents.isCrashed()) return false;
                  return (await window.webContents.executeJavaScript(
                    'Boolean(window.ttcats && document.querySelector("canvas"))',
                  )) as boolean;
                });
              } catch {
                return false;
              }
            },
            { timeout: 30_000 },
          )
          .toBe(true);
        expect((await snapshot(debug)).settings.scale).toBe(1.4);
      }
    }
    await expect
      .poll(() =>
        app.evaluate(() => (globalThis as unknown as { smoke: Smoke }).smoke.dialogs.length),
      )
      .toBe(1);
    const notice = await app.evaluate(
      () => (globalThis as unknown as { smoke: Smoke }).smoke.dialogs[0]?.message,
    );
    expect(notice).toContain('已加载最近一份正常的备份存档');
    for (const id of originalSettings.visibleCats)
      expect(notice).toContain(content.cats[id]?.cat.name);
    expect(notice).not.toContain(content.cats['test-close']?.cat.name);
    const settings = await pageFor(app, 'panel=settings');
    await expect.poll(async () => (await snapshot(settings)).settings.scale).toBe(0.8);
    expect((await snapshot(settings)).revision).toBeGreaterThan(before);
    expect((await catalog(settings)).disabled.map((cat) => cat.cat).sort()).toEqual([
      'test-active',
      'test-calm',
    ]);
    expect(await overlayVisible(app)).toBe(false);
    const unchanged = (await snapshot(settings)).settings;
    const menuCount = await app.evaluate(
      () => (globalThis as unknown as { smoke: Smoke }).smoke.menus.length,
    );
    await app.evaluate(({ BrowserWindow }, index) => {
      const item = (globalThis as unknown as { smoke: Smoke }).smoke.menus[index]?.getMenuItemById(
        'visible:test-active',
      );
      if (!item) throw new Error('找不到旧托盘复选框');
      // 已停用的猫使 core 拒绝旧菜单的命令；不能依赖 publish 刷新菜单。
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Electron 的菜单回调声明为 Function。
      item.click({}, BrowserWindow.getFocusedWindow() ?? undefined, undefined);
    }, oldMenu);
    expect((await snapshot(settings)).settings).toEqual(unchanged);
    expect(
      await app.evaluate(() => (globalThis as unknown as { smoke: Smoke }).smoke.menus.length),
    ).toBe(menuCount + 1);
    expect(
      await app.evaluate(() =>
        (globalThis as unknown as { smoke: Smoke }).smoke.menus
          .at(-1)
          ?.getMenuItemById('visible:test-active'),
      ),
    ).toBeNull();
    expect(readFileSync(join(data, 'logs/main.log'), 'utf8')).toContain(
      zh.game.catUnavailable('test-active'),
    );
    expect(
      await app.evaluate(
        () =>
          (globalThis as unknown as { smoke: Smoke }).smoke.menus
            .at(-1)
            ?.getMenuItemById('summon:test-close')?.enabled,
      ),
    ).toBe(false);
    await setRange(settings.getByRole('slider', { name: zh.panels.scale, exact: true }), 110);
    await expect.poll(async () => (await snapshot(settings)).settings.scale).toBe(1.1);
    await menuClick(app, 'capture');
    await app.evaluate(({ screen }) => {
      screen.emit('display-metrics-changed', {}, screen.getPrimaryDisplay(), ['workArea']);
    });
    await setFullscreen(app, true);
    await new Promise((resolve) => setTimeout(resolve, 600));
    await setFullscreen(app, false);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(await overlayVisible(app)).toBe(false);
    expect(readFileSync(join(data, 'save.json'), 'utf8')).toBe(original);
    await app.close();
    expect(readFileSync(join(data, 'save.json'), 'utf8')).toBe(original);
    expect(readFileSync(join(data, 'save.backup.0000000000000001.json'), 'utf8')).toBe(backup);
  } finally {
    await app.close();
  }
});

test('无效 IPC 的日志同时说明消息类型和字段路径', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ttcats-smoke-invalid-'));
  const app = await launch(directory);
  try {
    const settings = await pageFor(app, 'panel=settings');
    const overlay = await pageFor(app, '/overlay/');
    await settings.evaluate('window.ttcats.sendCommand({type:"settings/update",patch:{scale:10}})');
    await overlay.evaluate(
      'window.ttcats.sendFact({type:"cat/petted",cat:"test-active",at:1,durationMs:-1})',
    );
    await expect
      .poll(() => readFileSync(join(directory, 'TTCats/logs/main.log'), 'utf8'))
      .toContain('patch.scale');
    const log = readFileSync(join(directory, 'TTCats/logs/main.log'), 'utf8');
    expect(log).toContain('settings/update');
    expect(log).toContain('cat/petted');
    expect(log).toContain('durationMs');
  } finally {
    await app.close();
  }
});

for (const discard of [false, true]) {
  test(`存档目录拒绝写入：${discard ? '放弃保存仍能正常退出' : '重试会再次保存，恢复权限后保存成功'}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ttcats-smoke-save-failed-'));
    const app = await launch(directory);
    let exited = false;
    try {
      const settings = await pageFor(app, 'panel=settings');
      await app.evaluate(() => {
        (globalThis as unknown as { smoke: Smoke }).smoke.saveBlocked = true;
      });
      await settings.evaluate(
        'window.ttcats.sendCommand({type:"settings/update",patch:{scale:1.5}})',
      );
      await expect.poll(async () => (await snapshot(settings)).settings.scale).toBe(1.5);
      await app.evaluate(({ app }) => {
        app.quit();
      });
      await expect
        .poll(() =>
          app.evaluate(
            () => (globalThis as unknown as { smoke: Smoke }).smoke.saveDialogResolvers.length,
          ),
        )
        .toBe(1);
      const options = await app.evaluate(() =>
        (globalThis as unknown as { smoke: Smoke }).smoke.dialogs.at(-1),
      );
      expect(options?.buttons).toEqual([
        zh.integration.retrySave,
        zh.integration.quitWithoutSaving,
      ]);
      expect(options?.defaultId).toBe(0);
      expect(options?.cancelId).toBe(0);
      if (!discard) {
        await app.evaluate(() => {
          (globalThis as unknown as { smoke: Smoke }).smoke.saveDialogResolvers.shift()?.(0);
        });
        await expect
          .poll(() =>
            app.evaluate(() => (globalThis as unknown as { smoke: Smoke }).smoke.dialogs.length),
          )
          .toBe(2);
        await expect
          .poll(() =>
            app.evaluate(
              () => (globalThis as unknown as { smoke: Smoke }).smoke.saveDialogResolvers.length,
            ),
          )
          .toBe(1);
      }
      const closed = app.waitForEvent('close');
      await app.evaluate((_, discard) => {
        const smoke = (globalThis as unknown as { smoke: Smoke }).smoke;
        if (!discard) smoke.saveBlocked = false;
        smoke.saveDialogResolvers.shift()?.(discard ? 1 : 0);
      }, discard);
      await closed;
      exited = true;
      const log = readFileSync(join(directory, 'TTCats/logs/main.log'), 'utf8');
      if (discard) expect(log).toContain(zh.integration.saveAbandoned);
      else {
        const saved = JSON.parse(readFileSync(join(directory, 'TTCats/save.json'), 'utf8')) as {
          state: { settings: { scale: number } };
        };
        expect(saved.state.settings.scale).toBe(1.5);
        expect(log).not.toContain(zh.integration.saveAbandoned);
      }
    } finally {
      if (!exited) {
        await app
          .evaluate(() => {
            const smoke = (globalThis as unknown as { smoke: Smoke }).smoke;
            smoke.saveBlocked = false;
            smoke.saveDialogResolvers.shift()?.(1);
          })
          .catch(() => {});
        await app.close();
      }
    }
  });
}
