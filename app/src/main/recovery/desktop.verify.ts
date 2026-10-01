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
  await expect(notice.locator('p')).toContainText('已停用所有当前显示的猫咪包：测试猫');
  await expect(notice.locator('p')).toContainText('本次运行里桌面上的猫不会再出现');
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

// 审查发现的真实加载竞态、快速连点和超过十秒的慢资源，分别用独立实例验证。
for (const scenario of ['loading-crash', 'double-crash', 'slow-load']) {
  const directory = fs.mkdtempSync(join(tmpdir(), `ttcats-recovery-${scenario}-`));
  const application = await _electron.launch({
    args: [join(output, 'desktop.mjs')],
    env: {
      ...process.env,
      TTCATS_RECOVERY_CHECK_DIR: directory,
      TTCATS_RECOVERY_SCENARIO: scenario,
    },
  });
  try {
    await expect
      .poll(async () =>
        (await Promise.all(application.windows().map((page) => page.title()))).includes(
          'Recovery panels',
        ),
      )
      .toBe(true);
    const titles = await Promise.all(application.windows().map((page) => page.title()));
    const panels = application.windows()[titles.indexOf('Recovery panels')];
    assert.ok(panels);
    const original = fs.readFileSync(join(directory, 'save.json'), 'utf8');
    const crash = async (): Promise<void> => {
      await panels.evaluate("window.ttcats.sendCommand({type:'debug/crashOverlay'})");
    };
    const readNumber = (file: string): string =>
      fs.existsSync(join(directory, file)) ? fs.readFileSync(join(directory, file), 'utf8') : '0';
    await crash();
    if (scenario === 'loading-crash') {
      for (let attempt = 1; attempt <= 3; attempt++) {
        await expect.poll(() => readNumber('loading-started.json')).toBe(String(attempt));
        await new Promise((resolve) => setTimeout(resolve, 300));
        await crash();
      }
      await expect.poll(() => fs.existsSync(join(directory, 'safe-mode.json'))).toBe(true);
      assert.equal(readNumber('reload-attempts.json'), '3');
      const result: unknown = JSON.parse(
        fs.readFileSync(join(directory, 'safe-mode.json'), 'utf8'),
      );
      assert.ok(
        typeof result === 'object' &&
          result !== null &&
          'state' in result &&
          'disabledCats' in result,
      );
      assert.deepEqual(GameStateSchema.parse(result.state).settings.visibleCats, ['backup-cat']);
      assert.deepEqual(result.disabledCats, ['test-cat']);
      const raw: unknown = JSON.parse(fs.readFileSync(join(directory, 'timeline.json'), 'utf8'));
      assert.ok(Array.isArray(raw));
      const timeline = raw as { event: string; at: number }[];
      const reject = timeline.findIndex((item) => item.event === 'reject');
      assert.ok(
        reject >= 0 && timeline[reject + 1]?.event === 'gone',
        '真实顺序应包含先 reject 后 gone',
      );
      console.log(
        JSON.stringify({
          scenario,
          attempts: 3,
          safeMode: true,
          rejectBeforeGone: true,
          evidenceDirectory: directory,
        }),
      );
    } else if (scenario === 'double-crash') {
      await expect.poll(() => readNumber('reloads.json')).toBe('1');
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await crash();
      await expect.poll(() => readNumber('reloads.json')).toBe('2');
      console.log(
        JSON.stringify({ scenario, laterCommandRecovered: true, evidenceDirectory: directory }),
      );
    } else {
      await expect.poll(() => readNumber('reloads.json'), { timeout: 20000 }).toBe('1');
      assert.equal(readNumber('reload-attempts.json'), '1');
      assert.ok(!fs.existsSync(join(directory, 'safe-mode.json')));
      console.log(
        JSON.stringify({
          scenario,
          resourceDelayMs: 12000,
          falseCrash: false,
          evidenceDirectory: directory,
        }),
      );
    }
    assert.equal(fs.readFileSync(join(directory, 'save.json'), 'utf8'), original);
  } finally {
    await application.close();
  }
}
