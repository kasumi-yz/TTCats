// npm run perf：性能测试。
//
// 用 app.getAppMetrics() 统计桌面层程序的所有进程（主进程、GPU 进程、渲染进程、工具进程）的 CPU 和内存，
// 用 Windows 性能计数器 GPU Engine 统计这些进程的 GPU 占用。分三种状态各测一段时间：
//   playing     正常播放（三只猫，平常的姿势变化）
//   hidden      全部隐藏（用户隐藏了所有猫）
//   fullscreen  全屏时自动隐藏（打开一个全屏窗口，由 SHQueryUserNotificationState 检测到后自动隐藏）
//
// 参数：--minutes=5  每种状态测几分钟
//       --phases=playing,hidden,fullscreen
//       --gpu=low-power|default   low-power = 强制用核显（默认）；default = Electron 默认选择（这台笔记本上是独显）
//       --preload=all|lazy   片段预加载方式（默认 all）
//       --fps=N        画面最高刷新率（默认不限）
//       --res=N        画布分辨率倍数（默认跟系统缩放一致）
//       --bare         只开空白透明窗口，测 Electron 本身的基线开销
//       --label=文字   结果目录名里带上
//
// ⚠ 跑之前请确认：同一台电脑上没有别的会话在运行 Electron 程序或素材工厂；全屏阶段会有一个纯色窗口盖住整个屏幕。

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import type { LogEvent, OverlayState } from '../shared/protocol';
import { mouseButton, mouseMove, setDpiAware } from '../shared/win32';
import { launch, RESULTS, ROOT, sleep, waitFor, type Launched } from './common';

const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

interface MetricLine {
  t: number;
  phase: string;
  visible: boolean;
  procs: { pid: number; type: string; name?: string; cpu: number; ws: number; priv?: number }[];
}
interface GpuSample {
  t: number;
  pid: number;
  luid: string;
  eng: string;
  util: number;
}

const WARMUP_MS = 15000; // 每个阶段开头 15 秒不计入（切换状态的过渡期）

/** 在后台每秒采一次 GPU Engine 计数器（用 CIM 类名，和系统语言无关） */
function startGpuSampler(pids: number[], outFile: string): () => void {
  const pattern = pids.map((p) => `pid_${p}_`).join('|');
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
while ($true) {
  $t = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
  Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine |
    Where-Object { $_.Name -match '${pattern}' } |
    ForEach-Object { "$t|$($_.Name)|$($_.UtilizationPercentage)" }
  Start-Sleep -Milliseconds 1000
}`;
  const proc = spawn('powershell', ['-NoProfile', '-Command', ps], { stdio: ['ignore', 'pipe', 'ignore'] });
  const lines: string[] = [];
  proc.stdout.on('data', (d: Buffer) => lines.push(d.toString()));
  return () => {
    proc.kill();
    const samples: GpuSample[] = [];
    for (const l of lines.join('').split(/\r?\n/)) {
      const m = /^(\d+)\|pid_(\d+)_luid_(0x[0-9a-fA-F]+_0x[0-9a-fA-F]+)_phys_\d+_eng_\d+_engtype_([^|]*)\|(\d+)/.exec(l);
      if (m) samples.push({ t: +m[1], pid: +m[2], luid: m[3], eng: m[4] || 'unknown', util: +m[5] });
    }
    writeFileSync(outFile, samples.map((s) => JSON.stringify(s)).join('\n'));
  };
}

function otherElectronProcesses(ourPids: number[]): { name: string; count: number }[] {
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', 'Get-Process | Where-Object { $_.Path -and (Test-Path (Join-Path (Split-Path $_.Path) "resources.pak")) } | ForEach-Object { "$($_.Id)|$($_.Name)" }'],
      { encoding: 'utf8' },
    );
    const counts = new Map<string, number>();
    for (const l of out.split(/\r?\n/).filter(Boolean)) {
      const [pid, name] = l.split('|');
      if (ourPids.includes(Number(pid))) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts].map(([name, count]) => ({ name, count }));
  } catch {
    return [];
  }
}

/**
 * 独占检查：别的 electron.exe（其他会话的 Electron 程序）或素材工厂（python/ComfyUI）是否在跑。
 * 按可执行文件路径区分：本工程目录下的 electron.exe（桌面层和全屏测试窗口，包括它们后来才启动的子进程）不算。
 * 返回 "程序路径" 列表。
 */
function exclusivityCheck(): string[] {
  const ours = ROOT.toLowerCase();
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(electron|python|pythonw|ComfyUI)\\.exe$' } | ForEach-Object { $_.ExecutablePath }",
      ],
      { encoding: 'utf8' },
    );
    return [
      ...new Set(
        out
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && !l.toLowerCase().startsWith(ours)),
      ),
    ];
  } catch {
    return [];
  }
}

const avg = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const max = (a: number[]): number => (a.length ? Math.max(...a) : 0);
const r1 = (v: number): number => Math.round(v * 10) / 10;

async function main(): Promise<void> {
  setDpiAware();
  const minutes = Number(arg('minutes') ?? 5);
  const phases = (arg('phases') ?? 'playing,hidden,fullscreen').split(',');
  const gpu = arg('gpu') ?? 'low-power';
  const preload = arg('preload') ?? 'all';
  const fps = Number(arg('fps') ?? 0);
  const res = Number(arg('res') ?? 0);
  const dir = join(RESULTS, `perf-${gpu}-${preload}-fps${fps}-res${res}-${arg('label') ?? ''}${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const metricsFile = join(dir, 'metrics.jsonl');

  const ov = await launch('main.js', ['--layout=normal', '--no-hud', `--gpu=${gpu}`, `--preload=${preload}`, `--fps=${fps}`, `--res=${res}`, `--metrics-out=${metricsFile}`, ...(process.argv.includes('--bare') ? ['--bare'] : [])], '桌面层');
  let probe: Launched | null = null;
  const phaseTimes: { phase: string; start: number; end: number; note?: string }[] = [];
  let stopGpu: (() => void) | null = null;
  let stopExcl: (() => void) | null = null;
  let intrudersList: string[] = [];
  try {
    if (!process.argv.includes('--bare')) await waitFor(async () => (await ov.get<OverlayState>('/state')).cats.length === 3, 15000, 100);
    await sleep(3000);
    const gpuInfo = await ov.get<{
      info: { gpuDevice: { active: boolean; deviceString?: string; vendorId: number }[]; auxAttributes?: { glRenderer?: string } };
      versions: Record<string, string>;
    }>('/gpu');
    const firstLines = readFileSync(metricsFile, 'utf8').trim().split('\n');
    const pids = (JSON.parse(firstLines[firstLines.length - 1]) as MetricLine).procs.map((p) => p.pid);
    const others = otherElectronProcesses(pids);
    console.log(`显卡：${gpuInfo.info.auxAttributes?.glRenderer}`);
    console.log(`同时在运行的其他 Electron 类程序：${others.map((o) => `${o.name}×${o.count}`).join('，') || '无'}`);
    stopGpu = startGpuSampler(pids, join(dir, 'gpu.jsonl'));
    const intruders = new Set<string>(exclusivityCheck());
    const excl = setInterval(() => {
      for (const l of exclusivityCheck()) intruders.add(l);
    }, 15000);
    stopExcl = () => clearInterval(excl);

    for (const phase of phases) {
      let note: string | undefined;
      if (phase === 'hidden') await ov.cmd({ type: 'hide', on: true });
      if (phase === 'fullscreen') {
        probe = await launch('probe-main.js', ['--fullscreen', '--color=#20242a', '--title=全屏测试窗口'], '全屏窗口');
        const fsReady = await waitFor(async () => (await probe!.get<{ fullscreen: boolean }>('/state')).fullscreen, 5000, 100);
        await sleep(1000);
        if (fsReady !== null) {
          // 点一下全屏窗口，让它成为前台窗口（全屏检测只看前台窗口）。确认它已经铺满屏幕才点，免得点到别的程序
          const st = await ov.get<OverlayState>('/state');
          mouseMove(Math.round(st.workArea.width * st.scaleFactor * 0.5), Math.round(st.workArea.height * st.scaleFactor * 0.5));
          mouseButton(true);
          mouseButton(false);
        }
        const t = await waitFor(async () => (await ov.get<OverlayState>('/state')).fullscreenHidden, 5000, 100);
        const s = await ov.get<OverlayState>('/state');
        note = t === null ? '⚠ 没有检测到全屏' : `检测到全屏（状态码 ${s.notificationState}），${t}ms 后桌面层自动隐藏，visible=${s.visible}`;
        console.log(note);
      }
      await ov.cmd({ type: 'phase', phase });
      const start = Date.now();
      console.log(`[${new Date().toLocaleTimeString()}] 阶段 ${phase}：测 ${minutes} 分钟`);
      await sleep(minutes * 60000);
      phaseTimes.push({ phase, start, end: Date.now(), note });
      if (phase === 'hidden') await ov.cmd({ type: 'hide', on: false });
      if (phase === 'fullscreen' && probe) {
        await probe.kill();
        probe = null;
        const t = await waitFor(async () => (await ov.get<OverlayState>('/state')).visible, 5000, 100);
        phaseTimes[phaseTimes.length - 1].note += `；关掉全屏窗口后 ${t}ms 桌面层恢复显示`;
      }
      await sleep(2500); // 等恢复显示后渲染进程报告"隐藏期间计时器跑了多少次"
    }
    stopExcl?.();
    intrudersList = [...intruders];
    const events = await ov.get<LogEvent[]>('/events?since=0');
    writeFileSync(join(dir, 'events.json'), JSON.stringify(events));
    stopGpu();
    stopGpu = null;

    // ---- 汇总 ----
    const lines = readFileSync(metricsFile, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as MetricLine);
    const gpuSamples = readFileSync(join(dir, 'gpu.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as GpuSample);
    const nCpu = cpus().length;
    const summary = phaseTimes.map(({ phase, start, end, note }) => {
      const ls = lines.filter((l) => l.t >= start + WARMUP_MS && l.t <= end);
      const cpu = ls.map((l) => l.procs.reduce((s, p) => s + p.cpu, 0));
      const ws = ls.map((l) => l.procs.reduce((s, p) => s + p.ws, 0) / 1024);
      const priv = ls.map((l) => l.procs.reduce((s, p) => s + (p.priv ?? 0), 0) / 1024);
      const byType: Record<string, { cpuAvg: number; wsAvgMB: number }> = {};
      for (const type of [...new Set(ls.flatMap((l) => l.procs.map((p) => p.type)))]) {
        byType[type] = {
          cpuAvg: r1(avg(ls.map((l) => l.procs.filter((p) => p.type === type).reduce((s, p) => s + p.cpu, 0)))),
          wsAvgMB: r1(avg(ls.map((l) => l.procs.filter((p) => p.type === type).reduce((s, p) => s + p.ws, 0) / 1024))),
        };
      }
      // GPU：同一时刻、同一块显卡、同一种引擎，把各进程加起来；再按显卡+引擎统计平均和峰值
      const gs = gpuSamples.filter((g) => g.t >= start + WARMUP_MS && g.t <= end);
      const buckets = new Map<string, Map<number, number>>();
      for (const g of gs) {
        const k = `${g.luid} ${g.eng}`;
        const byT = buckets.get(k) ?? new Map<number, number>();
        byT.set(g.t, (byT.get(g.t) ?? 0) + g.util);
        buckets.set(k, byT);
      }
      const gpuByEngine = [...buckets].map(([k, byT]) => ({ engine: k, avg: r1(avg([...byT.values()])), max: max([...byT.values()]) }));
      return {
        phase,
        note,
        samples: ls.length,
        cpuOneCoreAvg: r1(avg(cpu)),
        cpuOneCoreMax: r1(max(cpu)),
        cpuMachineAvg: r1(avg(cpu) / nCpu),
        cpuMachineMax: r1(max(cpu) / nCpu),
        workingSetAvgMB: r1(avg(ws)),
        workingSetMaxMB: r1(max(ws)),
        privateAvgMB: r1(avg(priv)),
        privateMaxMB: r1(max(priv)),
        byType,
        gpuByEngine: gpuByEngine.filter((g) => g.max > 0 || /3D|VideoDecode/.test(g.engine)),
      };
    });
    const timing = events.filter((e) => e.type === 'hiddenReport');
    const result = {
      time: new Date().toISOString(),
      minutesPerPhase: minutes,
      warmupExcludedMs: WARMUP_MS,
      gpuMode: gpu,
      preload,
      fpsCap: fps,
      resolution: res || '系统缩放',
      glRenderer: gpuInfo.info.auxAttributes?.glRenderer,
      activeGpu: gpuInfo.info.gpuDevice.find((d) => d.active)?.deviceString,
      versions: { electron: gpuInfo.versions.electron, chrome: gpuInfo.versions.chrome, node: gpuInfo.versions.node },
      cpuCount: nCpu,
      otherElectronApps: others,
      exclusivity: { ok: intrudersList.length === 0, seen: intrudersList },
      phases: summary,
      timing,
      switchStats: (await ov.get<OverlayState>('/state')).switchStats,
    };
    writeFileSync(join(dir, 'summary.json'), JSON.stringify(result, null, 2));

    console.log(`\n显卡：${result.glRenderer}\n`);
    console.log('| 状态 | CPU 平均（整机%） | CPU 峰值（整机%） | CPU 平均（单核%） | 内存 工作集 平均/峰值（MB） | 私有内存 平均/峰值（MB） |');
    console.log('|---|---|---|---|---|---|');
    for (const s of summary) {
      console.log(
        `| ${s.phase} | ${s.cpuMachineAvg} | ${s.cpuMachineMax} | ${s.cpuOneCoreAvg} | ${s.workingSetAvgMB} / ${s.workingSetMaxMB} | ${s.privateAvgMB} / ${s.privateMaxMB} |`,
      );
    }
    for (const s of summary) console.log(`${s.phase} GPU：${s.gpuByEngine.map((g) => `${g.engine} 平均${g.avg}% 峰值${g.max}%`).join('；') || '无'}`);
    for (const t of timing) console.log(`隐藏计时：${JSON.stringify(t)}`);
    console.log(
      intrudersList.length
        ? `⚠ 独占检查不通过：测试期间看到 ${intrudersList.join('，')}`
        : '独占检查通过：测试期间没有其他 electron.exe 或素材工厂（python/ComfyUI）在运行',
    );
    console.log(`\n结果目录：${dir}`);
  } finally {
    stopExcl?.();
    stopGpu?.();
    await probe?.kill();
    await ov.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
