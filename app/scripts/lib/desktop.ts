// 真实桌面验收脚本（#29：交互测试、整应用性能）共用的小工具。
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron, type ElectronApplication, type Page } from '@playwright/test';
import { competitors } from './exclusivity';

export const appRoot = resolve(import.meta.dirname, '../..');

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** 等条件成立，返回用了多少毫秒；超时返回 null。 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
  stepMs = 10,
): Promise<number | null> {
  const start = Date.now();
  for (;;) {
    if (await condition()) return Date.now() - start;
    if (Date.now() - start >= timeoutMs) return null;
    await sleep(stepMs);
  }
}

/**
 * 独占检查：不能有别的会话在跑 Electron 或素材工厂（AGENTS.md"性能测试要独占机器"）。
 * 只放过 ownRoots（本轮自己启动的被测应用、探针窗口的主进程 PID）和它们的子进程；
 * 开测前不传，任何已经在跑的 Electron 都算竞争。查询失败也算不通过。
 */
export function exclusivity(ownRoots: number[] = []): void {
  const report = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath | ConvertTo-Json -Compress',
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  ).trim();
  const rows = (
    [] as {
      ProcessId: number;
      ParentProcessId: number;
      Name: string;
      ExecutablePath: string | null;
    }[]
  ).concat(
    JSON.parse(report) as {
      ProcessId: number;
      ParentProcessId: number;
      Name: string;
      ExecutablePath: string | null;
    }[],
  );
  const others = competitors(
    rows.map((r) => ({
      pid: r.ProcessId,
      parentPid: r.ParentProcessId,
      name: r.Name,
      path: r.ExecutablePath,
    })),
    ownRoots,
  );
  if (others.length > 0)
    throw new Error(
      `机器没有独占：还有别的 Electron 或素材工厂进程在运行（${others
        .map((p) => `${p.name}（PID ${p.pid}）${p.path ?? ''}`)
        .join('；')}）。请关掉其他会话或之前没关掉的测试程序后再测。`,
    );
}

/** Playwright 启动的 Electron 主进程 PID，给独占检查放行用。 */
export function processId(app: ElectronApplication): number {
  const pid = app.process().pid;
  if (pid === undefined) throw new Error('读不到被测程序的进程号');
  return pid;
}

function environment(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  // 必须加载构建好的文件，不能连到开发服务器。
  delete env['ELECTRON_RENDERER_URL'];
  delete env['ELECTRON_RUN_AS_NODE'];
  return { ...env, ...extra };
}

/**
 * 启动构建好的正式应用（先 npm run build），用测试猫咪包和一个临时存档目录，
 * 不碰用户自己的存档。
 */
export async function launchApp(): Promise<{ app: ElectronApplication; dataDirectory: string }> {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'ttcats-acceptance-'));
  const app = await _electron.launch({
    args: [appRoot, '--test-content'],
    env: environment({ TTCATS_TEST_APP_DATA: dataDirectory }),
    timeout: 30_000,
  });
  app.process().stderr?.on('data', (data: Buffer) => {
    const text = data.toString();
    // Chromium 的常见噪音不打印
    if (!/GPU cache|disk_cache|DevTools|Autofill|shared_image|gpu_process_host/.test(text))
      process.stderr.write(`[TTCats] ${text}`);
  });
  return { app, dataDirectory };
}

/** 启动探针窗口（独立进程）。fullscreen 时做成真正的全屏窗口，用来触发"全屏时隐藏"。 */
export async function launchProbe(fullscreen = false): Promise<{
  probe: ElectronApplication;
  page: Page;
  hwnd: number;
}> {
  const probe = await _electron.launch({
    args: [join(appRoot, 'e2e/interaction-probe.js')],
    env: environment(fullscreen ? { TTCATS_PROBE_FULLSCREEN: '1' } : {}),
    timeout: 30_000,
  });
  await waitFor(async () => probe.evaluate<boolean>('Boolean(globalThis.probe)'), 15_000, 50);
  const page = await probe.firstWindow();
  await page.waitForFunction('Array.isArray(window.events)');
  const hwnd = await probe.evaluate<number>('globalThis.probe.hwnd');
  return { probe, page, hwnd };
}

/** 正式应用的桌面层页面（等桥和画布都就绪）。 */
export async function overlayPage(app: ElectronApplication): Promise<Page> {
  let page: Page | undefined;
  await waitFor(
    () => {
      page = app.windows().find((p) => p.url().includes('/overlay/'));
      return page !== undefined;
    },
    30_000,
    50,
  );
  if (!page) throw new Error('找不到桌面层窗口');
  await page.waitForFunction('Boolean(window.ttcats && document.querySelector("canvas"))');
  return page;
}

/** 等桌面层窗口显示出来；前台有全屏程序（游戏、全屏视频）时桌面层会按设计隐藏，测试没法进行。 */
export async function waitOverlayVisible(app: ElectronApplication): Promise<void> {
  const visible = await waitFor(
    () =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some(
          (w) => w.webContents.getURL().includes('/overlay/') && w.isVisible(),
        ),
      ),
    15_000,
    100,
  );
  if (visible === null)
    throw new Error(
      '桌面层一直没有显示：前台可能有全屏程序（游戏、全屏视频、演示），TTCats 会按设计隐藏猫。请关掉或最小化全屏程序后再测。',
    );
}

/** 桌面层窗口的原生句柄。 */
export async function overlayHandle(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().includes('/overlay/'),
    );
    if (!window) throw new Error('找不到桌面层窗口');
    return Number(window.getNativeWindowHandle().readBigUInt64LE(0));
  });
}

export interface DisplayInfo {
  bounds: { x: number; y: number; width: number; height: number };
  workArea: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
}

export async function primaryDisplay(app: ElectronApplication): Promise<DisplayInfo> {
  return app.evaluate(({ screen }) => {
    const d = screen.getPrimaryDisplay();
    return { bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor };
  });
}

/** 显示配置的简短名字，用在结果文件名里，比如 2880x1800-150pct。 */
export function displayLabel(display: DisplayInfo): string {
  const s = display.scaleFactor;
  return `${Math.round(display.bounds.width * s)}x${Math.round(display.bounds.height * s)}-${Math.round(s * 100)}pct`;
}
