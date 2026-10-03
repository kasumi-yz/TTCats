import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron, expect, type ElectronApplication } from '@playwright/test';
import { build, Platform } from 'electron-builder';
import type { AppStatus, StateSnapshot } from '../src/shared/ipc';

// 只改测试构建输出：正式源码没有安装版的测试开关，也不接触真实存档。
const run = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const directory = await mkdtemp(join(tmpdir(), 'ttcats-update-'));
const data = join(directory, 'data');
const installed = join(directory, 'installed');
const feed = join(directory, 'new');
await mkdir(data);
const requests: string[] = [];
const server = createServer((request, response) => {
  void (async () => {
    const name = decodeURIComponent(
      new URL(request.url ?? '/', 'http://localhost').pathname.slice(1),
    );
    if (name !== basename(name)) {
      response.writeHead(404).end();
      return;
    }
    const file = join(feed, name);
    const info = await stat(file);
    requests.push(name);
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Number(range[2]) : info.size - 1;
    response.writeHead(range ? 206 : 200, {
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {}),
    });
    createReadStream(file, { start, end }).pipe(response);
  })().catch(() => {
    response.writeHead(404).end();
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('模拟更新服务器启动失败');
const url = `http://127.0.0.1:${address.port}`;
const mainFile = join(root, 'out/main/index.js');
const original = await readFile(mainFile, 'utf8');
let running: ElectronApplication | undefined;
const env = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);
delete env['ELECTRON_RUN_AS_NODE'];
delete env['ELECTRON_RENDERER_URL'];

async function launch(): Promise<ElectronApplication> {
  const application = await electron.launch({
    executablePath: join(installed, 'TTCatsUpdateTest.exe'),
    args: ['--settings'],
    env,
  });
  running = application;
  return application;
}
async function panel(application: ElectronApplication) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const page = application.windows().find((page) => page.url().includes('panel=settings'));
    if (page) {
      await page.waitForFunction('Boolean(window.ttcats)');
      return page;
    }
    await delay(100);
  }
  throw new Error('模拟安装版没有打开设置窗口');
}
async function waitForUpdated(): Promise<void> {
  const expected = await readFile(join(feed, 'win-unpacked/resources/app.asar'));
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      if ((await readFile(join(installed, 'resources/app.asar'))).equals(expected)) return;
    } catch {
      /* 安装器替换文件时暂时不可读。 */
    }
    await delay(500);
  }
  throw new Error('退出后两分钟内没有装好新版；检查是否有卸载弹窗或安装器卡住');
}

try {
  await writeFile(
    mainFile,
    `import { app as updateTestApp } from 'electron';\nupdateTestApp.setPath('appData', ${JSON.stringify(data)});\nupdateTestApp.setPath('userData', ${JSON.stringify(join(data, 'TTCats'))});\n${original}`,
  );
  for (const [version, output] of [
    ['0.2.9000', 'old'],
    ['0.2.9001', 'new'],
  ] as const) {
    await build({
      targets: Platform.WINDOWS.createTarget('nsis'),
      projectDir: root,
      publish: 'never',
      config: {
        extends: join(root, 'electron-builder.yml'),
        appId: 'top.ttcats.issue68.update-test',
        productName: 'TTCats Update Test',
        executableName: 'TTCatsUpdateTest',
        extraMetadata: { version },
        directories: { output: join(directory, output) },
        publish: [{ provider: 'generic', url }],
        afterPack: async (context) => {
          await writeFile(
            join(context.appOutDir, 'resources/app-update.yml'),
            `provider: generic\nurl: ${url}\nupdaterCacheDirName: ${basename(directory)}-cache\n`,
          );
        },
      },
    });
  }
  console.log(`模拟安装包已生成：${directory}`);
  await run(join(directory, 'old/TTCats-Setup-0.2.9000-x64.exe'), ['/S', `/D=${installed}`], {
    timeout: 120_000,
  });
  const old = await launch();
  const page = await panel(old);
  const initial = await page.evaluate<AppStatus>('window.ttcats.getAppStatus()');
  if (initial.version !== '0.2.9000') throw new Error('启动的不是旧版');
  await page.evaluate(
    "window.ttcats.sendCommand({type:'settings/update',patch:{scale:1.75,autoUpdate:false}})",
  );
  await expect
    .poll(async () => (await page.evaluate<StateSnapshot>('window.ttcats.getSnapshot()')).settings)
    .toMatchObject({ scale: 1.75, autoUpdate: false });
  await page.evaluate("window.ttcats.sendCommand({type:'update/check'})");
  await expect
    .poll(async () => (await page.evaluate<AppStatus>('window.ttcats.getAppStatus()')).update, {
      timeout: 120_000,
    })
    .toEqual({ state: 'downloaded', version: '0.2.9001' });
  const downloaded = await page.evaluate<AppStatus>('window.ttcats.getAppStatus()');
  if (downloaded.update.state !== 'downloaded' || downloaded.update.version !== '0.2.9001')
    throw new Error('没有下好新版');
  const exited = new Promise<void>((resolve) => old.once('close', resolve));
  await old.evaluate(({ app }) => {
    app.quit();
  });
  await exited;
  running = undefined;
  await waitForUpdated();
  // NSIS 替换 asar 后还要写注册表和快捷方式，等其完整退出再启动。
  await delay(3000);
  const newer = await launch();
  const newPage = await panel(newer);
  const status = await newPage.evaluate<AppStatus>('window.ttcats.getAppStatus()');
  const snapshot = await newPage.evaluate<StateSnapshot>('window.ttcats.getSnapshot()');
  if (
    status.version !== '0.2.9001' ||
    snapshot.settings.scale !== 1.75 ||
    snapshot.settings.autoUpdate
  )
    throw new Error('新版或保留的存档不正确');
  const result = {
    oldVersion: initial.version,
    newVersion: status.version,
    downloaded: downloaded.update,
    retainedScale: snapshot.settings.scale,
    retainedAutoUpdate: snapshot.settings.autoUpdate,
    silentInstallCompleted: true,
    requests,
    directory,
    note: '真实 NSIS 静默升级完成，未被旧版卸载确认弹窗阻塞；独立 appId、安装目录、数据目录、更新缓存。',
  };
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  try {
    await running?.close();
  } catch (error) {
    console.error('测试应用退出失败：', error);
  }
  await writeFile(mainFile, original);
  await new Promise<void>((resolve, reject) =>
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    }),
  );
  // 卸载的只是独立 appId 的测试安装，/S 不会弹窗或删除任何存档。
  try {
    await run(join(installed, 'Uninstall TTCatsUpdateTest.exe'), ['/S'], { timeout: 120_000 });
  } catch (error) {
    console.error('测试安装清理未完成，保留目录供检查：', directory, error);
  }
}
