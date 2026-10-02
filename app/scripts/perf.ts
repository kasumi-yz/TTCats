import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { _electron, expect, type Page, type ElectronApplication } from '@playwright/test';
import { buildOverlayCheck, appRoot, output } from './perf-build';
import {
  ctrl,
  extendedStyle,
  foregroundWindow,
  mouseButton,
  mouseMove,
  setDpiAware,
} from './perf-native';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const root = join(appRoot, '..');
const verification = process.argv.includes('--verify');
const movingPointer = process.argv.includes('--moving-pointer');
assert.ok(!verification || !movingPointer, '--verify and --moving-pointer are separate runs');
const seconds = Number(process.argv.find((a) => a.startsWith('--seconds='))?.slice(10) ?? 300);
assert.ok(Number.isFinite(seconds) && seconds >= 10);
const results = join(output, 'results');
const evidence = join(appRoot, 'src/main/overlay/verification');
interface ViewState {
  drew: number;
  paused: boolean;
  ghost: boolean;
  dragging: boolean;
  errors: string[];
  cats: {
    cat: string;
    x: number;
    y: number;
    scale: number;
    current: string;
    wanted: string;
    frame: number;
    visible: boolean;
    cache: string[];
    videoTime: number;
  }[];
}
function exclusivity(): void {
  const report = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      "Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.Name -match '^(electron|python|pythonw|ComfyUI)\\.exe$' } | Select-Object Name,ExecutablePath | ConvertTo-Json -Compress",
    ],
    { encoding: 'utf8' },
  ).trim();
  const processes: { Name: string; ExecutablePath: string | null }[] = report
    ? ([] as { Name: string; ExecutablePath: string | null }[]).concat(
        JSON.parse(report) as { Name: string; ExecutablePath: string | null }[],
      )
    : [];
  const ours = join(root, 'node_modules/electron').toLowerCase();
  const others = processes.filter((p) => !p.ExecutablePath?.toLowerCase().startsWith(ours));
  assert.equal(
    others.length,
    0,
    'Other Electron / asset factory processes: ' + others.map((p) => p.Name).join(','),
  );
}
await buildOverlayCheck();
mkdirSync(results, { recursive: true });
mkdirSync(evidence, { recursive: true });
exclusivity();
const electron = await _electron.launch({
  args: [join(output, 'desktop.mjs')],
  env: { ...process.env, TTCATS_OVERLAY_CONTENT: join(appRoot, 'test-content') },
  timeout: 30000,
});
electron.process().stderr?.on('data', (data: Buffer) => process.stderr.write(data));
async function overlayPage(): Promise<Page> {
  await expect.poll(() => electron.evaluate('Boolean(globalThis.overlayFixture)')).toBe(true);
  const page = electron.windows().find((p) => p.url().endsWith('/overlay/test.html'));
  assert.ok(page);
  page.on('console', (message) => {
    console.log('renderer console', message.text());
  });
  page.on('pageerror', (error) => {
    console.error('renderer error', error);
  });
  await expect
    .poll(() => page.evaluate('Boolean(window.overlayTest)'), { timeout: 15000 })
    .toBe(true);
  return page;
}
const main = async (expression: string): Promise<void> => {
  await electron.evaluate(expression);
};
async function inspect(page: Page): Promise<ViewState> {
  return await page.evaluate<ViewState>('window.overlayTest.inspect()');
}
async function point(x: number, y: number): Promise<void> {
  const screenPoint = await electron.evaluate(
    ({ screen }, p) => {
      const area = screen.getPrimaryDisplay().workArea;
      return screen.dipToScreenPoint({ x: Math.round(p.x + area.x), y: Math.round(p.y + area.y) });
    },
    { x, y },
  );
  mouseMove(screenPoint.x, screenPoint.y);
}
async function handle(): Promise<number> {
  return await electron.evaluate<number>(
    'Number(globalThis.overlayFixture.overlay.window.getNativeWindowHandle().readBigUInt64LE(0))',
  );
}
async function waitReady(page: Page): Promise<void> {
  await expect.poll(async () => (await inspect(page)).cats.filter((c) => c.visible).length).toBe(3);
}
async function verify(page: Page): Promise<void> {
  setDpiAware();
  const checks: { name: string; at: number }[] = [];
  const record = (name: string): void => {
    checks.push({ name, at: Date.now() });
    console.log('PASS ' + name);
  };
  await waitReady(page);
  const native = await handle();
  const style = extendedStyle(native);
  assert.ok(style & 0x8000000);
  assert.ok(style & 0x8);
  record('transparent topmost nonactivating window');
  await main('globalThis.overlayFixture.probe(false)');
  const probe = electron.windows().find((p) => p.url().startsWith('data:'));
  assert.ok(probe);
  // 固定三只测试猫的站姿，防止测试中自主换片段改变点击坐标。
  for (const cat of (await inspect(page)).cats) {
    await main('globalThis.overlayFixture.clip(' + JSON.stringify(cat.cat) + ',"idle-stand")');
  }
  await expect.poll(async () => (await inspect(page)).paused).toBe(false);
  await expect
    .poll(async () => (await inspect(page)).cats.every((c) => c.current === 'idle-stand:1'))
    .toBe(true);
  await sleep(500);
  await point(80, 80);
  await sleep(160);
  const clicks = await probe.evaluate<number>('window.clicks');
  mouseButton(true);
  mouseButton(false);
  await sleep(150);
  assert.equal(await probe.evaluate('window.clicks'), clicks + 1);
  assert.ok(extendedStyle(native) & 0x20);
  record('blank click reaches underlying real window');
  const cat = (await inspect(page)).cats[0];
  assert.ok(cat);
  // 生成器的站姿：落脚锚点(64,120)，身体中心(64,70)；腿缝(64,110)透明。
  await point(cat.x, cat.y - 10 * cat.scale);
  await sleep(160);
  const beforeHole = await probe.evaluate<number>('window.clicks');
  mouseButton(true);
  mouseButton(false);
  await sleep(150);
  assert.equal(await probe.evaluate('window.clicks'), beforeHole + 1);
  record('transparent leg gap passes through');
  await point(cat.x, cat.y - 50 * cat.scale);
  await expect.poll(() => extendedStyle(native) & 0x20).toBe(0);
  const focus = foregroundWindow();
  const before = await probe.evaluate<number>('window.clicks');
  mouseButton(true);
  await sleep(80);
  await point(cat.x + 250, cat.y - 200);
  await sleep(150);
  assert.equal((await inspect(page)).dragging, true);
  ctrl(true);
  await sleep(100);
  assert.equal((await inspect(page)).ghost, true);
  assert.equal((await inspect(page)).dragging, true);
  mouseButton(false);
  await sleep(120);
  assert.equal((await inspect(page)).dragging, false);
  assert.ok(extendedStyle(native) & 0x20);
  assert.equal(foregroundWindow(), focus);
  assert.equal(await probe.evaluate('window.clicks'), before);
  record('drag outside cat, Ctrl mid-drag, release and focus preserved');
  ctrl(false);
  await sleep(1000);
  assert.equal((await inspect(page)).ghost, true);
  await sleep(1200);
  assert.equal((await inspect(page)).ghost, false);
  record('Ctrl release retains ghost for two seconds');
  const moved = (await inspect(page)).cats[0];
  assert.ok(moved);
  await point(moved.x, moved.y - 50 * moved.scale);
  await expect.poll(() => extendedStyle(native) & 0x20).toBe(0);
  // 真实阻塞 renderer，main 的看门狗仍要在200ms内释放穿透。
  await page.evaluate(
    'setTimeout(() => { const until = performance.now() + 1000; while(performance.now() < until) {} }, 10)',
  );
  await sleep(35);
  await point(80, 80);
  const began = performance.now();
  while (!(extendedStyle(native) & 0x20) && performance.now() - began < 200) await sleep(5);
  assert.ok(extendedStyle(native) & 0x20);
  const recoveryMs = performance.now() - began;
  assert.ok(recoveryMs < 200);
  await sleep(1000);
  record('renderer stalled: main restores passthrough under 200ms');
  // 人为延迟所有未加载的 media fetch，检查旧片段不消失和过期加载不抢回画面。
  await page.route('ttcats-content://**/*', async (route) => {
    if (route.request().url().endsWith('.bin')) await sleep(250);
    await route.continue();
  });
  const id = (await inspect(page)).cats[0]?.cat;
  assert.ok(id);
  await main('globalThis.overlayFixture.clip(' + JSON.stringify(id) + ',"stand-to-sit")');
  await sleep(50);
  assert.ok((await inspect(page)).cats.every((c) => c.visible));
  await main('globalThis.overlayFixture.clip(' + JSON.stringify(id) + ',"idle-stand")');
  await sleep(600);
  await expect.poll(async () => (await inspect(page)).cats[0]?.current).toBe('idle-stand:1');
  await main('globalThis.overlayFixture.clip(' + JSON.stringify(id) + ',"idle-sit")');
  await expect.poll(async () => (await inspect(page)).cats[0]?.current).toBe('idle-sit:1');
  const time = (await inspect(page)).cats[0]?.videoTime;
  await sleep(300);
  assert.notEqual((await inspect(page)).cats[0]?.videoTime, time);
  record('cold clip retains old sprite; rapid interruptions keep playback alive');
  await page.unrouteAll({ behavior: 'wait' });
  for (const clip of ['sleep', 'walk', 'dangle', 'idle-stand']) {
    await main(
      'globalThis.overlayFixture.clip(' + JSON.stringify(id) + ',' + JSON.stringify(clip) + ')',
    );
    await expect.poll(async () => (await inspect(page)).cats[0]?.current).toBe(`${clip}:1`);
  }
  await expect.poll(async () => (await inspect(page)).cats[0]?.cache.length).toBe(3);
  record('per-cat cache bounded to current plus recent two');
  await page.evaluate(
    'window.overlayTestDecorations(' +
      JSON.stringify({
        bubbles: [{ cat: id, text: '喵', ageMs: 150 }],
        effects: [{ id: 1, effect: 'hearts', x: cat.x, y: cat.y - 100, ageMs: 150 }],
      }) +
      ')',
  );
  await sleep(150);
  const decorationSize = await page.evaluate<{
    width: number;
    height: number;
    text: string;
  }>(`(() => {
    const layer = window.overlayTest.app.stage.children.at(-1);
    const bubble = layer.children[0];
    window.overlayDecorationIdentity = [...layer.children];
    return { width: bubble.children[0].width, height: bubble.children[0].height, text: bubble.children[1].text };
  })()`);
  assert.equal(decorationSize.text, '喵');
  assert.ok(decorationSize.width > 16 && decorationSize.height > 12);
  await sleep(200);
  assert.ok(
    await page.evaluate(
      'window.overlayTest.app.stage.children.at(-1).children.every((child, index) => child === window.overlayDecorationIdentity[index])',
    ),
  );
  record('real Pixi bubble has sized backdrop; bubble and effect reuse objects');
  await page.screenshot({ path: join(evidence, 'overlay.png') });
  await main('globalThis.overlayFixture.captureProtection(false)');
  await sleep(250);
  assert.equal(foregroundWindow(), focus, 'Probe must cover work area during capture');
  const capture = await electron.evaluate(({ screen }) => {
    const display = screen.getPrimaryDisplay();
    return {
      width: Math.round(display.workArea.width * display.scaleFactor),
      height: Math.round(display.workArea.height * display.scaleFactor),
    };
  });
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-v',
      'error',
      '-f',
      'gdigrab',
      '-video_size',
      String(capture.width) + 'x' + String(capture.height),
      '-offset_x',
      '0',
      '-offset_y',
      '0',
      '-i',
      'desktop',
      '-frames:v',
      '1',
      join(evidence, 'composed.png'),
    ],
    { timeout: 15000 },
  );
  await main('globalThis.overlayFixture.captureProtection(true)');
  await page.evaluate('window.overlayTestDecorations({ bubbles: [], effects: [] })');
  await main('globalThis.overlayFixture.probe(true)');
  await expect.poll(async () => (await inspect(page)).paused, { timeout: 10000 }).toBe(true);
  const stopped = (await inspect(page)).drew;
  await sleep(500);
  assert.equal((await inspect(page)).drew, stopped);
  record('real foreground fullscreen pauses drawing');
  await main('globalThis.overlayFixture.closeProbe()');
  await expect.poll(async () => (await inspect(page)).paused).toBe(false);
  await main('globalThis.overlayFixture.rebuildMany()');
  page = await overlayPage();
  await waitReady(page);
  assert.equal(electron.windows().filter((p) => p.url().endsWith('/overlay/test.html')).length, 1);
  record('three queued rebuilds finish with one live overlay');
  assert.deepEqual((await inspect(page)).errors, []);
  assert.deepEqual(await electron.evaluate('globalThis.overlayFixture.problems'), []);
  const display = await electron.evaluate(({ screen }) => {
    const d = screen.getPrimaryDisplay();
    return { bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor };
  });
  writeFileSync(
    join(evidence, 'desktop-results.json'),
    JSON.stringify(
      { display, checks, recoveryMs, failures: 0, driver: 'test-only (#24 not merged)' },
      null,
      2,
    ) + '\n',
  );
}

interface Sample {
  phase: string;
  at: number;
  processes: { pid: number; cpu: number; privateMB: number; workingSetMB: number }[];
}
async function metric(electronApp: ElectronApplication, phase: string): Promise<Sample> {
  const processes = await electronApp.evaluate(({ app }) =>
    app.getAppMetrics().map((p) => ({
      pid: p.pid,
      cpu: p.cpu.percentCPUUsage,
      privateKB: p.memory.privateBytes,
      workingSetKB: p.memory.workingSetSize,
    })),
  );
  return {
    phase,
    at: Date.now(),
    processes: processes.map((p) => {
      assert.ok(p.privateKB !== undefined, 'privateBytes unavailable');
      return {
        pid: p.pid,
        cpu: p.cpu,
        privateMB: p.privateKB / 1024,
        workingSetMB: p.workingSetKB / 1024,
      };
    }),
  };
}
let pointerTimer: ReturnType<typeof setInterval> | undefined;
let pointerError: unknown;
let pointerMoves = 0;
let pointerEvents = 0;
try {
  const page = await overlayPage();
  await waitReady(page);
  if (verification) await verify(page);
  else {
    if (movingPointer) {
      setDpiAware();
      await main('globalThis.overlayFixture.probe(false)');
      const points = await electron.evaluate(({ screen }) => {
        const area = screen.getPrimaryDisplay().workArea;
        return [0.2, 0.8].map((x) =>
          screen.dipToScreenPoint({
            x: Math.round(area.x + area.width * x),
            y: area.y + area.height - 80,
          }),
        );
      });
      const from = points[0];
      const to = points[1];
      assert.ok(from && to);
      await page.evaluate(
        "window.overlayPerfPointerEvents = 0; window.addEventListener('mousemove', () => window.overlayPerfPointerEvents++);",
      );
      pointerTimer = setInterval(() => {
        if (pointerError) return;
        try {
          const step = pointerMoves++ % 240;
          const along = step <= 120 ? step / 120 : (240 - step) / 120;
          mouseMove(from.x + (to.x - from.x) * along, from.y);
        } catch (error) {
          pointerError = error;
        }
      }, 16);
    }
    const samples: Sample[] = [];
    const summaries: {
      phase: string;
      cpuAverage: number;
      cpuPeak: number;
      privateAverageMB: number;
      privatePeakMB: number;
      samples: number;
    }[] = [];
    const gpu = await electron.evaluate(({ app }) => app.getGPUInfo('complete'));
    for (const phase of movingPointer
      ? ['playing-moving-pointer']
      : ['playing', 'hidden', 'fullscreen']) {
      console.log('PHASE ' + phase + ': 15s warmup, ' + String(seconds) + 's measurement');
      if (phase === 'hidden') await main('globalThis.overlayFixture.hide(true)');
      if (phase === 'fullscreen') {
        await main('globalThis.overlayFixture.hide(false)');
        await main('globalThis.overlayFixture.probe(true)');
      }
      if (phase === 'hidden' || phase === 'fullscreen')
        await expect.poll(async () => (await inspect(page)).paused).toBe(true);
      await sleep(15000);
      assert.equal(pointerError, undefined);
      await metric(electron, phase); // prime interval after warmup
      const end = Date.now() + seconds * 1000;
      const phaseSamples: Sample[] = [];
      let lastExclusive = 0;
      while (Date.now() < end) {
        await sleep(1000);
        assert.equal(pointerError, undefined);
        if (Date.now() - lastExclusive >= 15000) {
          exclusivity();
          lastExclusive = Date.now();
        }
        const line = await metric(electron, phase);
        phaseSamples.push(line);
        samples.push(line);
      }
      const cpu = phaseSamples.map((s) => s.processes.reduce((sum, p) => sum + p.cpu, 0));
      const memory = phaseSamples.map((s) => s.processes.reduce((sum, p) => sum + p.privateMB, 0));
      const avg = (values: number[]): number =>
        values.reduce((sum, value) => sum + value, 0) / values.length;
      summaries.push({
        phase,
        cpuAverage: avg(cpu),
        cpuPeak: Math.max(...cpu),
        privateAverageMB: avg(memory),
        privatePeakMB: Math.max(...memory),
        samples: phaseSamples.length,
      });
      console.log(JSON.stringify(summaries.at(-1)));
    }
    exclusivity();
    if (movingPointer) {
      pointerEvents = await page.evaluate<number>('window.overlayPerfPointerEvents');
      assert.ok(pointerEvents > seconds * 10, 'Real pointer movement did not reach overlay');
    }
    const summary = {
      seconds,
      warmupSeconds: 15,
      exclusive: true,
      fps: 30,
      cats: 3,
      movingPointer,
      pointerMoves,
      pointerEvents,
      cpuMethod: 'Sum app.getAppMetrics percentCPUUsage for all processes; no extra division',
      memoryMethod: 'Sum privateBytes (KB) / 1024; all processes',
      gpu,
      display: await electron.evaluate(({ screen }) => {
        const d = screen.getPrimaryDisplay();
        return { bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor };
      }),
      summaries,
    };
    writeFileSync(
      join(results, movingPointer ? 'perf-moving-raw.json' : 'perf-raw.json'),
      JSON.stringify(samples),
    );
    writeFileSync(
      join(evidence, movingPointer ? 'perf-moving-summary.json' : 'perf-summary.json'),
      JSON.stringify(summary, null, 2) + '\n',
    );
    for (const s of summaries) {
      assert.ok(s.cpuAverage < 2, 'CPU average >= 2%');
      assert.ok(s.privatePeakMB < 700, 'private memory >= 700MB');
    }
  }
} finally {
  if (pointerTimer) clearInterval(pointerTimer);
  if (verification) {
    ctrl(false);
    mouseButton(false);
  }
  await electron.close();
}
