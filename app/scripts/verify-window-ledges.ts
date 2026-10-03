// npx electron scripts/verify-window-ledges-entry.js --inspect
// 正式核对/测量需要先取得用户对本机、本配置、本轮的明确同意，再加 --approved。
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { hostname, cpus } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { app, desktopCapturer, nativeImage, screen } from 'electron';
import type { WindowInfo, WindowRect } from '../src/main/platform/types';
import { readWindows } from '../src/main/platform/win/windows';
import { captionButtonsMatch } from '../src/main/platform/win/window-geometry';
import { createWindowLedgeTest } from '../src/main/platform/win/test-window-ledges';
import { computeLedges } from '../src/main/window-ledges/compute';
import {
  createWindowLedgeTracker,
  type WindowLedgeUpdate,
} from '../src/main/window-ledges/tracker';
import { exclusivity, sleep, waitFor } from './lib/desktop';

const args = process.argv;
const inspect = args.includes('--inspect');
const measure = args.includes('--measure');
const approved = args.includes('--approved');
const diagnoseCaption = args.includes('--diagnose-caption');
const diagnoseTarget = args.find((a) => a.startsWith('--target='))?.slice(9) ?? '记事本';
const legacyId = args.find((a) => a.startsWith('--legacy='))?.slice(9);
const output =
  args.find((a) => a.startsWith('--output='))?.slice(9) ??
  join(import.meta.dirname, '../out/window-ledges');

function physical(rect: Electron.Rectangle): WindowRect {
  const r = screen.dipToScreenRect(null, rect);
  return { left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height };
}

async function uiCaption(id: string): Promise<{
  buttons: { kind: string; left: number; right: number; top: number; bottom: number }[];
  bounds: WindowRect;
}> {
  const { stdout } = await promisify(execFile)(
    'powershell',
    [
      '-NoProfile',
      '-File',
      join(import.meta.dirname, 'verify-window-caption.ps1'),
      '-WindowHandle',
      id,
    ],
    { encoding: 'utf8', timeout: 20000 },
  );
  const buttons = JSON.parse(stdout.trim()) as {
    kind: string;
    left: number;
    right: number;
    top: number;
    bottom: number;
  }[];
  return {
    buttons,
    bounds: {
      left: Math.min(...buttons.map((b) => b.left)),
      right: Math.max(...buttons.map((b) => b.right)),
      top: Math.min(...buttons.map((b) => b.top)),
      bottom: Math.max(...buttons.map((b) => b.bottom)),
    },
  };
}

async function captureCaption(
  id: string,
  bounds: WindowRect,
  screenshot: string,
  fromScreen = false,
) {
  const { stdout } = await promisify(execFile)(
    'powershell',
    [
      '-NoProfile',
      '-File',
      join(import.meta.dirname, 'capture-window-caption.ps1'),
      '-WindowHandle',
      id,
      '-Left',
      String(bounds.left),
      '-Top',
      String(bounds.top),
      '-Right',
      String(bounds.right),
      '-Bottom',
      String(bounds.bottom),
      '-OutputPath',
      join(output, screenshot),
      ...(fromScreen ? ['-FromScreen'] : []),
    ],
    { encoding: 'utf8', timeout: 20000 },
  );
  const capture = JSON.parse(stdout.trim()) as {
    outer: WindowRect;
    crop: WindowRect;
    width: number;
    height: number;
    method: string;
  };
  const image = nativeImage.createFromPath(join(output, screenshot));
  if (
    image.isEmpty() ||
    image.getSize().width !== capture.width ||
    image.getSize().height !== capture.height
  )
    throw new Error('原生按钮截图尺寸无效。');
  return { capture, image, screenshot };
}

async function main(): Promise<void> {
  await app.whenReady();
  const primary = screen.getPrimaryDisplay();
  const displays = screen.getAllDisplays().map((d) => ({
    id: d.id,
    bounds: physical(d.bounds),
    workArea: physical(d.workArea),
    scaleFactor: d.scaleFactor,
    primary: d.id === primary.id,
  }));
  const ledgeScreen = { workArea: physical(primary.workArea), scaleFactor: primary.scaleFactor };
  const read = (): WindowInfo[] =>
    readWindows(
      displays.map((d) => ({ bounds: d.bounds, scaleFactor: d.scaleFactor })),
      [],
    );
  const label = `${Math.round(primary.size.width * primary.scaleFactor)}x${Math.round(primary.size.height * primary.scaleFactor)}-${Math.round(primary.scaleFactor * 100)}pct`;
  if (inspect) {
    // 只读，不移动窗口、不测性能，也不公开用户窗口标题。
    const windows = read();
    console.log(
      JSON.stringify(
        {
          machine: hostname(),
          label,
          displays,
          windowCount: windows.length,
          windows: windows.filter((w) => w.eligible || w.occludes),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (!approved)
    throw new Error(
      '必须先向用户说明本机、显示配置、时长和独占要求，取得明确同意后才能加 --approved。',
    );
  if (diagnoseCaption && measure) throw new Error('按钮诊断与性能验收不能混为一轮结果。');
  mkdirSync(output, { recursive: true });
  const runId = Date.now();
  exclusivity([process.pid]);
  const native = createWindowLedgeTest();
  const evidence: unknown[] = [];
  let tracker: ReturnType<typeof createWindowLedgeTracker> | undefined;
  try {
    const legacy = native.fixture('TTCats M4 Legacy', true);
    const cover = native.fixture('TTCats M4 Occluder');
    const transparent = native.fixture('TTCats M4 ClickThrough', false, 0x80000 | 0x20 | 0x80);
    const zero = native.fixture('TTCats M4 AlphaZero', false, 0x80000 | 0x80);
    const coverTest = native.prepare(cover);
    coverTest.hide();
    const original = read();
    const processes = JSON.parse(
      execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          'Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,Name | ConvertTo-Json -Compress',
        ],
        { encoding: 'utf8' },
      ),
    ) as { ProcessId: number; Name: string }[];
    const processNames = new Map(processes.map((p) => [p.ProcessId, p.Name]));
    const targets: [string, WindowInfo | undefined][] = [
      ['记事本', original.find((w) => w.className === 'Notepad')],
      [
        '浏览器',
        original.find(
          (w) =>
            ['Chrome_WidgetWin_1', 'MozillaWindowClass'].includes(w.className) &&
            (w.visible || w.minimized) &&
            /^(chrome|msedge|firefox|brave|vivaldi|opera)\.exe$/i.test(
              processNames.get(w.pid) ?? '',
            ),
        ),
      ],
      ['资源管理器', original.find((w) => w.className === 'CabinetWClass')],
      [
        'DPI 不感知老程序',
        original.find((w) =>
          legacyId
            ? w.id === legacyId
            : w.dpiAwareness === 'unaware' &&
              ['', 'minimized', 'maximized', 'buttons-unavailable'].includes(w.reason) &&
              w.id !== legacy,
        ),
      ],
      ['独立 Legacy 回归窗口', original.find((w) => w.id === legacy)],
    ];
    if (diagnoseCaption && !targets.some(([name]) => name === diagnoseTarget))
      throw new Error(`未知诊断应用：${diagnoseTarget}，不能跳过所有应用后宣称通过。`);
    for (const [name, window] of targets) {
      if (!window)
        throw new Error(`没有找到${name}，不能跳过；老程序可用 --legacy=窗口句柄 指定。`);
      if (name === 'DPI 不感知老程序' && window.dpiAwareness !== 'unaware')
        throw new Error('指定的老程序实际并非 DPI 不感知。');
    }
    let latest: WindowLedgeUpdate | undefined;
    let trackerError: unknown;
    tracker = createWindowLedgeTracker({
      readWindows: read,
      screen: () => ledgeScreen,
      onUpdate: (update) => {
        latest = update;
      },
      onError: (error) => {
        trackerError = error;
      },
    });
    tracker.setMode(true, true);
    const x = Math.round(ledgeScreen.workArea.left + 120 * primary.scaleFactor);
    const y = Math.round(ledgeScreen.workArea.top + 240 * primary.scaleFactor);
    for (const [name, window] of targets.filter(
      ([name]) => !diagnoseCaption || name === diagnoseTarget,
    )) {
      if (!window) throw new Error(`没有找到${name}。`);
      const test = native.prepare(window.id);
      try {
        test.move(
          x,
          y,
          Math.round(800 * primary.scaleFactor),
          Math.round(400 * primary.scaleFactor),
        );
        test.raise();
        await sleep(250);
        const a = read().find((w) => w.id === window.id);
        if (!a?.eligible)
          throw new Error(`${name}恢复后没有可靠的窗口顶边（${a?.reason ?? 'closed'}）。`);
        const baseline = computeLedges(read(), ledgeScreen).filter((l) => l.id === a.id);
        if (!baseline.length) throw new Error(`${name}没有可见顶边，不能用空线段验证遮挡。`);
        let uiDiagnostic: unknown;
        if (diagnoseCaption) {
          const { stdout } = await promisify(execFile)(
            'powershell',
            [
              '-NoProfile',
              '-File',
              join(import.meta.dirname, 'diagnose-window-caption.ps1'),
              '-WindowHandle',
              a.id,
            ],
            { encoding: 'utf8', timeout: 20000 },
          );
          uiDiagnostic = JSON.parse(stdout.trim());
        }
        let reference: {
          method: string;
          bounds: WindowRect;
          screenshot?: string;
          capture?: unknown;
          uiaFailure?: string;
          buttons?: unknown;
        };
        try {
          reference = { method: 'UI Automation', ...(await uiCaption(a.id)) };
        } catch (error) {
          // WinUI 记事本不暴露非客户区按钮时，按 issue 的另一条路径保存真实截图。
          const outer = native.outer(a.id);
          let bounds: WindowRect;
          let hitFailure: string | undefined;
          try {
            bounds = native.captionBounds(a.id, primary.scaleFactor);
          } catch (hitError) {
            if (!diagnoseCaption)
              throw new AggregateError([error, hitError], `${name}没有可靠的截图坐标参考。`, {
                cause: hitError,
              });
            {
              if (!a.buttons) throw new Error('诊断也没有按钮定位提示。', { cause: hitError });
              bounds = {
                ...a.buttons,
                bottom: Math.max(
                  a.buttons.bottom,
                  outer.top + Math.round(70 * primary.scaleFactor),
                ),
              };
            }
            hitFailure = hitError instanceof Error ? hitError.message : String(hitError);
          }
          {
            let screenshot = `caption-${label}-${a.id}-${Date.now()}.png`;
            const crop = {
              left: Math.max(bounds.left - Math.round(16 * primary.scaleFactor), a.bounds.left),
              top: Math.max(bounds.top - 2, a.bounds.top),
              right: Math.min(bounds.right + Math.round(16 * primary.scaleFactor), a.bounds.right),
              bottom: Math.min(bounds.bottom + 2, a.bounds.bottom),
            };
            let { capture, image: caption } = await captureCaption(a.id, crop, screenshot);
            if (diagnoseCaption) {
              const sources = await desktopCapturer.getSources({
                types: ['window'],
                thumbnailSize: {
                  width: outer.right - outer.left,
                  height: outer.bottom - outer.top,
                },
              });
              const source = sources.find((s) => s.id.split(':')[1] === a.id);
              writeFileSync(
                join(output, `diagnose-caption-${a.id}.json`),
                JSON.stringify(
                  {
                    name,
                    predicted: a.buttons,
                    bounds,
                    outer,
                    frame: a.bounds,
                    capture,
                    screenshot,
                    thumbnail: source
                      ? {
                          size: source.thumbnail.getSize(),
                          scales: source.thumbnail.getScaleFactors(),
                          empty: source.thumbnail.isEmpty(),
                        }
                      : null,
                    uiDiagnostic,
                    hitFailure,
                  },
                  null,
                  2,
                ),
              );
              console.log('按钮诊断已保存，未执行按钮验收、其他应用或 CPU 测量。');
              return;
            }
            if (
              caption.isEmpty() ||
              caption.getSize().width !== capture.width ||
              caption.getSize().height !== capture.height
            )
              throw new Error('原生按钮截图尺寸无效。', { cause: error });
            let pixels = caption.toBitmap();
            if (!pixels.some((value, index) => value !== pixels[index % 4])) {
              screenshot = screenshot.replace('.png', '-screen.png');
              ({ capture, image: caption } = await captureCaption(a.id, crop, screenshot, true));
              pixels = caption.toBitmap();
            }
            if (!pixels.some((value, index) => value !== pixels[index % 4]))
              throw new Error('按钮截图是纯色，不能作为视觉证据。', { cause: error });
            reference = {
              method: `${capture.method}实际按钮截图与独立 WM_NCHITTEST 命中区域`,
              bounds,
              screenshot,
              capture,
              uiaFailure: error instanceof Error ? error.message : String(error),
            };
          }
        }
        if (diagnoseCaption) {
          writeFileSync(
            join(output, `diagnose-caption-${a.id}.json`),
            JSON.stringify({ name, predicted: a.buttons, reference, uiDiagnostic }, null, 2),
          );
          console.log('按钮诊断已保存，未执行按钮验收、其他应用或 CPU 测量。');
          return;
        }
        writeFileSync(
          join(output, `caption-${a.id}.json`),
          JSON.stringify({ name, predicted: a.buttons, reference }, null, 2),
        );
        if (!captionButtonsMatch(a.buttons, reference.bounds))
          throw new Error(
            `${name}的按钮区与独立参考不一致：${JSON.stringify({ actual: a.buttons, reference: reference.bounds })}`,
          );
        const delays: number[] = [];
        for (let i = 0; i < 5; i++) {
          const started = performance.now();
          const dx = (i % 2 ? 20 : 80) * primary.scaleFactor;
          test.move(Math.round(x + dx), y + 30);
          if (
            (await waitFor(
              () =>
                latest !== undefined &&
                latest.at >= started &&
                latest.moved.some((m) => m.id === a.id && Math.abs(m.dx) > 1),
              500,
              2,
            )) === null
          )
            throw new Error(`${name}的移动没有及时产生顶边更新。`);
          if (trackerError !== undefined)
            throw new Error('顶边更新失败。', { cause: trackerError });
          delays.push(performance.now() - started);
          await sleep(80);
        }
        const b = read().find((w) => w.id === a.id);
        if (!b) throw new Error(`${name}移动后窗口丢失。`);
        const coverPlacement = native.prepare(cover);
        try {
          coverPlacement.move(
            Math.round(b.bounds.left + 150 * primary.scaleFactor),
            Math.round(b.bounds.top - 100 * primary.scaleFactor),
            Math.round(200 * primary.scaleFactor),
            Math.round(200 * primary.scaleFactor),
          );
          coverPlacement.raise();
          await sleep(150);
          const windows = read();
          const above = windows.findIndex((w) => w.id === cover),
            below = windows.findIndex((w) => w.id === b.id);
          if (above < 0 || below < 0 || above >= below)
            throw new Error('已知上层窗口没有排在下层前面。');
          const blocker = windows[above];
          if (!blocker) throw new Error('找不到遮挡窗口。');
          const ledges = computeLedges(windows, ledgeScreen).filter((l) => l.id === b.id);
          const left = (blocker.bounds.left - ledgeScreen.workArea.left) / primary.scaleFactor;
          const right = (blocker.bounds.right - ledgeScreen.workArea.left) / primary.scaleFactor;
          if (ledges.some((l) => l.left < right && l.right > left))
            throw new Error(`${name}遮挡区仍有窗口顶边。`);
          if (!ledges.length) throw new Error(`${name}局部遮挡后整条顶边消失，核对无效。`);
          evidence.push({
            name,
            window: a,
            reference,
            movementToUpdateMs: delays,
            occlusion: { zOrderVerified: true, blocker: blocker.bounds, ledges },
          });
        } finally {
          coverPlacement.hide();
        }
        test.minimize();
        await sleep(150);
        const minimized = read().find((w) => w.id === a.id);
        if (minimized?.eligible || minimized?.occludes || !minimized?.minimized)
          throw new Error(`${name}最小化后仍可站立或状态未识别。`);
        test.move(x, y);
        test.maximize();
        await sleep(150);
        const maximized = read().find((w) => w.id === a.id);
        if (maximized?.eligible || !maximized?.maximized)
          throw new Error(`${name}最大化状态未识别。`);
        writeFileSync(
          join(output, `partial-${label}-${runId}.json`),
          JSON.stringify(
            {
              status: 'incomplete',
              machine: hostname(),
              label,
              evidence,
              completedAppChecks: name,
              phases: [],
            },
            null,
            2,
          ),
        );
        console.log(`${name}：按钮、移动、遮挡、最小化及最大化核对通过。`);
      } finally {
        test.restore();
      }
    }
    const transparentWindows = read();
    for (const id of [transparent, zero]) {
      const window = transparentWindows.find((w) => w.id === id);
      if (!window || window.occludes || window.eligible)
        throw new Error('透明测试层仍参与站立或遮挡。');
    }
    tracker.refresh();
    native.closeFixture(legacy);
    tracker.refresh();
    if (!latest?.unavailable.some((w) => w.id === legacy && w.reason === 'closed'))
      throw new Error('关闭窗口没有产生不可站立通知。');
    tracker.dispose();
    const phases: unknown[] = [];
    // 测量另建读取器，关闭回归用的读取器，避免把核对过程混进 CPU 数据。
    if (measure) {
      // 应用原状可能是隐藏/最小化，测量时保留一个真正可站的窗口，避免只测空桌面。
      const cpuFixture = native.fixture('TTCats M4 CPU');
      native
        .prepare(cpuFixture)
        .move(x, y, Math.round(800 * primary.scaleFactor), Math.round(400 * primary.scaleFactor));
      if (!read().find((w) => w.id === cpuFixture)?.eligible)
        throw new Error('性能测试缺少可站立的窗口。');
      for (const [phase, mode, occupied] of [
        ['floor', false, false],
        ['idle', true, false],
        ['occupied', true, true],
      ] as const) {
        let samples = 0;
        console.log(`开始 ${phase} CPU 测量（预热 1 秒、采样 30 秒）。`);
        tracker = createWindowLedgeTracker({
          readWindows: read,
          screen: () => ledgeScreen,
          onUpdate: () => {
            samples++;
          },
          onError: (error) => {
            trackerError = error;
          },
        });
        tracker.setMode(mode, occupied);
        await sleep(1000);
        samples = 0;
        exclusivity([process.pid]);
        const cpu = process.cpuUsage(),
          start = performance.now();
        await sleep(30000);
        const elapsedMs = performance.now() - start,
          used = process.cpuUsage(cpu);
        tracker.dispose();
        exclusivity([process.pid]);
        if (trackerError !== undefined) throw new Error('顶边测量失败。', { cause: trackerError });
        const cpuMachinePercent = (used.user + used.system) / (elapsedMs * 10 * cpus().length);
        if (cpuMachinePercent >= 2)
          throw new Error(
            `窗口顶边 ${phase} 阶段 CPU ${cpuMachinePercent.toFixed(2)}%，超过 2% 目标。`,
          );
        phases.push({
          phase,
          samples,
          elapsedMs,
          cpuMicroseconds: used.user + used.system,
          cpuOneCorePercent: (used.user + used.system) / (elapsedMs * 10),
          cpuMachinePercent,
        });
        console.log(`${phase}：整机 CPU ${cpuMachinePercent.toFixed(3)}%。`);
      }
    }
    exclusivity([process.pid]);
    mkdirSync(output, { recursive: true });
    const file = join(output, `verify-${label}-${Date.now()}.json`);
    writeFileSync(
      file,
      JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          machine: hostname(),
          label,
          displays,
          evidence,
          phases,
          exclusive: true,
          latencyMethod: 'Win32 移动命令到主进程顶边更新回调；未测桌面层 IPC 或屏幕呈现',
          cpuMethod: '核对进程累计 CPU，分别列单核和整机百分比；不是完整应用性能',
          versions: process.versions,
        },
        null,
        2,
      ),
    );
    console.log(`窗口顶边真机核对通过：${file}`);
  } finally {
    tracker?.dispose();
    native.dispose();
  }
}

void main()
  .then(() => {
    app.exit(0);
  })
  .catch((error: unknown) => {
    console.error(error);
    app.exit(1);
  });
