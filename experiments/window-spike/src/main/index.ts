import {
  app,
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  Tray,
} from 'electron';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { computeLedges, movementSpeed, type WindowInfo } from '../ledge';
import { zh } from '../zh-CN';
import {
  assertWindows,
  createNativeFixtures,
  enumerateWindows,
  outerBounds,
  ignoredTransparentWindows,
} from './platform/win/windows';
import { keepAboveDrag, monitors, overlayRect } from './platform/win/overlay';

const output = path.resolve('results');
function fatal(error: unknown) {
  mkdirSync(output, { recursive: true });
  writeFileSync(
    path.join(output, 'failure.txt'),
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  console.error(error);
  app.exit(1);
}
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);
const overlays: BrowserWindow[] = [];
let tray: Tray;
let paused = false;
let sequence = 0;
let previous: WindowInfo[] = [];
let previousTime = performance.now();
let latest: WindowInfo[] = [];
const pollMs: number[] = [];
const pollCpuUs: number[] = [];
const paintMs: number[] = [];
const movementResponseMs: number[] = [];
let requestedMovement: {
  start: number;
  id: string;
  previousLeft: number;
  sequence?: number;
} | null = null;
const pending = new Map<number, number>();
const sampleTimes: number[] = [];
const fastIds = new Set<string>();
const verificationChecks: string[] = [];
let geometryEvidence: unknown;
const fixtureMode = process.argv.includes('--fixture');
// 测试进程和调试窗口不能争用同一个 Chromium 缓存。
if (fixtureMode)
  app.setPath('userData', path.join(app.getPath('userData'), `fixture-${process.pid}`));

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: values.length,
    mean: values.reduce((a, b) => a + b, 0) / (values.length || 1),
    p95: sorted[Math.floor((sorted.length - 1) * 0.95)] ?? 0,
    max: sorted.at(-1) ?? 0,
  };
}

function exportResults(name = 'sample.json') {
  mkdirSync(output, { recursive: true });
  writeFileSync(
    path.join(output, name),
    JSON.stringify(
      {
        versions: process.versions,
        displays: screen.getAllDisplays(),
        capturedAt: new Date().toISOString(),
        windows: latest,
        ignoredTransparentWindows,
        ledges: computeLedges(latest),
        pollingMs: stats(pollMs),
        pollingCpuUs: stats(pollCpuUs),
        pollingCpuTotalUs: pollCpuUs.reduce((a, b) => a + b, 0),
        pollingCpuOneCorePercent:
          pollCpuUs.reduce((a, b) => a + b, 0) /
          Math.max(1, (sampleTimes.at(-1) ?? 0) - (sampleTimes[0] ?? 0)) /
          10,
        sampleIntervalsMs: stats(sampleTimes.slice(1).map((t, i) => t - sampleTimes[i])),
        sampleToRendererAckMs: stats(paintMs),
        commandedMovementToRendererAckMs: stats(movementResponseMs),
        fastWindowIds: [...fastIds],
        verificationChecks,
        geometryEvidence,
      },
      null,
      2,
    ),
  );
}

function poll() {
  if (paused) return;
  const start = performance.now();
  const cpu = process.cpuUsage();
  latest = enumerateWindows(monitors());
  const elapsed = performance.now() - start;
  const used = process.cpuUsage(cpu);
  pollMs.push(elapsed);
  pollCpuUs.push(used.user + used.system);
  sampleTimes.push(start);
  const fast = new Set(
    latest
      .filter((w) => {
        const old = previous.find((p) => p.id === w.id);
        return old && movementSpeed(old.bounds, w.bounds, start - previousTime, w.dpi) > 800;
      })
      .map((w) => w.id),
  );
  fast.forEach((id) => fastIds.add(id));
  sequence++;
  if (requestedMovement && requestedMovement.sequence === undefined) {
    const moved = latest.find((w) => w.id === requestedMovement!.id);
    if (moved && moved.bounds.left !== requestedMovement.previousLeft)
      requestedMovement.sequence = sequence;
  }
  pending.set(sequence, start);
  for (const [id, t] of pending) if (start - t > 2000) pending.delete(id);
  const ledges = computeLedges(
    process.argv.includes('--verify') ? latest.filter((w) => w.title.startsWith('M0-B ')) : latest,
  );
  overlays.forEach((overlay) => {
    if (overlay.isDestroyed()) return;
    keepAboveDrag(overlay);
    const converted = ledges.map((ledge) => {
      const r = overlayRect(overlay, {
        x: ledge.left,
        y: ledge.y,
        width: ledge.right - ledge.left,
        height: 1,
      });
      return {
        left: r.x,
        right: r.x + r.width,
        y: r.y,
        fast: fast.has(ledge.id),
        label: latest.find((w) => w.id === ledge.id)?.className ?? '',
      };
    });
    overlay.webContents.send('frame', {
      sequence,
      ledges: converted,
      status: zh.status(latest.length, ledges.length, elapsed),
    });
  });
  previous = latest;
  previousTime = start;
  // 最多保留 6000 条，限制采样内存；实际覆盖时长由采样间隔决定。
  if (pollMs.length > 6000) {
    pollMs.shift();
    pollCpuUs.shift();
    sampleTimes.shift();
  }
  if (paintMs.length > 6000) paintMs.shift();
}

async function createOverlays() {
  for (const overlay of overlays.splice(0)) overlay.close();
  for (const display of screen.getAllDisplays()) {
    const overlay = new BrowserWindow({
      ...display.bounds,
      transparent: true,
      frame: false,
      show: false,
      focusable: false,
      skipTaskbar: true,
      resizable: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    overlay.setIgnoreMouseEvents(true);
    overlay.setAlwaysOnTop(true, 'screen-saver');
    await overlay.loadFile(path.resolve('overlay.html'));
    overlay.showInactive();
    overlays.push(overlay);
  }
}

async function verify() {
  // 独立 Electron 进程创建的测试窗口，避免破坏用户的窗口布局。
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [path.resolve('.'), '--fixture'], {
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  const commandFile = path.join(output, `fixture-command-${child.pid}.txt`);
  mkdirSync(output, { recursive: true });
  try {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    poll();
    exportResults('verify-initial.json');
    const fixture = latest.find((w) => w.title === 'M0-B Fixture');
    if (!fixture || !fixture.eligible) throw new Error('没有读到独立进程的测试窗口。');
    if (latest.some((w) => ['M0-B ClickThrough', 'M0-B AlphaZero'].includes(w.title)))
      throw new Error('透明鼠标穿过层或完全透明层仍参与遮挡。');
    verificationChecks.push('transparent-occluders');
    const legacy = latest.find((w) => w.title === 'M0-B Legacy');
    if (!legacy || legacy.windowDpi !== 96 || legacy.dpi !== fixture.dpi)
      throw new Error('不支持 DPI 的程序没有使用所在显示器的缩放。');
    verificationChecks.push('legacy-monitor-dpi');
    const blocked = latest.find((w) => w.title === 'M0-B Occluder');
    const segments = computeLedges(latest.filter((w) => w.title.startsWith('M0-B '))).filter(
      (l) => l.id === fixture.id,
    );
    if (
      !blocked ||
      segments.length === 0 ||
      segments.some((l) => l.left < blocked.bounds.right && l.right > blocked.bounds.left)
    )
      throw new Error('遮挡区域没有正确扣除，或测试窗口完全被遮挡。');
    if (
      fixture.buttons &&
      segments.some((l) => l.left < fixture.buttons!.right && l.right > fixture.buttons!.left)
    )
      throw new Error('标题栏按钮区域没有扣除。');
    const overlay =
      overlays.find(
        (w) => screen.getDisplayMatching(w.getBounds()).scaleFactor === fixture.dpi / 96,
      ) ?? overlays[0];
    const canvasSize = (await overlay.webContents.executeJavaScript(
      '({ width: document.querySelector("canvas").getBoundingClientRect().width, height: document.querySelector("canvas").getBoundingClientRect().height, viewportWidth: innerWidth, viewportHeight: innerHeight })',
    )) as { width: number; height: number; viewportWidth: number; viewportHeight: number };
    if (
      Math.abs(canvasSize.width - canvasSize.viewportWidth) > 1 ||
      Math.abs(canvasSize.height - canvasSize.viewportHeight) > 1
    )
      throw new Error(`桌面层绘制区逻辑尺寸错误：${JSON.stringify(canvasSize)}`);
    verificationChecks.push('canvas-css-size');
    const dip = screen.screenToDipRect(overlay, {
      x: fixture.bounds.left,
      y: fixture.bounds.top,
      width: fixture.bounds.right - fixture.bounds.left,
      height: fixture.bounds.bottom - fixture.bounds.top,
    });
    const physical = screen.dipToScreenRect(overlay, dip);
    const outer = outerBounds(fixture.id);
    const expected = [200, 320].map((x) =>
      screen.dipToScreenRect(overlay, { x, y: 220, width: 800, height: 400 }),
    );
    if (
      !expected.some(
        (r) =>
          Math.abs(r.x - outer.left) <= 2 &&
          Math.abs(r.y - outer.top) <= 2 &&
          Math.abs(r.width - (outer.right - outer.left)) <= 2 &&
          Math.abs(r.height - (outer.bottom - outer.top)) <= 2,
      )
    )
      throw new Error('真实外框不符合测试窗口已知的逻辑位置或大小。');
    geometryEvidence = {
      expectedOuterRects: expected,
      actualOuter: outer,
      dwmBounds: fixture.bounds,
      convertedDwm: dip,
    };
    verificationChecks.push('known-window-position');
    if (
      Math.abs(physical.x - fixture.bounds.left) > 2 ||
      Math.abs(physical.y - fixture.bounds.top) > 2 ||
      Math.abs(physical.width - (fixture.bounds.right - fixture.bounds.left)) > 2 ||
      Math.abs(physical.height - (fixture.bounds.bottom - fixture.bounds.top)) > 2
    )
      throw new Error('物理像素与逻辑坐标往返误差超过 2 像素。');
    verificationChecks.push('native-enumeration', 'occlusion-and-buttons', 'dpi-roundtrip');
    await new Promise((resolve) => setTimeout(resolve, 4000));
    mkdirSync(output, { recursive: true });
    for (let i = 0; i < overlays.length; i++) {
      writeFileSync(
        path.join(output, `overlay-${i}.png`),
        (await overlays[i].webContents.capturePage()).toPNG(),
      );
    }
    if (!fastIds.has(fixture.id)) throw new Error('没有检测到测试窗口的快速移动。');
    verificationChecks.push('fast-movement');
    writeFileSync(commandFile, 'capture');
    await new Promise((resolve) => setTimeout(resolve, 300));
    poll();
    // 窗口捕获可能被其他置顶应用影响；单独请求时失败，不能当作几何验证通过项。
    if (process.argv.includes('--capture-window')) {
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 1600, height: 1000 },
      });
      const source = sources.find((s) => s.name === 'M0-B Fixture');
      if (!source || source.thumbnail.isEmpty()) throw new Error('没有取得独立测试窗口的图像。');
      writeFileSync(path.join(output, 'fixture-window.png'), source.thumbnail.toPNG());
    }
    writeFileSync(commandFile, 'churn');
    for (let i = 0; i < 300; i++) {
      const snapshot = enumerateWindows(monitors());
      if (new Set(snapshot.map((w) => w.id)).size !== snapshot.length)
        throw new Error('频繁换序时出现重复窗口。');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    verificationChecks.push('z-order-churn');
    for (const x of [400, 250, 450, 200, 500]) {
      const current = latest.find((w) => w.id === fixture.id)!;
      requestedMovement = {
        start: performance.now(),
        id: fixture.id,
        previousLeft: current.bounds.left,
      };
      writeFileSync(commandFile, `move:${x}`);
      const deadline = performance.now() + 3000;
      while (requestedMovement && performance.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      if (requestedMovement) throw new Error('测试窗口移动后，三秒内没有收到绘制回执。');
    }
    verificationChecks.push('commanded-movement-latency');
    for (const command of ['maximize', 'minimize', 'hide', 'fullscreen', 'normal']) {
      writeFileSync(commandFile, command);
      await new Promise((resolve) => setTimeout(resolve, 700));
      poll();
      const current = latest.find((w) => w.id === fixture.id);
      if (command === 'maximize' && (!current?.maximized || current.eligible))
        throw new Error('最大化窗口过滤失败。');
      if ((command === 'minimize' || command === 'hide') && current)
        throw new Error('最小化或隐藏窗口过滤失败。');
      if (command === 'fullscreen' && (!current?.fullscreen || current.eligible))
        throw new Error('全屏窗口过滤失败。');
      if (command === 'normal' && !current?.eligible) throw new Error('恢复普通窗口失败。');
      verificationChecks.push(command);
    }
    exportResults('verify.json');
    console.log('VERIFY_OK', JSON.stringify({ dpi: fixture.dpi, dip, physical, segments }));
  } finally {
    writeFileSync(commandFile, 'quit');
    await new Promise((resolve) => setTimeout(resolve, 200));
    child.kill();
    if (existsSync(commandFile)) unlinkSync(commandFile);
  }
}

app
  .whenReady()
  .then(async () => {
    assertWindows();
    if (fixtureMode) {
      const fixture = new BrowserWindow({
        x: 200,
        y: 220,
        width: 800,
        height: 400,
        title: 'M0-B Fixture',
      });
      await fixture.loadURL('data:text/html,<h1>M0-B Fixture</h1>');
      fixture.setTitle('M0-B Fixture');
      fixture.setAlwaysOnTop(true);
      const occluder = new BrowserWindow({
        x: 600,
        y: 140,
        width: 350,
        height: 260,
        title: 'M0-B Occluder',
      });
      await occluder.loadURL('data:text/html,<h1>M0-B Occluder</h1>');
      occluder.setTitle('M0-B Occluder');
      occluder.setAlwaysOnTop(true);
      createNativeFixtures();
      let phase = 0;
      let churn = false;
      let capturing = false;
      const movement = setInterval(() => {
        if (capturing) return;
        phase++;
        fixture.setPosition(200 + (phase % 2) * 120, 220);
        if (churn) (phase % 2 ? fixture : occluder).moveTop();
      }, 350);
      const commandFile = path.join(output, `fixture-command-${process.pid}.txt`);
      let lastCommand = '';
      setInterval(() => {
        if (!existsSync(commandFile)) return;
        const data = readFileSync(commandFile, 'utf8');
        if (data === lastCommand) return;
        lastCommand = data;
        if (data === 'churn') {
          churn = true;
          capturing = false;
          return;
        }
        if (data === 'capture') {
          capturing = true;
          fixture.moveTop();
          occluder.moveTop();
          return;
        }
        clearInterval(movement);
        for (const command of data.trim().split('\n')) {
          fixture.setFullScreen(false);
          fixture.restore();
          fixture.showInactive();
          if (command === 'maximize') fixture.maximize();
          if (command === 'minimize') fixture.minimize();
          if (command === 'hide') fixture.hide();
          if (command === 'fullscreen') fixture.setFullScreen(true);
          if (command.startsWith('move:')) fixture.setPosition(Number(command.slice(5)), 220);
          if (command === 'quit') app.exit(0);
        }
      }, 50);
      return;
    }
    await createOverlays();
    ipcMain.on('painted', (event, id: number) => {
      if (!overlays.some((w) => !w.isDestroyed() && w.webContents === event.sender)) return;
      const start = pending.get(id);
      if (start !== undefined) {
        paintMs.push(performance.now() - start);
        pending.delete(id);
      }
      if (requestedMovement?.sequence !== undefined && id >= requestedMovement.sequence) {
        movementResponseMs.push(performance.now() - requestedMovement.start);
        requestedMovement = null;
      }
    });
    const image = nativeImage.createFromBuffer(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#43f59c"/></svg>',
      ),
    );
    // PNG 图标，避免不同 Electron 版本的 SVG 解码差异。
    tray = new Tray(
      image.isEmpty()
        ? nativeImage.createFromDataURL(
            'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=',
          )
        : image,
    );
    tray.setToolTip(zh.title);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: zh.pause,
          click: () => {
            paused = !paused;
            previous = [];
            previousTime = performance.now();
          },
        },
        { label: zh.export, click: () => exportResults() },
        { label: zh.quit, click: () => app.quit() },
      ]),
    );
    screen.on('display-metrics-changed', () => {
      void createOverlays();
    });
    screen.on('display-added', () => {
      void createOverlays();
    });
    screen.on('display-removed', () => {
      void createOverlays();
    });
    const timer = setInterval(() => {
      try {
        poll();
      } catch (error) {
        console.error(error);
        clearInterval(timer);
        app.exit(1);
      }
    }, 100);
    poll();
    if (process.argv.includes('--verify')) {
      await verify();
      clearInterval(timer);
      app.exit(0);
    }
    if (process.argv.includes('--measure'))
      setTimeout(() => {
        clearInterval(timer);
        exportResults('measure.json');
        app.exit(0);
      }, 30000);
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
app.on('window-all-closed', () => {
  /* 托盘控制退出；重建显示器窗口时继续运行。 */
});
