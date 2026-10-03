// 预检不独占、不移动用户窗口；完整一轮和台式机两种配置分别按用户约定取得许可。
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { hostname, cpus } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { app, nativeImage, screen } from 'electron';
import type { WindowInfo, WindowRect } from '../src/main/platform/types';
import type { Ledges } from '../src/shared/core-api';
import { readWindows } from '../src/main/platform/win/windows';
import { captionButtonsMatch, titlebarButtons } from '../src/main/platform/win/window-geometry';
import { createWindowLedgeTest } from '../src/main/platform/win/test-window-ledges';
import { computeLedges } from '../src/main/window-ledges/compute';
import {
  createWindowLedgeTracker,
  WINDOW_LEDGE_ACTIVE_MS,
  WINDOW_LEDGE_IDLE_MS,
  type WindowLedgeUpdate,
} from '../src/main/window-ledges/tracker';
import { exclusivity, sleep } from './lib/desktop';
import {
  captionCaptureMethod,
  createCheckLog,
  errorDetails,
  movementProbe,
  type CheckResult,
} from './window-ledges-checks';
import { createLegacyWindow } from './legacy-window-fixture';

const args = process.argv;
const preflight = args.includes('--preflight');
const inspect = args.includes('--inspect');
const approved = args.includes('--approved');
const desktopBatch = args.includes('--desktop-batch');
const legacyId = args.find((a) => a.startsWith('--legacy='))?.slice(9);
const output =
  args.find((a) => a.startsWith('--output='))?.slice(9) ??
  join(import.meta.dirname, '../out/window-ledges');
const samplingPlan = {
  strategy: '定时读取；设定延时不代表实际采样间隔',
  activeDelayMs: WINDOW_LEDGE_ACTIVE_MS,
  idleDelayMs: WINDOW_LEDGE_IDLE_MS,
  warmupMs: 1000,
  cpuDurationMs: 30000,
  movementSamples: 20,
  movementSettleMs: 80,
  movementTimeoutMs: 500,
  latencyMethod: '移动命令前到 onUpdate 回调到达的单调时钟差；不轮询，不含 IPC 或屏幕呈现',
};
type NativeTest = ReturnType<typeof createWindowLedgeTest>;
type UiaCaption = {
  valid: boolean;
  errors: string[];
  buttons: (WindowRect & { kind: string; frameworkId: string })[];
  canMinimize: boolean | null;
  canMaximize: boolean | null;
  root: { offscreen: boolean; frameworkId: string };
};
type AppRecord = {
  name: string;
  original?: WindowInfo;
  window?: WindowInfo;
  checks: CheckResult[];
  caption: Record<string, unknown>;
  movementToUpdateMs: number[];
  movementErrors: unknown[];
  observedSampleIntervalsMs: number[];
  occlusion?: unknown;
  crossing?: Ledges[];
  capabilities?: { canMinimize: boolean; canMaximize: boolean };
};

function physical(rect: Electron.Rectangle): WindowRect {
  const r = screen.dipToScreenRect(null, rect);
  return { left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height };
}
function configuration() {
  const primary = screen.getPrimaryDisplay();
  const displays = screen.getAllDisplays().map((d) => ({
    id: d.id,
    bounds: physical(d.bounds),
    workArea: physical(d.workArea),
    scaleFactor: d.scaleFactor,
    primary: d.id === primary.id,
  }));
  const bounds = physical(primary.bounds);
  return {
    displays,
    scale: primary.scaleFactor,
    ledgeScreen: { workArea: physical(primary.workArea), scaleFactor: primary.scaleFactor },
    label: `${bounds.right - bounds.left}x${bounds.bottom - bounds.top}-${Math.round(primary.scaleFactor * 100)}pct`,
    read: () => readWindows(displays, []),
  };
}
async function powershell(file: string, parameters: string[]): Promise<unknown> {
  const { stdout } = await promisify(execFile)(
    'powershell',
    ['-NoProfile', '-File', join(import.meta.dirname, file), ...parameters],
    { encoding: 'utf8', timeout: 20000, maxBuffer: 4 * 1024 * 1024 },
  );
  return JSON.parse(stdout.trim()) as unknown;
}
async function targets(windows: WindowInfo[]): Promise<[string, WindowInfo | undefined][]> {
  const { stdout } = await promisify(execFile)(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,Name | ConvertTo-Json -Compress',
    ],
    { encoding: 'utf8', timeout: 20000 },
  );
  const rows = JSON.parse(stdout) as { ProcessId: number; Name: string }[];
  const names = new Map(rows.map((p) => [p.ProcessId, p.Name]));
  const choose = (matches: (w: WindowInfo) => boolean): WindowInfo | undefined => {
    const candidates = windows.filter(matches);
    return (
      candidates.find((w) => w.visible && !w.minimized && !w.maximized && !w.cloaked) ??
      candidates[0]
    );
  };
  return [
    ['记事本', choose((w) => w.className === 'Notepad')],
    [
      '浏览器',
      choose(
        (w) =>
          ['Chrome_WidgetWin_1', 'MozillaWindowClass'].includes(w.className) &&
          /^(chrome|msedge|firefox|brave|vivaldi|opera)\.exe$/i.test(names.get(w.pid) ?? ''),
      ),
    ],
    ['资源管理器', choose((w) => w.className === 'CabinetWClass')],
    [
      'DPI 不感知老程序',
      windows.find((w) =>
        legacyId
          ? w.id === legacyId
          : w.dpiAwareness === 'unaware' &&
            w.className !== 'STATIC' &&
            ['', 'invisible', 'minimized', 'maximized', 'buttons-unavailable'].includes(w.reason),
      ),
    ],
  ];
}
function union(buttons: WindowRect[]): WindowRect {
  return {
    left: Math.min(...buttons.map((b) => b.left)),
    right: Math.max(...buttons.map((b) => b.right)),
    top: Math.min(...buttons.map((b) => b.top)),
    bottom: Math.max(...buttons.map((b) => b.bottom)),
  };
}
function monitorScale(window: WindowInfo, config: ReturnType<typeof configuration>): number {
  const overlap = (bounds: WindowRect): number =>
    Math.max(
      0,
      Math.min(bounds.right, window.bounds.right) - Math.max(bounds.left, window.bounds.left),
    ) *
    Math.max(
      0,
      Math.min(bounds.bottom, window.bounds.bottom) - Math.max(bounds.top, window.bounds.top),
    );
  return config.displays.reduce((best, d) => (overlap(d.bounds) > overlap(best.bounds) ? d : best))
    .scaleFactor;
}

async function caption(
  record: AppRecord,
  window: WindowInfo,
  native: NativeTest,
  config: ReturnType<typeof configuration>,
  isPreflight: boolean,
): Promise<void> {
  const data = record.caption;
  const outer = native.outer(window.id);
  const scale = monitorScale(window, config);
  data.predicted = window.buttons;
  data.formalWindow = window;
  let predicted = window.buttons;
  // 隐藏/最小化窗口在正式列表中故意不给可站顶边。预检只调用同一纯函数读按钮，不改变状态。
  try {
    const titlebar = native.titlebar(window.id);
    data.titlebar = titlebar;
    data.titlebarPrediction = titlebarButtons(titlebar.rgrect, titlebar.rgstate, outer);
  } catch (error) {
    data.titlebarError = errorDetails(error);
    data.titlebarPrediction = null;
  }
  if (!predicted && isPreflight) {
    predicted = data.titlebarPrediction as WindowRect | null;
    data.predictionSource = '非站立窗口的同一 titlebarButtons 纯函数；不是可站顶边';
  } else data.predictionSource = 'readWindows';
  const references: { source: string; bounds: WindowRect }[] = [];
  try {
    const uia = (await powershell('verify-window-caption.ps1', [
      '-WindowHandle',
      window.id,
    ])) as UiaCaption;
    data.uia = uia;
    if (uia.valid && uia.buttons.length)
      references.push({ source: 'UI Automation', bounds: union(uia.buttons) });
    else data.uiaError = uia.errors;
  } catch (error) {
    data.uiaError = errorDetails(error);
  }
  try {
    const bounds = native.captionBounds(window.id, scale);
    data.hitInputCoordinates = 'physical';
    data.hitBounds = bounds;
    references.push({ source: 'WM_NCHITTEST 扫描', bounds });
  } catch (error) {
    data.hitError = errorDetails(error);
  }
  data.comparisons = references.map((ref) => ({
    ...ref,
    horizontalMatch: captionButtonsMatch(predicted, ref.bounds),
    topDifference: predicted ? predicted.top - ref.bounds.top : null,
    bottomDifference: predicted ? predicted.bottom - ref.bounds.bottom : null,
  }));
  const bounds = references[0]?.bounds ?? predicted;
  const crop = bounds
    ? {
        left: Math.max(bounds.left - Math.round(16 * scale), window.bounds.left),
        top: Math.max(Math.min(bounds.top, predicted?.top ?? bounds.top) - 2, window.bounds.top),
        right: Math.min(bounds.right + Math.round(16 * scale), window.bounds.right),
        bottom: Math.min(
          Math.max(bounds.bottom, predicted?.bottom ?? bounds.bottom) + 2,
          window.bounds.bottom,
        ),
      }
    : outer;
  data.captureMethod = captionCaptureMethod(window, scale);
  // 预检只验证原生截图路径选择，绝不从用户桌面取图或移动窗口。
  const parameters = [
    '-WindowHandle',
    window.id,
    '-Left',
    String(Math.round(crop.left)),
    '-Top',
    String(Math.round(crop.top)),
    '-Right',
    String(Math.round(crop.right)),
    '-Bottom',
    String(Math.round(crop.bottom)),
    '-MonitorDpi',
    String(Math.round(96 * scale)),
  ];
  let captureError: unknown;
  try {
    if (isPreflight) {
      const plan = (await powershell('capture-window-caption.ps1', [
        ...parameters,
        '-PlanOnly',
      ])) as { method: string };
      data.capturePlan = plan;
      if (plan.method !== data.captureMethod) throw new Error('原生截图路径与 DPI 策略不一致。');
    } else {
      const screenshot = `caption-${config.label}-${window.id}-${Date.now()}.png`;
      data.screenshot = screenshot;
      const capture = (await powershell('capture-window-caption.ps1', [
        ...parameters,
        '-OutputPath',
        join(output, screenshot),
      ])) as { width: number; height: number; method: string };
      data.capture = capture;
      if (capture.method !== data.captureMethod) throw new Error('实际截图方式与 DPI 策略不一致。');
      const image = nativeImage.createFromPath(join(output, screenshot));
      if (
        image.isEmpty() ||
        image.getSize().width !== capture.width ||
        image.getSize().height !== capture.height
      )
        throw new Error('按钮截图物理尺寸无效。');
      const pixels = image.toBitmap();
      if (!pixels.some((value, i) => value !== pixels[i % 4]))
        throw new Error('按钮截图是纯色，不能作为独立视觉证据。');
    }
  } catch (error) {
    captureError = error;
    data.captureError = errorDetails(error);
  }
  const errors: unknown[] = [];
  if (isPreflight && window.minimized)
    errors.push(new Error('目标窗口仍最小化，需普通显示才能预检真实按钮。'));
  if (!references.length) errors.push(new Error('UIA 和命中扫描均无有效参考。'));
  if (!predicted) errors.push(new Error('正式按钮算法没有有效矩形。'));
  for (const ref of references)
    if (!captionButtonsMatch(predicted, ref.bounds))
      errors.push(
        new Error(
          `按钮横向范围与 ${ref.source} 不一致：${JSON.stringify({ predicted, reference: ref.bounds })}`,
        ),
      );
  if (captureError) errors.push(captureError);
  if (errors.length) throw new AggregateError(errors, `${record.name}按钮核对失败。`);
}

async function runConfiguration(isPreflight: boolean): Promise<boolean> {
  const config = configuration();
  mkdirSync(output, { recursive: true });
  const file = join(
    output,
    `${isPreflight ? 'preflight' : 'verify'}-${config.label}-${Date.now()}.json`,
  );
  const result = {
    status: 'running',
    kind: isPreflight ? 'preflight' : 'full',
    machine: hostname(),
    capturedAt: new Date().toISOString(),
    label: config.label,
    displays: config.displays,
    samplingPlan,
    versions: process.versions,
    checks: [] as CheckResult[],
    apps: [] as AppRecord[],
    phases: [] as Record<string, unknown>[],
    completedAppChecks: [] as string[],
    failures: [] as unknown[],
    cpuMethod: '核对进程累计 CPU，列单核和整机百分比；不是完整应用性能',
  };
  const save = (): void => {
    writeFileSync(file, JSON.stringify(result, null, 2));
  };
  const log = createCheckLog(save);
  result.checks = log.entries;
  save();
  let native: NativeTest | undefined;
  let closeLegacy: (() => Promise<void>) | undefined;
  let tracker: ReturnType<typeof createWindowLedgeTracker> | undefined;
  const probe = movementProbe();
  let latest: WindowLedgeUpdate | undefined;
  const finish = (): boolean => {
    result.failures = [
      ...result.checks.filter((c) => c.status === 'failed').map((c) => ({ scope: '全局', ...c })),
      ...result.apps.flatMap((a) =>
        a.checks.filter((c) => c.status === 'failed').map((c) => ({ scope: a.name, ...c })),
      ),
    ];
    result.status = result.failures.length ? 'failed' : 'passed';
    save();
    console.log(`${isPreflight ? '预检' : '完整核对'} ${result.status}：${file}`);
    return result.status === 'passed';
  };
  try {
    // 独占失败禁止开始实测，但仍写出失败 JSON。普通项目失败不阻断其他项目。
    if (!isPreflight) {
      await log.run('独占检查', () => {
        exclusivity([process.pid]);
      });
      if (result.checks.some((c) => c.status === 'failed')) return finish();
    }
    native = createWindowLedgeTest();
    const testApi = native;
    let selected: [string, WindowInfo | undefined][] = [];
    await log.run('读取四类目标', async () => {
      selected = await targets(config.read());
    });
    if (!selected.length)
      selected = ['记事本', '浏览器', '资源管理器', 'DPI 不感知老程序'].map((name) => [
        name,
        undefined,
      ]);
    const x = Math.round(config.ledgeScreen.workArea.left + 120 * config.scale);
    const y = Math.round(config.ledgeScreen.workArea.top + 240 * config.scale);

    // CPU 位于所有应用移动/按钮核对之前，三个阶段互相独立。
    if (!isPreflight) {
      let cpuFixture: string | undefined;
      await log.run('CPU 测试窗口', () => {
        cpuFixture = testApi.fixture('TTCats M4 CPU', false, 0, {
          left: x,
          top: y,
          width: Math.round(800 * config.scale),
          height: Math.round(400 * config.scale),
        });
        testApi.prepare(cpuFixture).raise();
      });
      for (const [phase, mode, occupied] of [
        ['floor', false, false],
        ['idle', true, false],
        ['occupied', true, true],
      ] as const) {
        const data: Record<string, unknown> = { phase };
        result.phases.push(data);
        await log.run(`CPU ${phase}`, async () => {
          console.log(`开始 ${phase}：预热 1 秒、采样 30 秒。`);
          const timestamps: number[] = [],
            queryErrors: unknown[] = [];
          let started = Infinity;
          tracker = createWindowLedgeTracker({
            readWindows: config.read,
            screen: () => config.ledgeScreen,
            onUpdate: () => {
              const at = performance.now();
              if (at >= started) timestamps.push(at);
            },
            onError: (error) => queryErrors.push(errorDetails(error)),
          });
          try {
            tracker.setMode(mode, occupied);
            await sleep(samplingPlan.warmupMs);
            exclusivity([process.pid]);
            const usedBefore = process.cpuUsage();
            started = performance.now();
            await sleep(samplingPlan.cpuDurationMs);
            const elapsedMs = performance.now() - started,
              used = process.cpuUsage(usedBefore);
            const cpuMachinePercent = (used.user + used.system) / (elapsedMs * 10 * cpus().length);
            Object.assign(data, {
              samples: timestamps.length,
              elapsedMs,
              cpuMicroseconds: used.user + used.system,
              cpuOneCorePercent: (used.user + used.system) / (elapsedMs * 10),
              cpuMachinePercent,
              queryErrors,
              actualSampleIntervalsMs: timestamps
                .slice(1)
                .map((at, i) => at - (timestamps[i] ?? at)),
            });
            exclusivity([process.pid]);
            const fixture = config.read().find((w) => w.id === cpuFixture);
            if (!fixture?.eligible) throw new Error('CPU 阶段缺少可站立测试窗口，数据不能验收。');
            if (queryErrors.length) throw new Error('CPU 阶段窗口查询失败，见原始记录。');
            if (cpuMachinePercent >= 2)
              throw new Error(`CPU ${phase} 为 ${cpuMachinePercent.toFixed(2)}%，超过 2%。`);
            console.log(`${phase} CPU：${cpuMachinePercent.toFixed(3)}%。`);
          } finally {
            tracker.dispose();
            tracker = undefined;
          }
        });
      }
      const finishedCpuFixture = cpuFixture;
      if (finishedCpuFixture)
        await log.run('关闭 CPU 测试窗口', () => {
          testApi.closeFixture(finishedCpuFixture);
        });
    }

    let legacy = '';
    await log.run('创建独立 Legacy 回归窗口', async () => {
      const initial = isPreflight
        ? {
            left: Math.max(...config.displays.map((d) => d.bounds.right)) + 2000,
            top: Math.max(...config.displays.map((d) => d.bounds.bottom)) + 2000,
            width: 600,
            height: 400,
          }
        : { left: x, top: y, width: 600, height: 400 };
      const created = await createLegacyWindow(initial.left, initial.top);
      legacy = created.id;
      closeLegacy = created.close;
      if (isPreflight) {
        const rect = testApi.outer(legacy);
        if (
          config.displays.some(
            (d) =>
              rect.left < d.bounds.right &&
              rect.right > d.bounds.left &&
              rect.top < d.bounds.bottom &&
              rect.bottom > d.bounds.top,
          )
        )
          throw new Error('预检回归窗口未处于屏幕外。');
      }
    });
    let legacyWindow: WindowInfo | undefined;
    await log.run('读取独立 Legacy 回归窗口', () => {
      legacyWindow = config.read().find((w) => w.id === legacy);
      if (!legacyWindow) throw new Error('正式列表未读到独立 Legacy 回归窗口。');
    });
    selected.push(['独立 Legacy 回归窗口', legacyWindow]);
    let cover = '';
    if (!isPreflight) {
      await log.run('创建遮挡窗口', () => {
        cover = testApi.fixture('TTCats M4 Occluder');
        testApi.prepare(cover).hide();
      });
    }
    for (const [name, window] of selected) {
      const record: AppRecord = {
        name,
        original: window,
        checks: [],
        caption: {},
        movementToUpdateMs: [],
        movementErrors: [],
        observedSampleIntervalsMs: [],
      };
      result.apps.push(record);
      const checks = createCheckLog(save);
      record.checks = checks.entries;
      await checks.run('目标存在及 DPI', () => {
        if (!window) throw new Error(`未找到${name}；不跳过此失败。`);
        if (name === 'DPI 不感知老程序' && window.dpiAwareness !== 'unaware')
          throw new Error('指定的老程序并非 DPI 不感知。');
      });
      if (!window) {
        result.completedAppChecks.push(name);
        console.log(`${name}：目标缺失已记录，继续。`);
        save();
        continue;
      }
      if (isPreflight) {
        await checks.run('只读按钮与截图路径', async () => {
          const current = config.read().find((w) => w.id === window.id);
          if (!current) throw new Error('窗口在只读核对前关闭。');
          record.window = current;
          record.capabilities = testApi.capabilities(window.id);
          await caption(record, current, testApi, config, true);
        });
      } else {
        let placement: ReturnType<NativeTest['prepare']> | undefined;
        await checks.run('保存并准备窗口', async () => {
          placement = testApi.prepare(window.id);
          placement.move(x, y, Math.round(800 * config.scale), Math.round(400 * config.scale));
          placement.raise();
          await sleep(250);
          record.window = config.read().find((w) => w.id === window.id);
          record.capabilities = testApi.capabilities(window.id);
          if (!record.window?.eligible) throw new Error('恢复后没有可靠可站顶边。');
        });
        if (placement) {
          const test = placement;
          try {
            await checks.run('按钮参考及实际图像', async () => {
              const current = config.read().find((w) => w.id === window.id);
              if (!current) throw new Error('窗口在按钮核对前关闭。');
              await caption(record, current, testApi, config, false);
            });
            await checks.run('20 次移动回调延迟', async () => {
              const sampleIntervals: number[] = [];
              let previousAt: number | undefined;
              const motionTracker = createWindowLedgeTracker({
                readWindows: config.read,
                screen: () => config.ledgeScreen,
                onUpdate: (update) => {
                  const at = performance.now();
                  if (previousAt !== undefined) sampleIntervals.push(at - previousAt);
                  previousAt = at;
                  probe.update(update);
                },
                onError: (error) => record.movementErrors.push(errorDetails(error)),
              });
              try {
                motionTracker.setMode(true, true);
                for (let i = 0; i < samplingPlan.movementSamples; i++) {
                  try {
                    record.movementToUpdateMs.push(
                      await probe.move(window.id, () => {
                        test.move(Math.round(x + (i % 2 ? 20 : 80) * config.scale), y + 30);
                      }),
                    );
                  } catch (error) {
                    record.movementErrors.push({ sample: i, error: errorDetails(error) });
                  }
                  await sleep(samplingPlan.movementSettleMs);
                }
              } finally {
                motionTracker.dispose();
                record.observedSampleIntervalsMs = sampleIntervals;
              }
              if (record.movementErrors.length)
                throw new Error('移动测量有失败，见每个样本及查询错误。');
            });
            await checks.run('局部遮挡', async () => {
              const b = config.read().find((w) => w.id === window.id);
              if (
                !b ||
                !computeLedges(config.read(), config.ledgeScreen).some(
                  (l) => l.id === b.id && l.segments.length,
                )
              )
                throw new Error('遮挡前没有可见顶边，不能以空线段验收。');
              const coverPlacement = testApi.prepare(cover);
              try {
                coverPlacement.move(
                  Math.round(b.bounds.left + 150 * config.scale),
                  Math.round(b.bounds.top - 100 * config.scale),
                  Math.round(200 * config.scale),
                  Math.round(200 * config.scale),
                );
                coverPlacement.raise();
                await sleep(150);
                const windows = config.read(),
                  above = windows.findIndex((w) => w.id === cover),
                  below = windows.findIndex((w) => w.id === b.id);
                const blocker = windows[above];
                if (!blocker || below < 0 || above >= below)
                  throw new Error('已知上层窗口 Z 序无效。');
                const ledge = computeLedges(windows, config.ledgeScreen).find((l) => l.id === b.id);
                record.occlusion = { zOrderVerified: true, blocker: blocker.bounds, ledge };
                const left =
                    (blocker.bounds.left - config.ledgeScreen.workArea.left) / config.scale,
                  right = (blocker.bounds.right - config.ledgeScreen.workArea.left) / config.scale;
                if (
                  !ledge?.segments.length ||
                  ledge.segments.some((l) => l.left < right && l.right > left)
                )
                  throw new Error('局部遮挡未正确扣除并保留未遮住的顶边。');
              } finally {
                coverPlacement.hide();
              }
            });
            await checks.run('跨出左边界后继续移动', async () => {
              const snapshots: Ledges[] = [];
              record.crossing = snapshots;
              try {
                for (const offset of [100, 200]) {
                  test.move(
                    Math.round(config.ledgeScreen.workArea.left - offset * config.scale),
                    y + 30,
                  );
                  await sleep(150);
                  const at = Date.now();
                  snapshots.push({ at, windows: computeLedges(config.read(), config.ledgeScreen) });
                }
                const first = snapshots[0]?.windows.find((w) => w.id === window.id);
                const second = snapshots[1]?.windows.find((w) => w.id === window.id);
                if (
                  !first ||
                  !second ||
                  first.left >= 0 ||
                  second.left >= 0 ||
                  Math.abs(second.left - first.left + 100) > 2 / config.scale ||
                  !first.segments.length ||
                  !second.segments.length ||
                  [...first.segments, ...second.segments].some((s) => s.left < 0)
                )
                  throw new Error('跨屏移动的完整左边界被裁剪，或可站段未正确保留。');
              } finally {
                test.move(x, y + 30);
              }
            });
            await checks.run('最小化', async () => {
              if (!record.capabilities?.canMinimize) {
                record.caption.minimizeCheck = '不适用：窗口没有最小化按钮';
                return;
              }
              test.minimize();
              await sleep(150);
              const w = config.read().find((w) => w.id === window.id);
              if (!w?.minimized || w.eligible || w.occludes)
                throw new Error('最小化状态或过滤无效。');
            });
            await checks.run('最大化', async () => {
              if (!record.capabilities?.canMaximize) {
                record.caption.maximizeCheck = '不适用：窗口没有最大化按钮';
                return;
              }
              test.move(x, y);
              test.maximize();
              await sleep(150);
              const w = config.read().find((w) => w.id === window.id);
              if (!w?.maximized || w.eligible) throw new Error('最大化状态或过滤无效。');
            });
          } finally {
            await checks.run('恢复窗口', () => {
              test.restore();
            });
          }
        }
      }
      result.completedAppChecks.push(name);
      console.log(
        `${name}：${checks.entries.filter((c) => c.status === 'failed').length} 项失败，继续。`,
      );
      save();
    }
    if (!isPreflight) {
      await log.run('透明窗口不遮挡', () => {
        for (const [name, style] of [
          ['ClickThrough', 0x80000 | 0x20 | 0x80],
          ['AlphaZero', 0x80000 | 0x80],
        ] as const) {
          const id = testApi.fixture(`TTCats M4 ${name}`, false, style);
          const w = config.read().find((w) => w.id === id);
          if (!w || w.occludes || w.eligible) throw new Error('透明层仍遮挡或可站立。');
        }
      });
      await log.run('关闭窗口通知', async () => {
        tracker?.dispose();
        const queryErrors: unknown[] = [];
        tracker = createWindowLedgeTracker({
          readWindows: config.read,
          screen: () => config.ledgeScreen,
          onUpdate: (update) => {
            latest = update;
          },
          onError: (error) => {
            queryErrors.push(error);
          },
        });
        tracker.setMode(true, true);
        if (!closeLegacy) throw new Error('独立 Legacy 进程没有创建成功。');
        await closeLegacy();
        tracker.refresh();
        if (queryErrors.length)
          throw new AggregateError(queryErrors, '关闭通知核对的窗口查询失败。');
        if (!latest?.unavailable.some((w) => w.id === legacy && w.reason === 'closed'))
          throw new Error('关闭窗口未产生不可站立通知。');
      });
      await log.run('结束时独占检查', () => {
        exclusivity([process.pid]);
      });
    }
  } catch (error) {
    await log.run('运行错误', () => {
      throw error;
    });
  } finally {
    tracker?.dispose();
    probe.dispose();
    if (closeLegacy) await log.run('清理独立 Legacy 进程', closeLegacy);
    if (native) await log.run('清理测试窗口及上下文', () => native?.dispose());
  }
  return finish();
}

async function main(): Promise<void> {
  await app.whenReady();
  if (args.includes('--diagnose-caption') || args.some((a) => a.startsWith('--target=')))
    throw new Error('已取消短诊断轮次；使用 --preflight 或完整核对。');
  if (inspect) {
    const config = configuration();
    console.log(
      JSON.stringify({ machine: hostname(), ...config, windows: config.read() }, null, 2),
    );
    return;
  }
  if (!preflight && !approved)
    throw new Error('完整实测须按用户约定取得明确许可，再加 --approved。');
  if (preflight) {
    if (!(await runConfiguration(true))) throw new Error('预检未全部通过，禁止申请实测。');
    return;
  }
  if (desktopBatch && configuration().label !== '3440x1440-100pct')
    throw new Error('台式机合并一轮必须从 3440×1440、100% 开始。');
  const first = await runConfiguration(false);
  let second = true;
  if (desktopBatch) {
    const input = createInterface({ input: process.stdin, output: process.stdout });
    try {
      await input.question(
        'RESOLUTION_SWITCH_REQUIRED：已保存第一种配置；请切换到 2560×1440、100%，完成后输入回车。',
      );
    } finally {
      input.close();
    }
    if (configuration().label !== '2560x1440-100pct')
      throw new Error('第二种配置尚未切换，第一种结果已保存。');
    second = await runConfiguration(false);
  }
  if (!first || !second)
    throw new Error('本轮有失败，各应用及 CPU 数据已保存；先修复并预检，不能直接申请重测。');
}
void main()
  .then(() => {
    app.exit(0);
  })
  .catch((error: unknown) => {
    console.error(error);
    app.exit(1);
  });
