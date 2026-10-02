// 独占桌面的声音空闲性能复测：先 build，再 npx tsx app/e2e/audio-perf.ts。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  appRoot,
  exclusivity,
  launchApp,
  overlayPage,
  processId,
  sleep,
  waitFor,
  waitOverlayVisible,
} from '../scripts/lib/desktop';
import type { StageDebugReport } from '../src/shared/ipc';

const seconds = Number(process.argv.find((arg) => arg.startsWith('--seconds='))?.slice(10) ?? 30);
if (!Number.isInteger(seconds) || seconds < 10) throw new Error('--seconds 至少 10 秒');
exclusivity();
const { app } = await launchApp();
try {
  const overlay = await overlayPage(app);
  await waitOverlayVisible(app);
  // 只观察正式桌面层上报；不用打开面板，以免面板重绘污染性能数据。
  await app.evaluate(({ BrowserWindow, ipcMain }) => {
    const overlay = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().includes('/overlay/'),
    );
    if (!overlay) throw new Error('找不到桌面层');
    ipcMain.on(
      'ttcats:overlay-to-main',
      (_event, message: { type: string; report?: StageDebugReport }) => {
        if (message.type === 'stageDebug')
          (globalThis as unknown as { audioPerfReport?: StageDebugReport }).audioPerfReport =
            message.report;
      },
    );
    overlay.webContents.send('ttcats:main-to-overlay', { type: 'stageDebug', enabled: true });
  });
  const report = async () => {
    const latest = await app.evaluate<StageDebugReport | undefined>('globalThis.audioPerfReport');
    return latest?.audio;
  };
  if ((await waitFor(async () => (await report())?.suspended === true, 5000)) === null)
    throw new Error('没有收到音频状态');
  const summaries = [];
  for (const phase of ['before', 'after'] as const) {
    if (phase === 'after') {
      await overlay.evaluate(
        'window.ttcats.sendCommand({type:"debug/sound",cat:"test-calm",sound:"purr"})',
      );
      if ((await waitFor(async () => ((await report())?.playing.length ?? 0) > 0, 5000)) === null)
        throw new Error('呼噜没有开始播放');
      if ((await waitFor(async () => (await report())?.suspended === true, 5000)) === null)
        throw new Error('播放完没有挂起音频');
    }
    console.log(`${phase}：预热 15 秒，采样 ${seconds} 秒`);
    await sleep(15000);
    await app.evaluate(({ app }) => app.getAppMetrics());
    const samples: number[] = [];
    for (let i = 0; i < seconds; i++) {
      await sleep(1000);
      if (i % 15 === 0) exclusivity([processId(app)]);
      const data = await app.evaluate(({ app, BrowserWindow }) => ({
        cpu: app.getAppMetrics().reduce((sum, p) => sum + p.cpu.percentCPUUsage, 0),
        visible: BrowserWindow.getAllWindows().some(
          (w) => w.webContents.getURL().includes('/overlay/') && w.isVisible(),
        ),
      }));
      if (!data.visible || !(await report())?.suspended)
        throw new Error('桌面层隐藏或音频非空闲，测量作废');
      samples.push(data.cpu);
    }
    const summary = {
      phase,
      samples,
      average: samples.reduce((a, b) => a + b, 0) / samples.length,
      peak: Math.max(...samples),
    };
    summaries.push(summary);
    console.log(JSON.stringify(summary));
  }
  exclusivity([processId(app)]);
  const directory = join(appRoot, 'out/audio-perf');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `audio-perf-${Date.now()}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      {
        time: new Date().toISOString(),
        seconds,
        exclusive: true,
        cpuMethod: 'app.getAppMetrics 整机百分比之和',
        summaries,
      },
      null,
      2,
    ),
  );
  console.log(file);
  if (summaries.some((s) => s.average >= 2)) throw new Error('CPU 平均值没有达到低于 2% 的目标');
} finally {
  await app.close();
}
