import assert from 'node:assert/strict';
import * as fs from 'node:fs';
// eslint-disable-next-line no-restricted-imports -- 验收脚本使用系统临时目录，不是应用的平台实现。
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { _electron, expect } from '@playwright/test';
import { build } from 'vite';
import { GameStateSchema } from '../../shared/schemas/save';

const appRoot = resolve(import.meta.dirname, '../../..');
const output = join(appRoot, 'out/recovery-check');
await build({
  configFile: false,
  root: appRoot,
  logLevel: 'warn',
  build: {
    outDir: output,
    emptyOutDir: true,
    lib: {
      entry: join(import.meta.dirname, 'desktop.fixture.ts'),
      formats: ['es'],
      fileName: () => 'desktop.mjs',
    },
    rollupOptions: { external: ['electron', 'zod', /^node:/] },
  },
});
const directory = fs.mkdtempSync(join(tmpdir(), 'ttcats-recovery-desktop-'));
const electron = await _electron.launch({
  args: [join(output, 'desktop.mjs')],
  env: { ...process.env, TTCATS_RECOVERY_CHECK_DIR: directory },
});
try {
  electron.process().stderr?.on('data', (data: Buffer) => {
    console.error(data.toString());
  });
  await expect
    .poll(async () =>
      (await Promise.all(electron.windows().map((page) => page.title()))).includes(
        'Recovery panels',
      ),
    )
    .toBe(true);
  const titles = await Promise.all(electron.windows().map((page) => page.title()));
  const panels = electron.windows()[titles.indexOf('Recovery panels')];
  const overlay = electron.windows()[titles.indexOf('Recovery overlay')];
  assert.ok(panels);
  assert.ok(overlay);
  const original = fs.readFileSync(join(directory, 'save.json'), 'utf8');

  // 真正的未捕获异常和 rejection，主进程通过 Electron console-message 接收。
  await panels.evaluate(
    "setTimeout(() => { throw new Error('panels-uncaught-proof'); }, 0); void Promise.reject(new Error('panels-rejection-proof')); 0",
  );
  await overlay.evaluate(
    "setTimeout(() => { throw new Error('overlay-uncaught-proof'); }, 0); void Promise.reject(new Error('overlay-rejection-proof')); 0",
  );
  await expect
    .poll(() =>
      fs
        .readdirSync(join(directory, 'logs'))
        .map((name) => fs.readFileSync(join(directory, 'logs', name), 'utf8'))
        .join('\n'),
    )
    .toContain('panels-rejection-proof');
  const logText = fs
    .readdirSync(join(directory, 'logs'))
    .map((name) => fs.readFileSync(join(directory, 'logs', name), 'utf8'))
    .join('\n');
  for (const marker of [
    'panels-uncaught-proof',
    'overlay-uncaught-proof',
    'overlay-rejection-proof',
  ])
    assert.ok(logText.includes(marker), marker);

  for (let count = 1; count <= 4; count++) {
    // 走已构建的正式 preload 和 #18 的命令通道，而不是直接调用控制器。
    await panels.evaluate("window.ttcats.sendCommand({type: 'debug/crashOverlay'})");
    if (count <= 3) {
      await expect
        .poll(() =>
          fs.existsSync(join(directory, 'reloads.json'))
            ? fs.readFileSync(join(directory, 'reloads.json'), 'utf8')
            : '0',
        )
        .toBe(String(count));
    } else {
      await expect.poll(() => fs.existsSync(join(directory, 'safe-mode.json'))).toBe(true);
    }
  }
  const recovered: unknown = JSON.parse(fs.readFileSync(join(directory, 'safe-mode.json'), 'utf8'));
  assert.ok(
    typeof recovered === 'object' &&
      recovered !== null &&
      'state' in recovered &&
      'disabledCats' in recovered,
  );
  assert.deepEqual(GameStateSchema.parse(recovered.state).settings.visibleCats, ['backup-cat']);
  assert.deepEqual(recovered.disabledCats, ['test-cat']);
  assert.equal(fs.readFileSync(join(directory, 'save.json'), 'utf8'), original);
  await expect
    .poll(async () =>
      (await Promise.all(electron.windows().map((page) => page.title()))).includes(
        'TTCats 已进入安全模式',
      ),
    )
    .toBe(true);
  const noticeTitles = await Promise.all(electron.windows().map((page) => page.title()));
  const notice = electron.windows()[noticeTitles.indexOf('TTCats 已进入安全模式')];
  assert.ok(notice);
  await expect(notice.locator('p')).toContainText('已加载最近一份正常的备份存档');
  await expect(notice.locator('p')).toContainText('本次运行已停用猫咪包：test-cat');
  await notice.screenshot({ path: join(directory, 'safe-mode.png') });
  console.log(
    JSON.stringify({
      platform: 'Windows',
      electron: await electron.evaluate(({ app }) => app.getVersion()),
      reloads: 3,
      safeMode: true,
      rendererErrors: 4,
      evidenceDirectory: directory,
    }),
  );
} finally {
  await electron.close();
}

// 单独启动一次，真实阻塞桌面层的 JS 线程，验证 Electron 的无响应事件。
const hangDirectory = fs.mkdtempSync(join(tmpdir(), 'ttcats-recovery-hang-'));
const hungApp = await _electron.launch({
  args: [join(output, 'desktop.mjs')],
  env: { ...process.env, TTCATS_RECOVERY_CHECK_DIR: hangDirectory },
});
try {
  await expect
    .poll(async () =>
      (await Promise.all(hungApp.windows().map((page) => page.title()))).includes(
        'Recovery overlay',
      ),
    )
    .toBe(true);
  const titles = await Promise.all(hungApp.windows().map((page) => page.title()));
  const overlay = hungApp.windows()[titles.indexOf('Recovery overlay')];
  assert.ok(overlay);
  const hangStarted = Date.now();
  await overlay.bringToFront();
  await overlay.evaluate('setTimeout(() => { while (true) {} }, 0); 0');
  await expect
    .poll(
      () =>
        fs.existsSync(join(hangDirectory, 'reloads.json'))
          ? fs.readFileSync(join(hangDirectory, 'reloads.json'), 'utf8')
          : '0',
      { timeout: 45000 },
    )
    .toBe('1');
  const logs = fs
    .readdirSync(join(hangDirectory, 'logs'))
    .map((name) => fs.readFileSync(join(hangDirectory, 'logs', name), 'utf8'))
    .join('\n');
  assert.ok(logs.includes('桌面层长时间没有响应'));
  console.log(
    JSON.stringify({
      unresponsiveRecovered: true,
      elapsedMs: Date.now() - hangStarted,
      evidenceDirectory: hangDirectory,
    }),
  );
} finally {
  await hungApp.close();
}
