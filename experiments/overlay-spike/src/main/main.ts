// 桌面层小样的主进程。
//
// 命令行参数：
//   --control            开启本地控制通道（测试脚本用）
//   --layout=normal|test|demo
//   --mode=crossfade|hardcut|transition   默认衔接方式
//   --metrics-out=<文件> 每秒把 app.getAppMetrics() 写成一行 JSON
//   --no-hud             不显示左上角的调试信息
//   --bare               空白透明窗口（测基线开销）
//   --preload=all|lazy   片段预加载方式（默认 all）
//   --fps=N              画面最高刷新率（默认不限，跟显示器走）
//   --res=N              画布分辨率倍数（默认跟系统缩放一致，比如 1.5）
//   --cr=开关[=值]       追加 Chromium 命令行开关
//   --gpu=low-power|high-performance|default   WebGL 请求哪种显卡（默认 low-power）

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  net,
  powerMonitor,
  protocol,
  screen,
  Tray,
  type MenuItemConstructorOptions,
} from 'electron';
import { startControlServer } from '../shared/control';
import { circlePng } from '../shared/png';
import {
  INTERRUPT_MODE_LABEL,
  INTERRUPT_MODES,
  type CatInfo,
  type GpuPower,
  type Preload,
  type InterruptMode,
  type Layout,
  type LogEvent,
  type MouseDebug,
  type MainToRenderer,
  type OverlayState,
  type RendererToMain,
  type SwitchStats,
} from '../shared/protocol';
import {
  exStyle,
  hwndOf,
  isFullscreenState,
  isKeyDown,
  queryUserNotificationState,
  QUNS,
  VK,
} from '../shared/win32';

const ROOT = normalize(join(__dirname, '..'));
const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const LAYOUT = (arg('layout') ?? 'normal') as Layout;
let mode = (arg('mode') ?? 'crossfade') as InterruptMode;
const METRICS_OUT = arg('metrics-out');
const GPU_POWER = (arg('gpu') ?? 'low-power') as GpuPower;
const PRELOAD = (arg('preload') ?? 'all') as Preload;
const FPS_CAP = Number(arg('fps') ?? 0);
const RES = Number(arg('res') ?? 0);
// 双显卡笔记本上 Electron 默认会用独显（实测），要用核显必须加这个开关；WebGL 的 powerPreference 单独不起作用
if (GPU_POWER === 'low-power') app.commandLine.appendSwitch('force_low_power_gpu');
if (GPU_POWER === 'high-performance') app.commandLine.appendSwitch('force_high_performance_gpu');
const RESULTS_DIR = join(ROOT, 'results');

// 防卡死：鼠标不在猫身上、也没在拖动时，必须在 200ms 内恢复穿透。
// 渲染进程在猫身上时每 50ms 续一次"租约"，租约过期就强制恢复穿透（渲染进程卡死也能兜底）。
const HOVER_LEASE_MS = 120;
const WATCHDOG_MS = 20;
const GHOST_HOLD_MS = 2000;

app.setPath('userData', join(tmpdir(), 'ttcats-overlay-spike'));
// --cr=开关[=值]：额外的 Chromium 命令行开关（用来试验选哪块显卡）
for (const a of process.argv.filter((x) => x.startsWith('--cr='))) {
  const [k, v] = a.slice(5).split('=');
  app.commandLine.appendSwitch(k, v);
}
protocol.registerSchemesAsPrivileged([
  { scheme: 'spike', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let hwnd = 0;

const state = {
  ignoring: true,
  dragging: false,
  hoverLeaseUntil: 0,
  ctrlDown: false,
  ghostUntil: 0,
  ghost: false,
  protection: true,
  userHidden: false,
  fullscreenHidden: false,
  notificationState: 0,
  lbuttonUpSince: 0,
  cats: [] as CatInfo[],
  switchStats: null as SwitchStats | null,
  mouse: null as MouseDebug | null,
  hud: !flag('no-hud'),
  phase: 'startup',
};

// ---- 事件日志（测试脚本通过 /events 读取） ----
const events: LogEvent[] = [];
let seq = 0;
function log(type: string, data: Record<string, unknown> = {}): void {
  events.push({ seq: ++seq, t: Date.now(), type, ...data });
  if (events.length > 5000) events.splice(0, 1000);
}

function send<K extends keyof MainToRenderer>(channel: K, data: MainToRenderer[K]): void {
  win?.webContents.send(channel, data);
}

// ---- 需要存档的状态：按真实经过的时间结算（ADR-0004） ----
// 演示用的"饱腹"：每分钟下降 1 点，只由主进程根据 Date.now() 计算，从不按帧或按计时器次数累加。
const gameStart = Date.now();
const fullnessAt = (t: number): number => Math.max(0, 100 - (t - gameStart) / 60000);
let suspendedAt = 0;

function setIgnore(ignore: boolean, reason: string): void {
  if (!win || state.ignoring === ignore) return;
  state.ignoring = ignore;
  if (ignore) win.setIgnoreMouseEvents(true, { forward: true });
  else win.setIgnoreMouseEvents(false);
  log('ignore', { ignore, reason });
}

function applyVisibility(): void {
  if (!win) return;
  const visible = !state.userHidden && !state.fullscreenHidden;
  if (visible === win.isVisible()) return;
  if (visible) {
    win.showInactive();
    win.setAlwaysOnTop(true, 'screen-saver');
    setIgnore(true, 'show');
    send('paused', false);
  } else {
    send('paused', true);
    state.dragging = false;
    win.hide();
  }
  log('visibility', { visible, userHidden: state.userHidden, fullscreenHidden: state.fullscreenHidden });
}

function createWindow(): void {
  const display = screen.getPrimaryDisplay();
  const wa = display.workArea;
  win = new BrowserWindow({
    x: wa.x,
    y: wa.y,
    width: wa.width,
    height: wa.height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false, // Windows 上会加 WS_EX_NOACTIVATE：点猫不抢焦点
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      sandbox: false,
      contextIsolation: true,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true });
  win.setContentProtection(state.protection);
  hwnd = hwndOf(win.getNativeWindowHandle());
  // --bare：只开一个空白的透明全屏窗口（不加载 PixiJS、不播视频），用来测 Electron 本身的开销
  win.loadURL(flag('bare') ? 'data:text/html,<body style="background:transparent"></body>' : 'spike://app/dist/overlay.html');
  win.once('ready-to-show', () => {
    win?.showInactive();
    send('config', { layout: LAYOUT, mode, hud: state.hud, power: GPU_POWER, preload: PRELOAD, fps: FPS_CAP, res: RES });
    log('ready', { layout: LAYOUT, mode });
  });
  win.webContents.on('render-process-gone', (_e, d) => log('renderGone', { reason: d.reason }));
}

// ---- 渲染进程发来的消息 ----
function on<K extends keyof RendererToMain>(channel: K, fn: (data: RendererToMain[K]) => void): void {
  ipcMain.on(channel, (_e, data) => fn(data));
}

on('hover', (hit) => {
  // 渲染进程的鼠标位置可能是旧的（鼠标移出桌面层后收不到事件），以系统光标位置为准
  if (hit && !state.ghost && cursorInside()) {
    state.hoverLeaseUntil = Date.now() + HOVER_LEASE_MS;
    setIgnore(false, 'hover');
  } else if (!hit && !state.dragging) {
    state.hoverLeaseUntil = 0;
    setIgnore(true, 'leave');
  }
});
on('drag', (active) => {
  state.dragging = active;
  if (active) {
    state.lbuttonUpSince = 0;
    setIgnore(false, 'drag');
  } else {
    // 松手：如果鼠标还在猫身上，渲染进程会马上再发 hover；否则这里直接恢复穿透
    state.hoverLeaseUntil = 0;
    setIgnore(true, 'dragEnd');
  }
  log(active ? 'dragStart' : 'dragEnd');
});
on('cats', (d) => {
  state.cats = d.cats;
  state.switchStats = d.switchStats;
  state.mouse = d.mouse;
});
on('event', (e) => log(e.type, e));
on('hiddenReport', (r) => {
  log('hiddenReport', { ...r });
  appendResult('timing.jsonl', { t: Date.now(), phase: state.phase, ...r });
});

ipcMain.handle('readMask', (_e, name: string) => readFileSync(join(ROOT, 'assets', 'clips', name)));
ipcMain.handle('manifest', () => JSON.parse(readFileSync(join(ROOT, 'assets', 'clips', 'manifest.json'), 'utf8')));

function appendResult(file: string, obj: unknown): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  appendFileSync(join(RESULTS_DIR, file), JSON.stringify(obj) + '\n');
}

function cursorInside(): boolean {
  if (!win) return false;
  const p = screen.getCursorScreenPoint();
  const b = win.getBounds();
  return p.x >= b.x && p.y >= b.y && p.x < b.x + b.width && p.y < b.y + b.height;
}

// ---- 20ms 一次：Ctrl（幽灵模式）、左键状态、防卡死 ----
function watchdog(): void {
  if (!win) return;
  const now = Date.now();

  // 幽灵模式：按住 Ctrl 时猫半透明、鼠标穿过；松开后再保持 2 秒
  const ctrl = isKeyDown(VK.CONTROL);
  if (ctrl !== state.ctrlDown) {
    state.ctrlDown = ctrl;
    log('ctrl', { down: ctrl });
    if (!ctrl) state.ghostUntil = now + GHOST_HOLD_MS;
  }
  const ghost = ctrl || now < state.ghostUntil;
  if (ghost !== state.ghost) {
    state.ghost = ghost;
    send('ghost', ghost);
    log('ghost', { on: ghost });
  }
  // 已经在拖动的猫不会因为按下 Ctrl 被扔掉；松手后才进入穿透
  if (ghost && !state.dragging) setIgnore(true, 'ghost');

  // 拖动兜底：左键已经松开 60ms 以上，但渲染进程没报告松手（比如 pointerup 丢了）
  if (state.dragging) {
    if (!isKeyDown(VK.LBUTTON)) {
      if (!state.lbuttonUpSince) state.lbuttonUpSince = now;
      else if (now - state.lbuttonUpSince > 60) {
        state.dragging = false;
        send('dragCancel', true);
        setIgnore(true, 'dragWatchdog');
        log('dragWatchdog');
      }
    } else state.lbuttonUpSince = 0;
    return;
  }

  // 防卡死：租约过期就恢复穿透
  if (!state.ignoring && now > state.hoverLeaseUntil) setIgnore(true, 'leaseExpired');

  // 鼠标离开桌面层范围（比如移到任务栏）时，渲染进程收不到事件，这里直接恢复
  if (!state.ignoring) {
    if (!cursorInside()) setIgnore(true, 'cursorOutside');
  }
}

// ---- 500ms 一次：全屏检测 ----
function pollFullscreen(): void {
  const s = queryUserNotificationState();
  if (s !== state.notificationState) {
    log('notificationState', { state: s, name: QUNS[s] ?? '?' });
    state.notificationState = s;
  }
  const fs = isFullscreenState(s);
  if (fs !== state.fullscreenHidden) {
    state.fullscreenHidden = fs;
    applyVisibility();
  }
}

// ---- 性能采样 ----
function sampleMetrics(): void {
  if (!METRICS_OUT) return;
  const procs = app.getAppMetrics().map((m) => ({
    pid: m.pid,
    type: m.type,
    name: m.name,
    cpu: m.cpu.percentCPUUsage,
    ws: m.memory.workingSetSize,
    priv: m.memory.privateBytes,
  }));
  mkdirSync(dirname(METRICS_OUT), { recursive: true });
  appendFileSync(
    METRICS_OUT,
    JSON.stringify({ t: Date.now(), phase: state.phase, visible: win?.isVisible() ?? false, procs }) + '\n',
  );
}

function buildTray(): void {
  const icon = nativeImage.createFromBuffer(circlePng(32, [236, 170, 60]));
  tray = new Tray(icon);
  tray.setToolTip('TTCats 桌面层小样');
  const rebuild = (): void => {
    const template: MenuItemConstructorOptions[] = [
      ...INTERRUPT_MODES.map(
        (m): MenuItemConstructorOptions => ({
          label: `衔接方式：${INTERRUPT_MODE_LABEL[m]}`,
          type: 'radio',
          checked: m === mode,
          click: () => {
            mode = m;
            send('cmd', { type: 'mode', mode: m });
            log('mode', { mode: m });
          },
        }),
      ),
      { label: '打断全部猫', click: () => send('cmd', { type: 'interruptAll' }) },
      { type: 'separator' },
      {
        label: '截图里显示猫',
        type: 'checkbox',
        checked: !state.protection,
        click: (item) => setProtection(!item.checked),
      },
      {
        label: '隐藏全部猫',
        type: 'checkbox',
        checked: state.userHidden,
        click: (item) => {
          state.userHidden = item.checked;
          applyVisibility();
        },
      },
      {
        label: '显示调试信息',
        type: 'checkbox',
        checked: state.hud,
        click: (item) => {
          state.hud = item.checked;
          send('cmd', { type: 'hud', on: item.checked });
        },
      },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ];
    tray?.setContextMenu(Menu.buildFromTemplate(template));
  };
  rebuild();
}

function setProtection(on: boolean): void {
  state.protection = on;
  win?.setContentProtection(on);
  log('protection', { on });
}

function overlayState(): OverlayState {
  const d = screen.getPrimaryDisplay();
  return {
    pid: process.pid,
    hwnd,
    ignoring: state.ignoring,
    dragging: state.dragging,
    ghost: state.ghost,
    ctrlDown: state.ctrlDown,
    protection: state.protection,
    userHidden: state.userHidden,
    fullscreenHidden: state.fullscreenHidden,
    notificationState: state.notificationState,
    visible: win?.isVisible() ?? false,
    scaleFactor: d.scaleFactor,
    workArea: d.workArea,
    exStyle: hwnd ? exStyle(hwnd) : 0,
    cats: state.cats,
    switchStats: state.switchStats,
    mouse: state.mouse,
    fullness: fullnessAt(Date.now()),
    seq,
  };
}

async function startControl(): Promise<void> {
  await startControlServer({
    'GET /state': () => overlayState(),
    'GET /events': (_b, q) => events.filter((e) => e.seq > Number(q.get('since') ?? 0)),
    'GET /gpu': async () => ({
      info: await app.getGPUInfo('complete'),
      features: app.getGPUFeatureStatus(),
      versions: process.versions,
      cpus: cpus().length,
    }),
    'POST /cmd': (b) => {
      switch (b.type) {
        case 'protection':
          setProtection(Boolean(b.on));
          break;
        case 'hide':
          state.userHidden = Boolean(b.on);
          applyVisibility();
          break;
        case 'phase':
          state.phase = String(b.phase);
          log('phase', { phase: state.phase });
          break;
        case 'raise':
          win?.moveTop();
          break;
        case 'quit':
          setTimeout(() => app.quit(), 50);
          break;
        default:
          send('cmd', b as MainToRenderer['cmd']);
      }
      return { ok: true, seq };
    },
  });
}

app.whenReady().then(async () => {
  protocol.handle('spike', (req) => {
    const path = decodeURIComponent(new URL(req.url).pathname);
    const file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  createWindow();
  buildTray();
  if (flag('control')) await startControl();

  setInterval(watchdog, WATCHDOG_MS);
  setInterval(pollFullscreen, 500);
  setInterval(sampleMetrics, 1000);
  setInterval(() => send('snapshot', { fullness: fullnessAt(Date.now()), wallMs: Date.now() - gameStart }), 1000);

  powerMonitor.on('suspend', () => {
    suspendedAt = Date.now();
    log('suspend');
    appendResult('power-events.jsonl', { t: suspendedAt, type: 'suspend', fullness: fullnessAt(suspendedAt) });
  });
  powerMonitor.on('resume', () => {
    const t = Date.now();
    const sleptMs = suspendedAt ? t - suspendedAt : null;
    const rec = {
      t,
      type: 'resume',
      sleptMs,
      fullnessBefore: suspendedAt ? fullnessAt(suspendedAt) : null,
      fullnessAfter: fullnessAt(t),
      expectedDrop: sleptMs === null ? null : sleptMs / 60000,
    };
    log('resume', rec);
    appendResult('power-events.jsonl', rec);
  });
  for (const ev of ['lock-screen', 'unlock-screen'] as const) {
    powerMonitor.on(ev as 'lock-screen', () => {
      log(ev);
      appendResult('power-events.jsonl', { t: Date.now(), type: ev, fullness: fullnessAt(Date.now()) });
    });
  }
});

app.on('window-all-closed', () => app.quit());
