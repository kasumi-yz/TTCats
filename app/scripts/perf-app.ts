// npm run perf:app（在 app/ 里运行，先 npm run build）：M1 整应用性能（#29）。
//
// 和 npm run perf 的区别：那个只测桌面层模块（独立的验收入口）；这个启动正式应用
// （主进程拼装、存档、托盘、真实 core/stage），用 3 只测试猫，口径和 M0-A 相同：
// 正常播放、全部隐藏、全屏时自动隐藏三种状态，各先过渡 15 秒、再测 300 秒，约每秒采样一次，
// 统计应用所有进程的 CPU（整机百分比之和）和私有内存。全屏窗口是独立进程，不计入。
// 每 15 秒检查一次独占：除了本轮启动的程序，不能有任何 Electron 或素材工厂在跑（开测前一个都不能有）。
// 目标：每种状态 CPU 平均 < 2%，私有内存峰值 < 700MB。
// 参数：--seconds=N 每种状态测多少秒（探索用，正式测量用默认 300）
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import {
  appRoot,
  displayLabel,
  exclusivity,
  launchApp,
  launchProbe,
  overlayPage,
  primaryDisplay,
  processId,
  sleep,
  waitFor,
  waitOverlayVisible,
} from './lib/desktop';

const WARMUP_SECONDS = 15;
const CPU_TARGET = 2;
const MEMORY_TARGET_MB = 700;
const seconds = Number(process.argv.find((a) => a.startsWith('--seconds='))?.slice(10) ?? 300);
if (!Number.isFinite(seconds) || seconds < 10) throw new Error('--seconds 至少 10 秒');

interface Sample {
  phase: string;
  at: number;
  overlayVisible: boolean;
  processes: { pid: number; type: string; cpu: number; privateMB: number; workingSetMB: number }[];
}

async function sample(app: ElectronApplication, phase: string): Promise<Sample> {
  const data = await app.evaluate(({ app, BrowserWindow }) => ({
    overlayVisible: BrowserWindow.getAllWindows().some(
      (w) => w.webContents.getURL().includes('/overlay/') && w.isVisible(),
    ),
    processes: app.getAppMetrics().map((p) => ({
      pid: p.pid,
      type: p.type,
      cpu: p.cpu.percentCPUUsage,
      privateKB: p.memory.privateBytes,
      workingSetKB: p.memory.workingSetSize,
    })),
  }));
  return {
    phase,
    at: Date.now(),
    overlayVisible: data.overlayVisible,
    processes: data.processes.map((p) => {
      if (p.privateKB === undefined) throw new Error('读不到私有内存（privateBytes）');
      return {
        pid: p.pid,
        type: p.type,
        cpu: p.cpu,
        privateMB: p.privateKB / 1024,
        workingSetMB: p.workingSetKB / 1024,
      };
    }),
  };
}

async function setAllVisible(overlay: Page, ids: string[], visible: boolean): Promise<void> {
  for (const cat of ids)
    await overlay.evaluate(
      `window.ttcats.sendCommand(${JSON.stringify({ type: 'cat/setVisible', cat, visible })})`,
    );
}

async function overlayVisible(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some(
      (w) => w.webContents.getURL().includes('/overlay/') && w.isVisible(),
    ),
  );
}

async function main(): Promise<void> {
  exclusivity();
  const { app } = await launchApp();
  let fullscreen: Awaited<ReturnType<typeof launchProbe>> | undefined;
  // 只放过本轮启动的被测应用和全屏窗口（以及它们的子进程）
  const ownProcesses = (): number[] => [
    processId(app),
    ...(fullscreen ? [processId(fullscreen.probe)] : []),
  ];
  try {
    const overlay = await overlayPage(app);
    await waitOverlayVisible(app);
    const ids = Object.keys(
      await overlay
        .evaluate<{ cats: Record<string, unknown> }>('window.ttcats.getContent()')
        .then((c) => c.cats),
    );
    if (ids.length !== 3) throw new Error(`应该有 3 只测试猫，实际 ${ids.length} 只`);
    const display = await primaryDisplay(app);
    const gpu = await app.evaluate(({ app }) => app.getGPUInfo('basic'));
    const versions = await app.evaluate(() => ({
      electron: process.versions.electron,
      chrome: process.versions.chrome,
    }));
    console.log(
      `显示配置 ${displayLabel(display)}；每种状态过渡 ${WARMUP_SECONDS} 秒、测量 ${seconds} 秒。测试期间请不要用电脑。`,
    );

    const samples: Sample[] = [];
    const summaries: {
      phase: string;
      samples: number;
      cpuAverage: number;
      cpuPeak: number;
      privateAverageMB: number;
      privatePeakMB: number;
      workingSetAverageMB: number;
      byType: Record<string, { cpuAverage: number; privateAverageMB: number }>;
    }[] = [];
    for (const phase of ['playing', 'hidden', 'fullscreen'] as const) {
      if (phase === 'hidden') {
        await setAllVisible(overlay, ids, false);
        if ((await waitFor(async () => !(await overlayVisible(app)), 10_000, 100)) === null)
          throw new Error('隐藏全部猫以后桌面层没有隐藏');
      }
      if (phase === 'fullscreen') {
        await setAllVisible(overlay, ids, true);
        await waitOverlayVisible(app);
        fullscreen = await launchProbe(true);
        if ((await waitFor(async () => !(await overlayVisible(app)), 10_000, 100)) === null)
          throw new Error('前台全屏窗口出现以后，桌面层没有自动隐藏');
      }
      const expectVisible = phase === 'playing';
      console.log(`阶段 ${phase}：过渡 ${WARMUP_SECONDS} 秒……`);
      await sleep(WARMUP_SECONDS * 1000);
      await sample(app, phase); // 让 CPU 统计从过渡期结束时算起
      const phaseSamples: Sample[] = [];
      const end = Date.now() + seconds * 1000;
      let lastExclusive = 0;
      while (Date.now() < end) {
        await sleep(1000);
        if (Date.now() - lastExclusive >= 15_000) {
          exclusivity(ownProcesses());
          lastExclusive = Date.now();
        }
        const line = await sample(app, phase);
        if (line.overlayVisible !== expectVisible)
          throw new Error(
            `阶段 ${phase} 中桌面层${line.overlayVisible ? '显示了' : '被隐藏了'}，测量作废（前台是否出现了全屏程序或有人动了电脑？）`,
          );
        phaseSamples.push(line);
        samples.push(line);
      }
      const cpu = phaseSamples.map((s) => s.processes.reduce((sum, p) => sum + p.cpu, 0));
      const priv = phaseSamples.map((s) => s.processes.reduce((sum, p) => sum + p.privateMB, 0));
      const ws = phaseSamples.map((s) => s.processes.reduce((sum, p) => sum + p.workingSetMB, 0));
      const avg = (values: number[]): number =>
        values.reduce((sum, value) => sum + value, 0) / values.length;
      const byType: Record<string, { cpuAverage: number; privateAverageMB: number }> = {};
      for (const type of new Set(phaseSamples.flatMap((s) => s.processes.map((p) => p.type)))) {
        const pick = (s: Sample, key: 'cpu' | 'privateMB'): number =>
          s.processes.filter((p) => p.type === type).reduce((sum, p) => sum + p[key], 0);
        byType[type] = {
          cpuAverage: avg(phaseSamples.map((s) => pick(s, 'cpu'))),
          privateAverageMB: avg(phaseSamples.map((s) => pick(s, 'privateMB'))),
        };
      }
      const summary = {
        phase,
        samples: phaseSamples.length,
        cpuAverage: avg(cpu),
        cpuPeak: Math.max(...cpu),
        privateAverageMB: avg(priv),
        privatePeakMB: Math.max(...priv),
        workingSetAverageMB: avg(ws),
        byType,
      };
      summaries.push(summary);
      console.log(
        `阶段 ${phase}：CPU 平均 ${summary.cpuAverage.toFixed(2)}%、峰值 ${summary.cpuPeak.toFixed(2)}%；` +
          `私有内存平均 ${summary.privateAverageMB.toFixed(0)}MB、峰值 ${summary.privatePeakMB.toFixed(0)}MB`,
      );
      if (fullscreen) {
        await fullscreen.probe.close();
        fullscreen = undefined;
      }
    }
    exclusivity(ownProcesses());

    const passed = summaries.every(
      (s) => s.cpuAverage < CPU_TARGET && s.privatePeakMB < MEMORY_TARGET_MB,
    );
    const dir = join(appRoot, 'out/perf-app');
    mkdirSync(dir, { recursive: true });
    const label = `${displayLabel(display)}-${Date.now()}`;
    writeFileSync(join(dir, `perf-app-raw-${label}.json`), JSON.stringify(samples));
    const file = join(dir, `perf-app-summary-${label}.json`);
    writeFileSync(
      file,
      JSON.stringify(
        {
          time: new Date().toISOString(),
          entry: '正式应用 out/main/index.js --test-content（3 只测试猫）',
          seconds,
          warmupSeconds: WARMUP_SECONDS,
          exclusive: true,
          cpuMethod:
            '所有应用进程 app.getAppMetrics() percentCPUUsage 之和（整机百分比，不再除以核心数）',
          memoryMethod: '所有应用进程 privateBytes 之和（KB / 1024）',
          targets: { cpuAverage: CPU_TARGET, privatePeakMB: MEMORY_TARGET_MB },
          passed,
          display,
          versions,
          gpu,
          summaries,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(`\n${passed ? '达标' : '没达标'}。汇总：${file}`);
    process.exitCode = passed ? 0 : 1;
  } finally {
    await fullscreen?.probe.close().catch(() => {});
    await app.close().catch(() => {});
  }
}

await main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
