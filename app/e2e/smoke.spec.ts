import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
import { IPC_CHANNELS } from '../src/shared/ipc';
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
  blockedShortcut: string | null;
  fullscreen: boolean;
  crashes: number;
  slowRequests: number;
  pointerInput: { x: number; y: number; leftDown: boolean; ctrlDown: boolean } | null;
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
      (window) =>
        !window.isDestroyed() &&
        !window.webContents.isDestroyed() &&
        window.webContents.getURL().includes('/overlay/') &&
        window.isVisible(),
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

test('M2 接线：入场出场、召唤全部、勿扰到期、快捷键及全屏恢复', async () => {
  test.setTimeout(300_000);
  const directory = mkdtempSync(join(tmpdir(), 'ttcats-smoke-m2-wiring-'));
  // 用正式支持的 200% 大小缩短合成慢走片段的路程时间，不跳过真实动画。
  mkdirSync(join(directory, 'TTCats'));
  const state = defaultGameState(ids);
  state.settings.scale = 2;
  writeFileSync(
    join(directory, 'TTCats/save.json'),
    JSON.stringify({ saveVersion: CURRENT_SAVE_VERSION, savedAt: Date.now(), state }),
  );
  let app = await launch(directory);
  try {
    const settings = await pageFor(app, 'panel=settings');
    let overlay = await pageFor(app, '/overlay/');
    const debug = await openDebug(app);
    await expect.poll(async () => (await report(debug))?.cats.length).toBe(3);
    await overlay.evaluate(
      'window.smokeCommands = []; window.smokePause = []; window.ttcats.onStageCommand(c => window.smokeCommands.push(c)); window.ttcats.onOverlay(m => { if(m.type === "paused") window.smokePause.push(m.paused); });',
    );
    const commands = () => overlay.evaluate<StageCommand[]>('window.smokeCommands');
    const clearCommands = () => overlay.evaluate('window.smokeCommands = []');
    const behaviors = async () => (await report(debug))?.cats.map((c) => c.behavior);
    await debug.getByRole('button', { name: zh.panels.entranceAll, exact: true }).click();
    await expect.poll(behaviors).toEqual(ids.map(() => zh.stageLifecycle.entrance));
    const starting = (await report(debug))?.cats;
    const width = await overlay.evaluate<number>('innerWidth');
    expect(starting?.some((c) => c.x < 0 || c.x > width)).toBe(true);
    await expect
      .poll(async () => (await behaviors())?.includes(zh.stageLifecycle.entrance), {
        // 合成走路片段只有 30 px/s；较小的猫横穿屏幕可能超过一分钟。
        timeout: 120_000,
      })
      .toBe(false);
    await menuClick(app, 'visible:test-close');
    await expect
      .poll(async () => (await report(debug))?.cats.find((c) => c.cat === 'test-close')?.behavior)
      .toBe(zh.stageLifecycle.exit);
    await expect
      .poll(async () => (await report(debug))?.cats.some((c) => c.cat === 'test-close'), {
        timeout: 120_000,
      })
      .toBe(false);
    await menuClick(app, 'visible:test-close');
    await expect
      .poll(async () => (await report(debug))?.cats.find((c) => c.cat === 'test-close')?.behavior)
      .toBe(zh.stageLifecycle.entrance);
    await menuClick(app, 'summon:all');
    await expect
      .poll(commands)
      .toContainEqual({ type: 'cat/summon', cats: ids, to: expect.any(Object) });

    await menuClick(app, 'doNotDisturb:30m');
    await expect.poll(async () => (await snapshot(settings)).doNotDisturb.mode).toBe('timed');
    await expect
      .poll(behaviors, { timeout: 120_000 })
      .toEqual(ids.map(() => zh.stageLifecycle.doNotDisturbSleep));
    await debug.getByRole('spinbutton', { name: zh.panels.advanceMinutes, exact: true }).fill('30');
    await debug.getByRole('button', { name: zh.panels.advanceClock, exact: true }).click();
    await expect.poll(async () => (await snapshot(settings)).doNotDisturb.mode).toBe('off');
    await expect
      .poll(async () => (await behaviors())?.includes(zh.stageLifecycle.doNotDisturbSleep))
      .toBe(false);

    const invokeShortcut = async () => {
      const key = (await snapshot(settings)).settings.hideAllShortcut;
      await app.evaluate(({ globalShortcut }, accelerator) => {
        if (!globalShortcut.isRegistered(accelerator)) throw new Error('一键隐藏未注册');
        const callback = (globalThis as unknown as { smoke: Smoke }).smoke.shortcuts.get(
          accelerator,
        );
        if (!callback) throw new Error('缺少快捷键回调');
        callback();
      }, key);
    };
    const originalShortcut = (await snapshot(settings)).settings.hideAllShortcut;
    await invokeShortcut();
    await expect.poll(() => overlayVisible(app)).toBe(false);
    expect((await snapshot(settings)).hideAll).toBe(true);
    await clearCommands();
    await invokeShortcut();
    await expect.poll(() => overlayVisible(app)).toBe(true);
    await expect.poll(commands).toContainEqual({ type: 'cat/entrance' });
    await settings.evaluate(
      'window.ttcats.sendCommand({ type: "settings/update", patch: { hideAllShortcut: "Ctrl+Alt+F9" } })',
    );
    await expect
      .poll(() => settings.evaluate<AppStatus>('window.ttcats.getAppStatus()'))
      .toMatchObject({ hideAllShortcut: { accelerator: 'Ctrl+Alt+F9', registered: true } });
    expect(
      await app.evaluate(
        ({ globalShortcut }, key) => globalShortcut.isRegistered(key),
        originalShortcut,
      ),
    ).toBe(false);
    await invokeShortcut();
    await expect.poll(() => overlayVisible(app)).toBe(false);
    await invokeShortcut();
    await expect.poll(() => overlayVisible(app)).toBe(true);
    await app.evaluate(() => {
      (globalThis as unknown as { smoke: Smoke }).smoke.blockedShortcut = 'Ctrl+Alt+F8';
    });
    await settings.evaluate(
      'window.ttcats.sendCommand({ type: "settings/update", patch: { hideAllShortcut: "Ctrl+Alt+F8" } })',
    );
    await expect
      .poll(() => settings.evaluate<AppStatus>('window.ttcats.getAppStatus()'))
      .toMatchObject({ hideAllShortcut: { accelerator: 'Ctrl+Alt+F8', registered: false } });
    expect(readFileSync(join(directory, 'TTCats/logs/main.log'), 'utf8')).toContain(
      zh.m2Wiring.shortcutFailed('Ctrl+Alt+F8'),
    );
    await settings.evaluate(
      'window.ttcats.sendCommand({ type: "settings/update", patch: { hideAllShortcut: "Ctrl+Alt+F9" } })',
    );
    await expect
      .poll(() => settings.evaluate<AppStatus>('window.ttcats.getAppStatus()'))
      .toMatchObject({ hideAllShortcut: { registered: true } });

    for (const simulated of [true, false]) {
      await clearCommands();
      if (simulated)
        await debug.getByRole('button', { name: zh.panels.fullscreenStart, exact: true }).click();
      else await setFullscreen(app, true);
      await expect.poll(() => overlayVisible(app)).toBe(false);
      if (simulated)
        await debug.getByRole('button', { name: zh.panels.fullscreenEnd, exact: true }).click();
      else await setFullscreen(app, false);
      await expect.poll(() => overlayVisible(app)).toBe(true);
      await expect.poll(commands).toEqual([{ type: 'cat/entrance' }]);
      await expect.poll(behaviors).toEqual(ids.map(() => zh.stageLifecycle.entrance));
    }
    await menuClick(app, 'doNotDisturb:untilOff');
    await invokeShortcut();
    await expect.poll(() => overlayVisible(app)).toBe(false);
    await app.close();
    app = await launch(directory);
    const restored = await pageFor(app, 'panel=settings');
    overlay = await pageFor(app, '/overlay/');
    expect(await snapshot(restored)).toMatchObject({
      doNotDisturb: { mode: 'untilOff' },
      hideAll: false,
      clockOffsetMs: 0,
    });
    await expect.poll(() => overlayVisible(app)).toBe(true);
    const recoveredDebug = await openDebug(app);
    await recoveredDebug
      .getByRole('button', { name: zh.panels.doNotDisturbEnd, exact: true })
      .click();
    await expect.poll(async () => (await snapshot(restored)).doNotDisturb.mode).toBe('off');
    await recoveredDebug.getByRole('button', { name: zh.panels.crash, exact: true }).click();
    await expect
      .poll(() => app.evaluate(() => (globalThis as unknown as { smoke: Smoke }).smoke.crashes))
      .toBe(1);
    await recoveredDebug.evaluate('window.smokeReport = undefined');
    await expect
      .poll(async () => (await report(recoveredDebug))?.cats.map((c) => c.behavior), {
        timeout: 30_000,
      })
      .toEqual(ids.map(() => zh.stageLifecycle.entrance));
  } finally {
    await app.close();
  }
});

test('定时推进：没有操作或快进时，勿扰仍按真实时间到期并写回存档', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ttcats-smoke-real-tick-'));
  mkdirSync(join(directory, 'TTCats'));
  const state = defaultGameState(ids);
  state.doNotDisturb = { mode: 'timed', until: Date.now() + 10_000 };
  const file = join(directory, 'TTCats/save.json');
  writeFileSync(
    file,
    JSON.stringify({ saveVersion: CURRENT_SAVE_VERSION, savedAt: Date.now(), state }),
  );
  const app = await launch(directory);
  try {
    const settings = await pageFor(app, 'panel=settings');
    expect((await snapshot(settings)).doNotDisturb.mode).toBe('timed');
    await expect
      .poll(async () => (await snapshot(settings)).doNotDisturb.mode, { timeout: 15_000 })
      .toBe('off');
    await expect
      .poll(
        () =>
          (JSON.parse(readFileSync(file, 'utf8')) as { state: { doNotDisturb: { mode: string } } })
            .state.doNotDisturb.mode,
      )
      .toBe('off');
  } finally {
    await app.close();
  }
});

test('最后一只猫：调试台关闭后仍走完出场，再暂停桌面层', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ttcats-smoke-last-exit-'));
  mkdirSync(join(directory, 'TTCats'));
  const state = defaultGameState(['test-active']);
  state.settings.scale = 2;
  writeFileSync(
    join(directory, 'TTCats/save.json'),
    JSON.stringify({ saveVersion: CURRENT_SAVE_VERSION, savedAt: Date.now(), state }),
  );
  const app = await launch(directory);
  try {
    await pageFor(app, 'panel=settings');
    const overlay = await pageFor(app, '/overlay/');
    const width = await overlay.evaluate<number>('innerWidth');
    const debug = await openDebug(app);
    await expect
      .poll(
        async () => {
          const cat = (await report(debug))?.cats[0];
          return cat !== undefined && cat.x >= 200 && cat.x <= width - 200;
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    await overlay.evaluate(
      'window.smokePause = []; window.ttcats.onOverlay(m => { if(m.type === "paused") window.smokePause.push(m.paused); });',
    );
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().includes('panel=debug'))
        ?.close(),
    );
    await menuClick(app, 'visible:test-active');
    expect(await overlayVisible(app)).toBe(true);
    await expect.poll(() => overlayVisible(app), { timeout: 30_000 }).toBe(false);
    expect(await overlay.evaluate<boolean[]>('window.smokePause')).toContain(true);
    await menuClick(app, 'visible:test-active');
    await expect.poll(() => overlayVisible(app)).toBe(true);
  } finally {
    await app.close();
  }
});

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
    await expect.poll(async () => (await current())?.behavior).toBe(zh.stageLifecycle.exit);
    // M2 隐藏要先落地、走到屏幕外，不能沿用 M1 立刻消失的 5 秒期限。
    await expect
      .poll(async () => (await report(debug))?.cats.map((cat) => cat.cat), { timeout: 60_000 })
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

test('旁边连续点击：正式输入采样链路保持穿透，调试命令能让开并在勿扰时原地接着睡', async () => {
  // 等出场、入场，以及靠边的猫让开时横穿屏幕，都按真实时间走。
  test.setTimeout(240_000);
  const directory = mkdtempSync(join(tmpdir(), 'ttcats-smoke-nearby-'));
  const app = await launch(directory);
  try {
    const overlay = await pageFor(app, '/overlay/');
    const debug = await openDebug(app);
    await debug.evaluate(
      'window.ttcats.sendCommand({type:"settings/update",patch:{visibleCats:["test-active"]}})',
    );
    await expect
      .poll(async () => (await report(debug))?.cats.map((cat) => cat.cat))
      .toEqual(['test-active']);
    const bounds = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().includes('/overlay/'),
      );
      if (!window) throw new Error('找不到桌面层');
      return window.getBounds();
    });
    await debug.evaluate(
      ({ x, y }) => {
        (
          globalThis as unknown as { ttcats: { sendCommand: (command: unknown) => void } }
        ).ttcats.sendCommand({
          type: 'cat/summon',
          cat: 'test-active',
          to: { x, y },
        });
      },
      { x: bounds.width / 2, y: bounds.height },
    );
    await expect
      .poll(async () => (await report(debug))?.cats[0]?.clip, { timeout: 20000 })
      .toBe('idle-stand');
    await debug.evaluate(
      'window.ttcats.sendCommand({type:"debug/playClip",cat:"test-active",clip:"idle-stand"})',
    );
    await expect
      .poll(async () => (await report(debug))?.cats[0]?.behavior)
      .toBe('调试：播放「idle-stand」');
    const before = (await report(debug))?.cats[0];
    if (!before) throw new Error('缺少猫的位置');
    const unit =
      150 *
      (await snapshot(debug)).settings.scale *
      ((await catalog(debug)).cats['test-active']?.cat.relativeSize ?? 1);
    const point = { x: before.x + 1.5 * unit, y: before.y - unit / 2 };
    await overlay.evaluate(
      'window.smokeClicks = []; window.ttcats.onOverlay(m => { if(m.type === "clickThrough") window.smokeClicks.push(m); })',
    );
    await app.evaluate(
      ({ BrowserWindow }, input) => {
        const smoke = (globalThis as unknown as { smoke: Smoke }).smoke;
        smoke.pointerInput = input;
        const window = BrowserWindow.getAllWindows().find((w) =>
          w.webContents.getURL().includes('/overlay/'),
        );
        if (!window) throw new Error('找不到桌面层');
        const observed = window as typeof window & { smokeIgnore: boolean[] };
        observed.smokeIgnore = [];
        const original = window.setIgnoreMouseEvents.bind(window);
        window.setIgnoreMouseEvents = (ignore, options) => {
          observed.smokeIgnore.push(ignore);
          original(ignore, options);
        };
      },
      { x: bounds.x + point.x, y: bounds.y + point.y, leftDown: false, ctrlDown: true },
    );
    await expect
      .poll(() => overlay.evaluate('document.querySelector("canvas") !== null'))
      .toBe(true);
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      await app.evaluate(() => {
        const input = (globalThis as unknown as { smoke: Smoke }).smoke.pointerInput;
        if (input) input.leftDown = true;
      });
      await expect
        .poll(() => overlay.evaluate<number>('window.smokeClicks.length'), { intervals: [30] })
        .toBe(i + 1);
      await app.evaluate(() => {
        const input = (globalThis as unknown as { smoke: Smoke }).smoke.pointerInput;
        if (input) input.leftDown = false;
      });
    }
    await expect.poll(async () => (await report(debug))?.cats[0]?.behavior).toBe('走开');
    await expect
      .poll(async () => (await report(debug))?.cats[0]?.x ?? before.x)
      .toBeLessThan(before.x - 20);
    expect(
      await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows().find((w) =>
          w.webContents.getURL().includes('/overlay/'),
        );
        return (window as typeof window & { smokeIgnore: boolean[] }).smokeIgnore;
      }),
    ).not.toContain(false);

    // 换一只猫，没有前一次让开的冷却；从调试面板的正式桥接发送命令。
    await debug.evaluate(
      'window.ttcats.sendCommand({type:"settings/update",patch:{visibleCats:["test-calm"]}})',
    );
    // 被隐藏的猫要先走出屏幕才移除（#59）。
    await expect
      .poll(async () => (await report(debug))?.cats.map((cat) => cat.cat), { timeout: 60_000 })
      .toEqual(['test-calm']);
    // 勿扰命令和到期计时由 #58 实现；这里在快照边界提供勿扰状态，验证 #60 的响应。
    const dndSnapshot: StateSnapshot = {
      ...(await snapshot(debug)),
      doNotDisturb: { mode: 'untilOff' },
      revision: 10000,
    };
    await app.evaluate(
      ({ BrowserWindow }, { channel, state }) => {
        const window = BrowserWindow.getAllWindows().find((w) =>
          w.webContents.getURL().includes('/overlay/'),
        );
        if (!window) throw new Error('找不到桌面层');
        window.webContents.send(channel, state);
      },
      { channel: IPC_CHANNELS.snapshot, state: dndSnapshot },
    );
    // 先等它入场、走到勿扰角落睡下，再验证让开后不回角落。
    await expect
      .poll(async () => (await report(debug))?.cats[0]?.clip, { timeout: 60_000 })
      .toBe('sleep');
    await debug.evaluate(
      'window.ttcats.sendCommand({type:"debug/simulate",cat:"test-calm",interaction:"nearbyClicks"})',
    );
    await expect.poll(async () => (await report(debug))?.cats[0]?.behavior).toBe('走开');
    // 角落靠边时只能往另一头走，慢猫横穿屏幕要几十秒。
    await expect
      .poll(async () => (await report(debug))?.cats[0]?.clip, { timeout: 90_000 })
      .toBe('sleep');
    const sleepingX = (await report(debug))?.cats[0]?.x;
    await new Promise((resolve) => setTimeout(resolve, 7000));
    expect((await report(debug))?.cats[0]?.clip).toBe('sleep');
    expect((await report(debug))?.cats[0]?.x).toBe(sleepingX);
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

test('拍照：真实桌面含猫和窗口、原始分辨率、剪贴板、隐身恢复和焦点', async () => {
  const testInfo = test.info();
  const directory = mkdtempSync(join(tmpdir(), 'ttcats-smoke-photo-'));
  const app = await launch(directory);
  let probeApp: ElectronApplication | undefined;
  try {
    const overlay = await pageFor(app, '/overlay/');
    const debug = await openDebug(app);
    await expect.poll(() => overlayVisible(app)).toBe(true);
    await expect.poll(async () => (await report(debug))?.cats.length).toBe(3);
    // 猫从屏幕外慢慢走进来（#59），至少等一只完全进入屏幕再拍。
    const width = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().includes('/overlay/'),
      );
      if (!window) throw new Error('找不到桌面层');
      return window.getBounds().width;
    });
    await expect
      .poll(
        async () =>
          (await report(debug))?.cats.some((cat) => cat.x > width * 0.15 && cat.x < width * 0.85),
        { timeout: 60_000 },
      )
      .toBe(true);
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows())
        if (!window.webContents.getURL().includes('/overlay/')) window.hide();
    });
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env))
      if (value !== undefined) env[key] = value;
    delete env['ELECTRON_RUN_AS_NODE'];
    probeApp = await electron.launch({
      args: [resolve(import.meta.dirname, 'interaction-probe.js')],
      env,
    });
    const probe = await probeApp.firstWindow();
    await probe.locator('#input').fill('before');
    await probeApp.evaluate(({ app, BrowserWindow, screen }) => {
      app.focus({ steal: true });
      const window = BrowserWindow.getAllWindows()[0];
      window?.setBounds(screen.getPrimaryDisplay().workArea);
      window?.moveTop();
      window?.focus();
    });
    const enabled = () =>
      app.evaluate(
        () =>
          (globalThis as unknown as { smoke: Smoke }).smoke.menus.at(-1)?.getMenuItemById('photo')
            ?.enabled,
      );
    for (const showInScreenCapture of [true, false]) {
      await debug.evaluate((show) => {
        (
          globalThis as unknown as { ttcats: { sendCommand: (command: unknown) => void } }
        ).ttcats.sendCommand({ type: 'settings/update', patch: { showInScreenCapture: show } });
      }, showInScreenCapture);
      await expect
        .poll(async () => (await snapshot(debug)).settings.showInScreenCapture)
        .toBe(showInScreenCapture);
      await expect.poll(enabled).toBe(true);
      const focused = await probeApp.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id,
      );
      expect(focused).toBeDefined();
      await app.evaluate(({ clipboard }) => {
        clipboard.clear();
      });
      if (showInScreenCapture) await menuClick(app, 'photo');
      else await debug.evaluate('window.ttcats.sendCommand({type:"photo/take"})');
      await expect(overlay.locator('[data-photo]')).toBeAttached();
      await expect(overlay.locator('[data-photo]')).toHaveCSS('pointer-events', 'none');
      expect(
        await probeApp.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id),
      ).toBe(focused);
      // 连续命令不能在动画期间产生第二张。
      await debug.evaluate('window.ttcats.sendCommand({type:"photo/take"})');
      await expect(overlay.locator('[data-photo]')).toHaveCount(0);
      await expect.poll(enabled).toBe(true);
      const files = readdirSync(join(directory, 'pictures/TTCats'));
      expect(files.length).toBe(showInScreenCapture ? 1 : 2);
      const file = join(directory, 'pictures/TTCats', files.at(-1) ?? '');
      const result = await app.evaluate(
        async ({ BrowserWindow, clipboard, nativeImage, screen }, file) => {
          const overlay = BrowserWindow.getAllWindows().find((w) =>
            w.webContents.getURL().includes('/overlay/'),
          );
          if (!overlay) throw new Error('找不到桌面层');
          const display = screen.getDisplayMatching(overlay.getBounds());
          const image = nativeImage.createFromPath(file);
          const bitmap = image.toBitmap();
          let catPixels = 0;
          let backgroundPixels = 0;
          for (let i = 0; i < bitmap.length; i += 4) {
            const b = bitmap[i] ?? 0,
              g = bitmap[i + 1] ?? 0,
              r = bitmap[i + 2] ?? 0;
            if (r > 220 && g > 155 && g < 205 && b > 55 && b < 110) catPixels++;
            if (r === 77 && g === 111 && b === 143) backgroundPixels++;
          }
          const items = await clipboard.read();
          const item = items.find((item) => item.types.includes('image/png'));
          const png = item
            ? Buffer.from(await (await item.getType('image/png')).arrayBuffer())
            : Buffer.alloc(0);
          const copied = nativeImage.createFromBuffer(png);
          return {
            size: image.getSize(),
            expected: {
              width: Math.round(display.size.width * display.scaleFactor),
              height: Math.round(display.size.height * display.scaleFactor),
            },
            catPixels,
            backgroundPixels,
            protected: overlay.isContentProtected(),
            focusable: overlay.isFocusable(),
            clipboardMatches: !copied.isEmpty() && image.toBitmap().equals(copied.toBitmap()),
          };
        },
        file,
      );
      expect(result.size).toEqual(result.expected);
      expect(result.protected).toBe(!showInScreenCapture);
      expect(result.focusable).toBe(false);
      expect(result.clipboardMatches).toBe(true);
      expect(result.catPixels).toBeGreaterThan(100);
      // 桌面可能有其他用户窗口；仍要求大片探针原色，排除闪光覆盖整屏。
      expect(result.backgroundPixels).toBeGreaterThan(result.size.width * result.size.height * 0.2);
      await testInfo.attach(`photo-${String(showInScreenCapture)}.png`, {
        path: file,
        contentType: 'image/png',
      });
      await testInfo.attach(`photo-${String(showInScreenCapture)}.json`, {
        body: JSON.stringify(result, null, 2),
        contentType: 'application/json',
      });
      await probe.locator('#input').press('End');
      await probe.locator('#input').press('a');
      await expect(probe.locator('#input')).toHaveValue(
        showInScreenCapture ? 'beforea' : 'beforeaa',
      );
    }
    await setFullscreen(app, true);
    await expect.poll(enabled).toBe(false);
    await setFullscreen(app, false);
    await expect.poll(enabled).toBe(true);
    for (const cat of ids)
      await debug.evaluate((cat) => {
        (
          globalThis as unknown as { ttcats: { sendCommand: (command: unknown) => void } }
        ).ttcats.sendCommand({ type: 'cat/setVisible', cat, visible: false });
      }, cat);
    await expect.poll(enabled).toBe(false);
    await debug.evaluate('window.ttcats.sendCommand({type:"photo/take"})');
    expect(readdirSync(join(directory, 'pictures/TTCats'))).toHaveLength(2);
  } finally {
    await probeApp?.close();
    await app.close();
  }
});

test('声音：真实解码、调试命令、呼噜停止与空闲挂起', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ttcats-smoke-audio-'));
  const app = await launch(directory);
  try {
    const overlay = await pageFor(app, '/overlay/');
    const debug = await openDebug(app);
    // M2 已接入真实安静时段；声音解码测试不能随执行时的钟点变成静音测试。
    await debug.evaluate(
      'window.ttcats.sendCommand({ type: "settings/update", patch: { quietHoursStart: "00:00", quietHoursEnd: "00:00" } })',
    );
    await expect.poll(async () => (await snapshot(debug)).silencedBy).toEqual([]);
    const audible = () =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some(
          (window) =>
            window.webContents.getURL().includes('/overlay/') &&
            window.webContents.isCurrentlyAudible(),
        ),
      );
    const sound = async (kind: 'meow' | 'purr') => {
      await overlay.evaluate((sound) => {
        (
          globalThis as unknown as { ttcats: { sendCommand: (command: unknown) => void } }
        ).ttcats.sendCommand({ type: 'debug/sound', cat: 'test-calm', sound });
      }, kind);
    };
    await expect.poll(async () => (await report(debug))?.audio?.suspended).toBe(true);
    for (const kind of ['meow', 'purr'] as const) {
      await sound(kind);
      await expect.poll(audible, { intervals: [50, 100] }).toBe(true);
      await expect
        .poll(async () => (await report(debug))?.audio?.playing, { intervals: [50, 100] })
        .toContainEqual({ cat: 'test-calm', sound: kind });
      await expect
        .poll(async () => (await report(debug))?.audio)
        .toEqual({ playing: [], suspended: true });
    }
    // 用正式设置命令关闭喵叫：声音命令仍到达，但播放器不能出声。
    await overlay.evaluate(
      'window.ttcats.sendCommand({type:"settings/update",patch:{meowEnabled:false}})',
    );
    await expect.poll(async () => (await snapshot(overlay)).settings.meowEnabled).toBe(false);
    await sound('meow');
    const at = (await report(debug))?.at ?? 0;
    await expect.poll(async () => (await report(debug))?.at ?? 0).toBeGreaterThan(at + 1000);
    expect((await report(debug))?.audio).toEqual({ playing: [], suspended: true });
    await sound('purr');
    await expect.poll(audible).toBe(true);
    await setFullscreen(app, true);
    await expect.poll(() => overlayVisible(app)).toBe(false);
    await expect
      .poll(async () => (await report(debug))?.audio)
      .toEqual({ playing: [], suspended: true });
    await setFullscreen(app, false);
    await expect.poll(() => overlayVisible(app)).toBe(true);
    await sound('purr');
    await expect
      .poll(async () => (await report(debug))?.audio?.playing)
      .toContainEqual({ cat: 'test-calm', sound: 'purr' });
    await overlay.evaluate(
      'window.ttcats.sendCommand({type:"cat/setVisible",cat:"test-calm",visible:false})',
    );
    await expect
      .poll(async () => (await report(debug))?.audio)
      .toEqual({ playing: [], suspended: true });
    const log = readFileSync(join(directory, 'TTCats/logs/main.log'), 'utf8');
    expect(log).not.toContain('无法播放声音文件');
  } finally {
    await app.close();
  }
});
