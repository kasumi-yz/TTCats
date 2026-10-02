// npm run interaction-test（在 app/ 里运行，先 npm run build）：M1 的真实桌面交互测试（#29）。
//
// 启动正式应用（测试猫咪包、临时存档目录），在猫下面放一个独立进程的"探针窗口"，
// 用 SendInput 发系统级鼠标键盘事件（和真人操作走同一条路），检查：
// 桌面层有没有接住该接住的点击、探针窗口有没有收到该收到的点击、焦点有没有被抢走、
// 防卡死是否在 200ms 内恢复鼠标穿透；以及 M1 的单击、撸猫、拎起放下、右键菜单。
//
// 每次点击前后都核对：光标还在脚本放的位置、Ctrl 没被别人按下、幽灵模式状态符合预期、
// 桌面层仍在探针窗口上面。任何一项不对都算"被打断"，这个场景自动重做（最多 3 次）。
//
// 运行期间会移动鼠标、点击、打字（约 10 分钟），请不要碰鼠标和键盘。
// 测试期间把地板纵深调到 2%，三只猫站在几乎同一条线上，方便摆出两只猫重叠。
// 参数：--skip-notepad  不做记事本那一项
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { Floor } from '../src/core/stage/floor';
import { createTestInput, VK, WS_EX, type MouseButton } from '../src/main/platform/win/test-input';
import {
  IPC_CHANNELS,
  type Fact,
  type StageDebugReport,
  type StateSnapshot,
} from '../src/shared/ipc';
import { zh } from '../src/shared/strings.zh-CN';
import {
  catBox,
  exclusivePoint,
  legGap,
  loadStandClip,
  maybeOnCat,
  pickPoint,
  sharedPoint,
  strokePoints,
  type Point,
  type StandClip,
  type StandingCat,
} from './lib/cat-geometry';
import {
  appRoot,
  displayLabel,
  exclusivity,
  launchApp,
  launchProbe,
  overlayHandle,
  overlayPage,
  primaryDisplay,
  sleep,
  waitFor,
  waitOverlayVisible,
  type DisplayInfo,
} from './lib/desktop';

const input = createTestInput();
const TEST_FLOOR_DEPTH = 0.02;
const HOVER_CLICK_REPEATS = 20;
// 记事本保存的 UTF-8 文件开头可能带 BOM
const BOM = new RegExp(`^${String.fromCharCode(0xfeff)}`);

interface Result {
  scenario: string;
  name: string;
  pass: boolean;
  detail: string;
  data?: unknown;
}
const results: Result[] = [];
const interferences: { scenario: string; attempt: number; reason: string }[] = [];
const lostClicks: unknown[] = [];

function record(
  scenario: string,
  name: string,
  pass: boolean,
  detail: string,
  data?: unknown,
): void {
  results.push({ scenario, name, pass, detail, ...(data === undefined ? {} : { data }) });
  console.log(`${pass ? '通过' : '失败'}  [${scenario}] ${name}：${detail}`);
}

/** 测试期间有人动了鼠标键盘、或者窗口顺序被别的程序打乱。 */
class Interference extends Error {}

type LoggedFact = Fact & { seq: number; t: number };
interface LoggedOverlay {
  seq: number;
  t: number;
  type: string;
  active?: boolean;
  onCat?: boolean;
  cat?: string;
}
interface MainLog {
  seq: number;
  facts: LoggedFact[];
  overlay: LoggedOverlay[];
  report?: StageDebugReport;
  /** 原生右键菜单弹出、关闭的次数（Electron 菜单的 menu-will-show / menu-will-close）。 */
  menus: { shown: number; closed: number };
}
interface OverlayLog {
  downs: { t: number; x: number; y: number; button: number }[];
  ghost: boolean;
}
interface ProbeEvent {
  t: number;
  type: string;
  x: number;
  y: number;
  ctrl: boolean;
  button: number;
}
interface Mark {
  seq: number;
  downs: number;
  probe: number;
  t: number;
}
/** 一次点击落到了哪里：猫的 id、探针窗口（probe）、被桌面层吃掉（swallowed）、哪里都没收到（lost）。 */
type Got = string;

/** 冻结后的一只猫。order 是它在桌面层的显示顺序（大的画在前面）。 */
type Cat = StandingCat & { order: number };

class Harness {
  S = 1;
  wa = { x: 0, y: 0, width: 0, height: 0 };
  display!: DisplayInfo;
  W = 0;
  H = 0;
  floor!: Floor;
  settings!: StateSnapshot['settings'];
  catOrder: string[] = [];
  shapes = new Map<string, StandClip>();
  purr = new Map<string, StandClip>();
  overlayHwnd = 0;
  /** 当前场景里，按住 Ctrl 是测试自己做的。 */
  private ctrlHeld = false;
  /** 当前应该是什么幽灵状态；undefined 表示正处在切换中，不检查。 */
  expectGhost: boolean | undefined = false;
  private expected: { x: number; y: number } | null = null;
  private dirty = '';
  scenarioName = '';

  constructor(
    readonly app: ElectronApplication,
    readonly overlay: Page,
    readonly probe: Page,
    readonly probeHwnd: number,
  ) {}

  // ---------- 读状态 ----------

  async mainLog(): Promise<MainLog> {
    return this.app.evaluate(
      () => (globalThis as unknown as { interactionLog: MainLog }).interactionLog,
    );
  }
  async overlayLog(): Promise<OverlayLog> {
    return this.overlay.evaluate<OverlayLog>('window.interaction');
  }
  async probeEvents(): Promise<ProbeEvent[]> {
    return this.probe.evaluate<ProbeEvent[]>('window.events');
  }
  transparent(): boolean {
    return (input.extendedStyle(this.overlayHwnd) & WS_EX.TRANSPARENT) !== 0;
  }
  async command(command: unknown): Promise<void> {
    await this.overlay.evaluate(`window.ttcats.sendCommand(${JSON.stringify(command)})`);
  }
  async enableStageDebug(): Promise<void> {
    await this.app.evaluate(({ BrowserWindow }, channel) => {
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().includes('/overlay/'))
        ?.webContents.send(channel, { type: 'stageDebug', enabled: true });
    }, IPC_CHANNELS.mainToOverlay);
  }

  // ---------- 坐标 ----------

  phys(p: Point): Point {
    return { x: Math.round((p.x + this.wa.x) * this.S), y: Math.round((p.y + this.wa.y) * this.S) };
  }
  screenDip(p: Point): Point {
    return { x: p.x + this.wa.x, y: p.y + this.wa.y };
  }
  /** 桌面层下面、离猫很远的空白处（探针窗口里）。 */
  get EMPTY(): Point {
    return { x: Math.round(this.W * 0.5), y: Math.round(this.H * 0.3) };
  }
  get EMPTY2(): Point {
    return { x: Math.round(this.W * 0.8), y: Math.round(this.H * 0.45) };
  }
  /** 桌面层外面：任务栏（工作区下方）。没有任务栏时退回工作区最底下一行。 */
  get OUTSIDE(): Point {
    const below = this.display.bounds.height - this.wa.height - this.wa.y;
    return {
      x: Math.round(this.W * 0.35),
      y: below > 2 ? this.H + Math.floor(below / 2) : this.H - 1,
    };
  }

  // ---------- 干扰检查 ----------

  private fail(reason: string): never {
    this.dirty ||= reason;
    throw new Interference(reason);
  }
  /** 光标还在脚本放的位置、Ctrl 只在测试自己按着时按下、桌面层仍在探针窗口上面。 */
  check(): void {
    if (this.expected) {
      const c = input.cursorPos();
      if (Math.abs(c.x - this.expected.x) > 2 || Math.abs(c.y - this.expected.y) > 2)
        this.fail(
          `光标在 ${c.x},${c.y}，应该在 ${this.expected.x},${this.expected.y}（有人动了鼠标）`,
        );
    }
    if (input.isKeyDown(VK.CONTROL) !== this.ctrlHeld)
      this.fail(this.ctrlHeld ? 'Ctrl 被松开了' : 'Ctrl 被按下了（有人按了键盘）');
    if ((input.extendedStyle(this.overlayHwnd) & WS_EX.TOPMOST) === 0)
      this.fail('桌面层不再是置顶窗口');
    if (!input.isAbove(this.overlayHwnd, this.probeHwnd))
      this.fail('探针窗口跑到了桌面层上面（窗口顺序被打乱）');
  }
  /** 在 check() 之外再核对幽灵模式（要读桌面层页面，所以是异步的）。 */
  async checkAll(): Promise<void> {
    this.check();
    if (this.expectGhost !== undefined) {
      const ghost = (await this.overlayLog()).ghost;
      if (ghost !== this.expectGhost)
        this.fail(`幽灵模式是 ${ghost ? '开' : '关'}，应该是 ${this.expectGhost ? '开' : '关'}`);
    }
  }

  // ---------- 输入 ----------

  moveTo(p: Point): void {
    this.check();
    const q = this.phys(p);
    input.mouseMove(q.x, q.y);
    this.expected = q;
  }
  down(button: MouseButton = 'primary'): void {
    this.check();
    input.mouseButton(true, button);
  }
  up(button: MouseButton = 'primary'): void {
    this.check();
    input.mouseButton(false, button);
  }
  ctrl(down: boolean): void {
    input.key(VK.LCONTROL, down);
    this.ctrlHeld = down;
  }
  async click(p: Point, holdMs = 30, button: MouseButton = 'primary'): Promise<void> {
    this.moveTo(p);
    this.down(button);
    await sleep(holdMs);
    this.up(button);
  }
  async sleep(ms: number): Promise<void> {
    await sleep(ms);
    this.check();
  }
  async type(text: string): Promise<void> {
    this.check();
    input.typeText(text);
    await sleep(50);
  }

  // ---------- 点击落到哪里 ----------

  async mark(): Promise<Mark> {
    const [main, overlay, probe] = await Promise.all([
      this.mainLog(),
      this.overlayLog(),
      this.probeEvents(),
    ]);
    return { seq: main.seq, downs: overlay.downs.length, probe: probe.length, t: Date.now() };
  }
  async factsSince(m: Mark): Promise<LoggedFact[]> {
    return (await this.mainLog()).facts.filter((f) => f.seq > m.seq);
  }
  async overlaySince(m: Mark): Promise<LoggedOverlay[]> {
    return (await this.mainLog()).overlay.filter((o) => o.seq > m.seq);
  }
  async probeSince(m: Mark): Promise<ProbeEvent[]> {
    return (await this.probeEvents()).slice(m.probe);
  }

  async whoGot(m: Mark, p: Point): Promise<Got> {
    await sleep(150);
    await this.checkAll();
    const fact = (await this.factsSince(m)).find(
      (f) => f.type === 'cat/poked' || f.type === 'cat/pickedUp',
    );
    if (fact) return fact.cat;
    const downs = (await this.overlayLog()).downs.slice(m.downs);
    if (downs.length > 0) return 'swallowed';
    const sp = this.screenDip(p);
    const probe = await this.probeSince(m);
    if (
      probe.some(
        (e) => e.type === 'mousedown' && Math.abs(e.x - sp.x) <= 3 && Math.abs(e.y - sp.y) <= 3,
      )
    )
      return 'probe';
    lostClicks.push({ scenario: this.scenarioName, at: p, overlayDowns: downs, probe });
    return 'lost';
  }

  /** 鼠标回到空白处，等桌面层恢复穿透、没有拖动、不在幽灵模式。 */
  async settle(): Promise<void> {
    this.moveTo(this.EMPTY);
    await waitFor(async () => this.transparent() && !(await this.overlayLog()).ghost, 4000);
    await this.sleep(80);
  }

  // ---------- 猫的位置 ----------

  /** 根据画面报告，算出每只猫的落脚点、缩放和显示顺序。 */
  cats(report: StageDebugReport): Record<string, Cat> {
    const out: Record<string, Cat> = {};
    const entries = report.cats.map((c, index) => {
      const shape = this.shapes.get(c.cat);
      if (!shape) throw new Error(`没有 ${c.cat} 的站立片段`);
      const d = this.floor.depthAtY(c.y) ?? 0;
      return { c, shape, d, index };
    });
    // 和 core/stage 一样：离得远的先画，一样远时按显示顺序
    const sorted = [...entries].sort((a, b) => a.d - b.d || a.index - b.index);
    for (const { c, shape, d } of entries)
      out[c.cat] = {
        id: c.cat,
        x: c.x,
        y: c.y,
        scale: this.settings.scale * shape.relativeSize * this.floor.depthScale(d),
        clip: shape.clip,
        mask: shape.mask,
        order: sorted.findIndex((e) => e.c.cat === c.cat),
      };
    return out;
  }

  /**
   * 让三只猫都在原地播"站着"的循环片段（调试命令，保持 6 秒），等画面报告确认，返回它们的位置。
   * 猫在空中（刚被放下、正在下落）时调试命令不生效，所以每秒重发一次。
   */
  async freeze(): Promise<Record<string, Cat>> {
    const wanted = zh.stage.behaviors.debugClip('idle-stand');
    let sentAt = 0;
    let report: StageDebugReport | undefined;
    const ok = await waitFor(
      async () => {
        if (Date.now() - sentAt > 1000) {
          await this.enableStageDebug();
          sentAt = Date.now();
          for (const id of this.catOrder)
            await this.command({ type: 'debug/playClip', cat: id, clip: 'idle-stand' });
        }
        report = (await this.mainLog()).report;
        return (
          report !== undefined &&
          report.at > sentAt + 50 &&
          report.cats.length === this.catOrder.length &&
          report.cats.every(
            (c) =>
              c.clip === 'idle-stand' &&
              c.behavior === wanted &&
              Math.abs(c.y - this.floor.yAt(this.floor.depthAtY(c.y) ?? 0)) < 0.5,
          )
        );
      },
      10_000,
      50,
    );
    if (ok === null || !report)
      throw new Error(
        `10 秒内没能让三只猫停下来站好；最后的画面报告：${JSON.stringify(report)}，地板 ${this.floor.farY}～${this.floor.nearY}`,
      );
    // 等新片段的画面换上（点击判定用的是当前显示的画面）
    await sleep(250);
    return this.cats(report);
  }

  /** 用真实鼠标把猫拖到 to（按下点 → 松手点），然后等它落地。 */
  async dragCat(from: Point, to: Point): Promise<void> {
    this.moveTo(from);
    await this.sleep(120);
    this.down();
    await this.sleep(40);
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      this.moveTo({
        x: from.x + ((to.x - from.x) * i) / steps,
        y: from.y + ((to.y - from.y) * i) / steps,
      });
      await this.sleep(25);
    }
    await this.sleep(40);
    this.up();
    await this.sleep(100);
    await this.settle();
  }

  /** 摆位置：A 单独在左边；B、C 在右边重叠，C 画在 B 前面。 */
  roles(cats: Record<string, Cat>): { A: Cat; B: Cat; C: Cat } {
    const [a, b, c] = this.catOrder.map((id) => cats[id]);
    if (!a || !b || !c) throw new Error('需要 3 只测试猫');
    const [B, C] = b.order < c.order ? [b, c] : [c, b];
    return { A: a, B, C };
  }
  /** spread：三只猫分开站；final：C 挪到 B 旁边，和 B 重叠一部分。 */
  targets(cats: Record<string, Cat>, stage: 'spread' | 'final' = 'final'): Record<string, number> {
    const { A, B, C } = this.roles(cats);
    const half = (cat: Cat): number => ((catBox(cat).x1 - catBox(cat).x0) / 2) * 0.55;
    const bx = this.W * 0.62;
    return {
      [A.id]: this.W * 0.22,
      [B.id]: bx,
      [C.id]: stage === 'spread' ? this.W * 0.85 : bx + 0.6 * (half(B) + half(C)),
    };
  }

  /** 用真实鼠标拖猫摆位置。先分开（谁被盖住就先挪开盖住它的猫），再让 C 和 B 重叠。 */
  async arrange(): Promise<Record<string, Cat>> {
    let cats = await this.freeze();
    for (const stage of ['spread', 'final'] as const) {
      for (let pass = 0; pass < 4; pass++) {
        const targets = this.targets(cats, stage);
        let moved = false;
        for (const id of this.catOrder) {
          const cat = cats[id];
          const target = targets[id];
          if (!cat || target === undefined || Math.abs(cat.x - target) <= 4) continue;
          const grab = exclusivePoint(
            cat,
            Object.values(cats).filter((o) => o.id !== id),
          );
          if (!grab) continue; // 被别的猫盖住了，等别的猫挪开再拖
          await this.dragCat(grab, { x: grab.x + (target - cat.x), y: grab.y });
          moved = true;
          cats = await this.freeze();
        }
        if (!moved) break;
      }
    }
    const targets = this.targets(cats);
    for (const cat of Object.values(cats))
      if (Math.abs(cat.x - (targets[cat.id] ?? cat.x)) > 6)
        throw new Error(`没能把 ${cat.id} 摆到 x=${targets[cat.id]}（现在 ${cat.x}）`);
    return cats;
  }

  /** 跑一个场景；中途被打断就丢掉这次的结果重做。 */
  async scenario(name: string, fn: () => Promise<void>): Promise<void> {
    this.scenarioName = name;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const before = results.length;
      this.dirty = '';
      try {
        this.release();
        await sleep(2300); // 等幽灵模式的 2 秒保持期过去
        this.expectGhost = false;
        await this.settle();
        await fn();
        if (!this.dirty) return;
      } catch (error) {
        if (!(error instanceof Interference)) throw error;
      }
      interferences.push({ scenario: name, attempt, reason: this.dirty });
      results.splice(before);
      console.warn(`[${name}] 被打断（${this.dirty}），第 ${attempt} 次重做……`);
      await sleep(2000);
    }
    record(name, '（整个场景）', false, '连续 3 次被打断，没有结果');
  }

  /** 松开测试可能按着的键和鼠标，回到空白处。 */
  release(): void {
    if (this.ctrlHeld || input.isKeyDown(VK.CONTROL)) input.key(VK.LCONTROL, false);
    this.ctrlHeld = false;
    input.mouseButton(false);
    const q = this.phys(this.EMPTY);
    input.mouseMove(q.x, q.y);
    this.expected = q;
  }

  /** 原地的期望位置：被放下的猫在 x 方向跟着鼠标走，再收回地板范围里。 */
  expectedDropX(cat: Cat, dx: number): number {
    return this.floor.clampX(cat.x + dx, this.shapes.get(cat.id)?.relativeSize ?? 1);
  }
  /** 测试兜底：关掉还开着的右键菜单。 */
  async closeMenu(): Promise<void> {
    await this.app.evaluate(() => {
      (globalThis as unknown as { interactionMenu?: Electron.Menu }).interactionMenu?.closePopup();
    });
    await sleep(200);
  }
  async reportOf(id: string): Promise<StageDebugReport['cats'][number] | undefined> {
    return (await this.mainLog()).report?.cats.find((c) => c.cat === id);
  }
}

function point(cat: Cat, others: Cat[]): Point {
  const p = exclusivePoint(cat, others);
  if (!p) throw new Error(`${cat.id} 身上找不到不和别的猫重叠的点`);
  return p;
}

async function main(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('交互测试只能在 Windows 桌面上运行');
  if (!input.setDpiAware()) console.warn('设置 DPI 感知失败，坐标可能不准');
  exclusivity();
  const dryRun = process.argv.includes('--dry-run');
  if (!dryRun) {
    console.log('即将开始真实桌面交互测试（约 10 分钟）：请不要碰鼠标和键盘。5 秒后开始……');
    await sleep(5000);
  }

  // 试运行不开探针窗口、不动鼠标键盘，只检查启动、冻结猫和找点击位置
  const probeLaunch = dryRun ? undefined : await launchProbe();
  const { app } = await launchApp();
  const probe = probeLaunch?.probe;
  const notepadFiles: string[] = [];
  try {
    await app.evaluate(
      ({ ipcMain, Menu }, channels) => {
        const log = {
          menus: { shown: 0, closed: 0 },
          seq: 0,
          facts: [] as unknown[],
          overlay: [] as unknown[],
          report: undefined as unknown,
          hover: undefined as unknown,
        };
        ipcMain.on(channels.fact, (_event, fact: object) => {
          log.facts.push({ ...fact, seq: ++log.seq, t: Date.now() });
        });
        ipcMain.on(
          channels.overlayToMain,
          (_event, message: { type: string; onCat?: boolean; report?: unknown }) => {
            if (message.type === 'stageDebug') {
              log.report = message.report;
              return;
            }
            if (message.type === 'hover') {
              if (message.onCat === log.hover) return;
              log.hover = message.onCat;
            }
            log.overlay.push({ ...message, seq: ++log.seq, t: Date.now() });
          },
        );
        // 只旁听原生菜单的显示和关闭，照常调用正式的 popup
        // eslint-disable-next-line @typescript-eslint/unbound-method -- 下面用 call 绑回原来的菜单对象
        const popup = Menu.prototype.popup;
        Menu.prototype.popup = function (options) {
          this.once('menu-will-show', () => log.menus.shown++);
          this.once('menu-will-close', () => log.menus.closed++);
          Object.assign(globalThis, { interactionMenu: this });
          popup.call(this, options);
        };
        Object.assign(globalThis, { interactionLog: log });
      },
      { fact: IPC_CHANNELS.fact, overlayToMain: IPC_CHANNELS.overlayToMain },
    );
    const overlay = await overlayPage(app);
    await waitOverlayVisible(app);
    await overlay.evaluate(`(() => {
      window.interaction = { downs: [], ghost: false };
      window.ttcats.onOverlay((m) => { if (m.type === 'ghost') window.interaction.ghost = m.active; });
      window.addEventListener('pointerdown', (e) => {
        window.interaction.downs.push({ t: Date.now(), x: e.clientX, y: e.clientY, button: e.button });
      }, true);
    })()`);
    const probePage = probeLaunch?.page ?? overlay;
    const probeHwnd = probeLaunch?.hwnd ?? 0;
    const h = new Harness(app, overlay, probePage, probeHwnd);
    h.overlayHwnd = await overlayHandle(app);
    h.display = await primaryDisplay(app);
    h.S = h.display.scaleFactor;
    h.wa = h.display.workArea;
    const size = await overlay.evaluate<{ w: number; h: number }>(
      '({ w: innerWidth, h: innerHeight })',
    );
    h.W = size.w;
    h.H = size.h;
    const catalog = await overlay.evaluate<{ cats: Record<string, unknown> }>(
      'window.ttcats.getContent()',
    );
    for (const id of Object.keys(catalog.cats)) {
      h.shapes.set(id, loadStandClip(join(appRoot, 'test-content'), id));
      h.purr.set(id, loadStandClip(join(appRoot, 'test-content'), id, 'purr'));
    }
    await h.command({ type: 'settings/update', patch: { floorDepth: TEST_FLOOR_DEPTH } });
    const ready = await waitFor(
      async () => {
        const s = await overlay.evaluate<StateSnapshot>('window.ttcats.getSnapshot()');
        h.settings = s.settings;
        return s.settings.floorDepth === TEST_FLOOR_DEPTH && s.settings.visibleCats.length === 3;
      },
      5000,
      50,
    );
    if (ready === null) throw new Error('应用没有按测试猫咪包显示 3 只猫');
    h.catOrder = [...h.settings.visibleCats];
    h.floor = new Floor({
      bounds: { width: h.W, height: h.H },
      scale: h.settings.scale,
      floorDepth: h.settings.floorDepth,
    });
    const versions = await app.evaluate(() => ({
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    }));
    console.log(
      `显示配置 ${displayLabel(h.display)}，工作区 ${h.wa.width}x${h.wa.height}（DIP），桌面层 ${h.W}x${h.H}`,
    );

    if (dryRun) {
      const frozen = await h.freeze();
      const all = Object.values(frozen);
      for (const cat of all) {
        const others = all.filter((o) => o.id !== cat.id);
        console.log(
          `${cat.id}：落脚点 (${cat.x.toFixed(1)}, ${cat.y.toFixed(1)})，缩放 ${cat.scale.toFixed(3)}，显示顺序 ${cat.order}，` +
            `身上的点 ${JSON.stringify(exclusivePoint(cat, others))}，两腿之间 ${JSON.stringify(legGap(cat, all))}`,
        );
      }
      console.log(
        `空白处 ${JSON.stringify(h.EMPTY)}、${JSON.stringify(h.EMPTY2)}，任务栏 ${JSON.stringify(h.OUTSIDE)}`,
      );
      console.log('试运行完成：没有移动鼠标，也没有测试点击。');
      return;
    }

    await h.scenario('准备', async () => {
      // 点一下探针窗口的空白处，让它成为前台窗口
      await h.click(h.EMPTY);
      await h.sleep(300);
      record(
        '准备',
        '探针窗口成为前台',
        input.foregroundWindow() === probeHwnd,
        `前台窗口：${input.windowText(input.foregroundWindow())}`,
      );
    });

    // 先把猫摆好：A 单独在左边，B、C 在右边重叠
    let cats = await h.arrange();
    const roles = h.roles(cats);
    console.log(`猫：A=${roles.A.id}，B（后）=${roles.B.id}，C（前）=${roles.C.id}`);
    const A = async (): Promise<{ cat: Cat; others: Cat[] }> => {
      cats = await h.freeze();
      const cat = cats[roles.A.id];
      if (!cat) throw new Error('A 不见了');
      return { cat, others: Object.values(cats).filter((c) => c.id !== cat.id) };
    };
    const ensureLayout = async (): Promise<void> => {
      cats = await h.freeze();
      const targets = h.targets(cats);
      if (Object.values(cats).some((c) => Math.abs(c.x - (targets[c.id] ?? c.x)) > 6))
        cats = await h.arrange();
    };

    // ===== 基础 =====
    await h.scenario('基础', async () => {
      const style = input.extendedStyle(h.overlayHwnd);
      record(
        '基础',
        '窗口样式',
        (style & WS_EX.NOACTIVATE) !== 0 &&
          (style & WS_EX.TOPMOST) !== 0 &&
          (style & WS_EX.TRANSPARENT) !== 0,
        `不抢焦点 WS_EX_NOACTIVATE=${(style & WS_EX.NOACTIVATE) !== 0}，置顶 TOPMOST=${(style & WS_EX.TOPMOST) !== 0}，默认穿透 TRANSPARENT=${(style & WS_EX.TRANSPARENT) !== 0}`,
      );
      let m = await h.mark();
      await h.click(h.EMPTY2);
      let got = await h.whoGot(m, h.EMPTY2);
      record('基础', '点空白处', got === 'probe', `点击落到：${got}`);

      await ensureLayout();
      const { cat, others } = await A();
      const core = point(cat, others);
      await h.settle();
      h.moveTo(core);
      const t = await waitFor(() => !h.transparent(), 1000, 2);
      record('基础', '鼠标移到猫身上后关闭穿透', t !== null && t <= 50, `用时 ${t}ms`);

      await h.settle();
      const gap = legGap(cat, Object.values(cats));
      if (!gap)
        record('基础', '点猫的包围框内的透明处（两腿之间）', false, '没找到两腿之间的测试点');
      else {
        h.moveTo(gap);
        await h.sleep(150);
        m = await h.mark();
        await h.click(gap);
        got = await h.whoGot(m, gap);
        record('基础', '点猫的包围框内的透明处（两腿之间）', got === 'probe', `点击落到：${got}`);
      }
    });

    // PR #44 审查：悬停后点猫重复多次，点到猫下面的窗口哪怕一次也要测出来
    await h.scenario('悬停后点猫', async () => {
      const tally: Record<string, number> = {};
      const misses: unknown[] = [];
      for (let i = 0; i < HOVER_CLICK_REPEATS; i++) {
        const { cat, others } = await A();
        const core = point(cat, others);
        await h.settle();
        h.moveTo(core);
        const t = await waitFor(() => !h.transparent(), 1000, 2);
        await h.sleep(50);
        await h.checkAll();
        const m = await h.mark();
        await h.click(core);
        const got = await h.whoGot(m, core);
        tally[got] = (tally[got] ?? 0) + 1;
        if (got !== cat.id) misses.push({ i, got, closeMs: t, at: core });
      }
      const hits = tally[roles.A.id] ?? 0;
      record(
        '悬停后点猫',
        `悬停后点猫 ${HOVER_CLICK_REPEATS} 次`,
        hits === HOVER_CLICK_REPEATS,
        `${hits}/${HOVER_CLICK_REPEATS} 次由猫接住；${JSON.stringify(tally)}；每次点击前后都核对了光标、Ctrl、幽灵模式、窗口顺序`,
        { tally, misses },
      );
    });

    // ===== 鼠标快速移到猫身上，马上点击 =====
    await h.scenario('快速移到猫身上马上点', async () => {
      const delays = [0, 5, 10, 20, 35, 50, 80, 120];
      const table: Record<number, Record<string, number>> = {};
      for (const d of delays) {
        const row: Record<string, number> = {};
        table[d] = row;
        for (let i = 0; i < 5; i++) {
          const { cat, others } = await A();
          const core = point(cat, others);
          await h.settle();
          const m = await h.mark();
          h.moveTo(core);
          if (d) await h.sleep(d);
          h.down();
          await h.sleep(30);
          h.up();
          const got = await h.whoGot(m, core);
          const key = got === cat.id ? 'cat' : got;
          row[key] = (row[key] ?? 0) + 1;
        }
      }
      const ok = (d: number): boolean => table[d]?.['cat'] === 5;
      const minReliable = delays.find((d) => delays.filter((x) => x >= d).every(ok));
      const lost = delays.reduce(
        (s, d) => s + (table[d]?.['lost'] ?? 0) + (table[d]?.['swallowed'] ?? 0),
        0,
      );
      record(
        '快速移到猫身上马上点',
        '移动后隔多久点击才一定能点中猫',
        minReliable !== undefined && minReliable <= 20,
        `隔 ${minReliable ?? '>120'}ms 及以上 5/5 点中；全部 40 次里有 ${lost} 次点击丢失或被吃掉`,
        table,
      );
    });

    await h.scenario('快速移到猫身上马上点', async () => {
      // 反方向：鼠标刚离开猫就点旁边的空白处，点击会不会被桌面层吃掉
      const delays = [0, 5, 10, 20, 50];
      const table: Record<number, Record<string, number>> = {};
      for (const d of delays) {
        const row: Record<string, number> = {};
        table[d] = row;
        for (let i = 0; i < 5; i++) {
          const { cat, others } = await A();
          const core = point(cat, others);
          const box = catBox(cat);
          const target = pickPoint(
            { x0: box.x1 + 30, x1: box.x1 + 60, y0: core.y - 10, y1: core.y + 10 },
            (p) => Object.values(cats).every((o) => !maybeOnCat(o, p)),
          );
          if (!target) throw new Error('猫旁边找不到空白处');
          await h.settle();
          h.moveTo(core);
          await waitFor(() => !h.transparent(), 500, 2);
          await h.sleep(60);
          const m = await h.mark();
          h.moveTo(target);
          if (d) await h.sleep(d);
          h.down();
          await h.sleep(30);
          h.up();
          const got = await h.whoGot(m, target);
          const key = got.startsWith('test-') ? 'cat' : got;
          row[key] = (row[key] ?? 0) + 1;
        }
      }
      const bad = delays.reduce(
        (s, d) => s + (table[d]?.['swallowed'] ?? 0) + (table[d]?.['lost'] ?? 0),
        0,
      );
      const minOk = delays.find((d) =>
        delays.filter((x) => x >= d).every((x) => table[x]?.['probe'] === 5),
      );
      record(
        '快速移到猫身上马上点',
        '鼠标刚离开猫就点旁边的空白处',
        minOk !== undefined && minOk <= 20,
        `隔 ${minOk ?? '>50'}ms 及以上 5/5 落到下面的窗口；共 ${bad}/25 次被桌面层吃掉或丢失`,
        table,
      );
    });

    // ===== 拖动时鼠标移出猫的范围 =====
    await h.scenario('拖动时鼠标移出猫的范围', async () => {
      await ensureLayout();
      const { cat: a, others } = await A();
      const grab = point(a, others);
      const release: Point = { x: Math.round(h.W * 0.45), y: Math.round(h.H * 0.6) };
      const m = await h.mark();
      h.moveTo(grab);
      await h.sleep(120);
      h.down();
      await h.sleep(40);
      // 一下子甩出去很远（远超猫的范围），中间再绕到桌面层外面（任务栏）
      const path: Point[] = [
        { x: grab.x + 30, y: grab.y },
        { x: grab.x + 400, y: grab.y - 250 },
        h.OUTSIDE,
        release,
      ];
      for (const p of path) {
        h.moveTo(p);
        await h.sleep(25);
      }
      await h.sleep(60);
      const mid = await h.overlaySince(m);
      const midDragging = mid.filter((o) => o.type === 'drag').at(-1)?.active === true;
      const releasedAt = Date.now();
      h.up();
      await h.sleep(150);
      const facts = await h.factsSince(m);
      const picked = facts.some((f) => f.type === 'cat/pickedUp' && f.cat === a.id);
      const dropped = facts.some(
        (f) => f.type === 'cat/dropped' && f.cat === a.id && f.t >= releasedAt,
      );
      const probeEvents = await h.probeSince(m);
      h.moveTo(h.EMPTY);
      const t = await waitFor(() => h.transparent(), 1000, 2);
      cats = await h.freeze();
      const now = cats[a.id];
      const expectedX = h.expectedDropX(a, release.x - grab.x);
      const followed = now !== undefined && Math.abs(now.x - expectedX) < 3;
      record(
        '拖动时鼠标移出猫的范围',
        '整个拖动过程由桌面层接收',
        midDragging && picked && dropped && followed && probeEvents.length === 0,
        `拖动中=${midDragging}，拎起=${picked}，松手时放下=${dropped}，猫落在松手位置=${followed}（x=${now?.x.toFixed(1)}，应为 ${expectedX.toFixed(1)}），下面的窗口收到 ${probeEvents.length} 个鼠标事件`,
      );
      record(
        '拖动时鼠标移出猫的范围',
        '松手后离开猫，恢复穿透',
        t !== null && t <= 200,
        `用时 ${t}ms`,
      );
      const m2 = await h.mark();
      await h.click(h.EMPTY);
      const got = await h.whoGot(m2, h.EMPTY);
      record('拖动时鼠标移出猫的范围', '之后点空白处', got === 'probe', `点击落到：${got}`);
    });

    // ===== 按住 Ctrl 拖动 =====
    await h.scenario('按住 Ctrl 拖动', async () => {
      // (a) 先按住 Ctrl 再去拖猫：鼠标应该穿过猫，下面的窗口收到带 Ctrl 的拖动
      await ensureLayout();
      const { cat: a, others } = await A();
      const core = point(a, others);
      let m = await h.mark();
      h.expectGhost = undefined;
      h.ctrl(true);
      await h.sleep(100);
      const ghostOn = (await h.overlayLog()).ghost;
      h.expectGhost = true;
      h.moveTo(core);
      await h.sleep(100);
      const passOverCat = h.transparent();
      h.down();
      await h.sleep(30);
      h.moveTo({ x: core.x + 150, y: core.y });
      await h.sleep(30);
      h.up();
      await h.sleep(50);
      h.expectGhost = undefined;
      h.ctrl(false);
      await h.sleep(100);
      const catGot = (await h.factsSince(m)).some(
        (f) => f.type === 'cat/poked' || f.type === 'cat/pickedUp',
      );
      const overlayDown = (await h.overlayLog()).downs.length > m.downs;
      const probeCtrlDown = (await h.probeSince(m)).some((e) => e.type === 'mousedown' && e.ctrl);
      const still = Math.abs(((await h.reportOf(a.id))?.x ?? NaN) - a.x) < 1;
      record(
        '按住 Ctrl 拖动',
        '先按 Ctrl 再拖：穿过猫，拖到下面的窗口',
        ghostOn && passOverCat && !catGot && !overlayDown && probeCtrlDown && still,
        `幽灵模式=${ghostOn}，猫身上仍穿透=${passOverCat}，猫收到点击=${catGot || overlayDown}，下面的窗口收到 Ctrl+按下=${probeCtrlDown}，猫没动=${still}`,
      );
      // 松开 Ctrl 后 2 秒内仍然是幽灵模式
      h.moveTo(core);
      await h.sleep(850);
      m = await h.mark();
      await h.click(core);
      const at1s = await h.whoGot(m, core);
      await h.sleep(1400);
      h.expectGhost = false;
      h.moveTo(core);
      await h.sleep(120);
      m = await h.mark();
      await h.click(core);
      const at26s = await h.whoGot(m, core);
      record(
        '按住 Ctrl 拖动',
        '松开 Ctrl 后保持 2 秒',
        at1s === 'probe' && at26s === a.id,
        `松开约 1 秒时点猫 → ${at1s}；约 2.6 秒时点猫 → ${at26s}`,
      );
    });

    await h.scenario('按住 Ctrl 拖动', async () => {
      // (b) 先拖起猫，拖到一半再按 Ctrl：已经拎起的猫不扔下，松手后进入幽灵模式
      await ensureLayout();
      cats = await h.freeze();
      const { B } = h.roles(cats);
      const P = point(
        B,
        Object.values(cats).filter((c) => c.id !== B.id),
      );
      const m = await h.mark();
      h.moveTo(P);
      await h.sleep(120);
      h.down();
      await h.sleep(30);
      h.moveTo({ x: P.x - 100, y: P.y - 60 });
      await h.sleep(40);
      h.expectGhost = undefined;
      h.ctrl(true);
      await h.sleep(120);
      const midFacts = await h.factsSince(m);
      const draggingWithCtrl =
        midFacts.some((f) => f.type === 'cat/pickedUp' && f.cat === B.id) &&
        !midFacts.some((f) => f.type === 'cat/dropped') &&
        (await h.overlaySince(m)).filter((o) => o.type === 'drag').at(-1)?.active === true;
      h.moveTo({ x: P.x - 200, y: P.y - 100 });
      await h.sleep(40);
      h.up();
      const t = await waitFor(() => h.transparent(), 1000, 2);
      h.ctrl(false);
      await h.sleep(100);
      const probeEvents = await h.probeSince(m);
      cats = await h.freeze();
      const now = cats[B.id];
      const expectedX = h.expectedDropX(B, -200);
      const moved = now !== undefined && Math.abs(now.x - expectedX) < 3;
      record(
        '按住 Ctrl 拖动',
        '拖到一半按 Ctrl：继续拖完，松手后穿透',
        draggingWithCtrl && moved && probeEvents.length === 0 && t !== null && t <= 200,
        `按 Ctrl 后仍在拖=${draggingWithCtrl}，猫到了松手位置=${moved}，下面的窗口收到 ${probeEvents.length} 个鼠标事件，松手后 ${t}ms 恢复穿透`,
      );
    });

    // ===== 两只猫重叠 =====
    await h.scenario('两只猫重叠', async () => {
      await ensureLayout();
      type Case = {
        name: string;
        find: (c: Record<string, Cat>) => Point | undefined;
        expect: (c: Record<string, Cat>) => string;
      };
      const roleOf = (c: Record<string, Cat>) => h.roles(c);
      const cases: Case[] = [
        {
          name: '两只猫都不透明的地方 → 前面的猫',
          find: (c) => {
            const { B, C } = roleOf(c);
            return sharedPoint(C, B);
          },
          expect: (c) => roleOf(c).C.id,
        },
        {
          name: '只有后面的猫的地方 → 后面的猫',
          find: (c) => {
            const { B } = roleOf(c);
            return exclusivePoint(
              B,
              Object.values(c).filter((o) => o.id !== B.id),
            );
          },
          expect: (c) => roleOf(c).B.id,
        },
        {
          name: '只有前面的猫的地方 → 前面的猫',
          find: (c) => {
            const { C } = roleOf(c);
            return exclusivePoint(
              C,
              Object.values(c).filter((o) => o.id !== C.id),
            );
          },
          expect: (c) => roleOf(c).C.id,
        },
        {
          name: '猫的透明处（腿缝），也没被另一只猫盖住 → 下面的窗口',
          find: (c) => {
            const { B, C } = roleOf(c);
            return legGap(C, Object.values(c)) ?? legGap(B, Object.values(c));
          },
          expect: () => 'probe',
        },
      ];
      for (const item of cases) {
        cats = await h.freeze();
        const p = item.find(cats);
        if (!p) {
          record('两只猫重叠', item.name, false, '没找到合适的测试点', {
            cats: Object.values(cats).map((c) => [c.id, c.x, c.y, c.scale, c.order]),
          });
          continue;
        }
        await h.settle();
        h.moveTo(p);
        await h.sleep(120);
        const m = await h.mark();
        await h.click(p);
        const got = await h.whoGot(m, p);
        const expected = item.expect(cats);
        record('两只猫重叠', item.name, got === expected, `点击落到：${got}（应为 ${expected}）`);
      }
    });

    // ===== 焦点 =====
    // 探针窗口和桌面层都铺满工作区，坐标相同；输入框在 (40,40) 起 320×32
    const inputBox: Point = { x: 200, y: 56 };
    await h.scenario('焦点', async () => {
      await probePage.evaluate("document.getElementById('input').value = ''");
      await h.click(inputBox);
      await h.sleep(200);
      await h.type('abc');
      await h.sleep(100);
      const { cat: a, others } = await A();
      const core = point(a, others);
      h.moveTo(core);
      await h.sleep(120);
      const m = await h.mark();
      await h.click(core);
      await h.sleep(100);
      h.down(); // 再拖一下猫
      await h.sleep(30);
      h.moveTo({ x: core.x + 60, y: core.y });
      await h.sleep(40);
      h.up();
      await h.sleep(200);
      await h.type('def');
      await h.sleep(200);
      const facts = await h.factsSince(m);
      const value = await probePage.evaluate<string>("document.getElementById('input').value");
      const fg = input.foregroundWindow();
      const poked = facts.some((f) => f.type === 'cat/poked');
      const dropped = facts.some((f) => f.type === 'cat/dropped');
      record(
        '焦点',
        '在探针窗口打字时点猫、拖猫',
        value === 'abcdef' && fg === probeHwnd && poked && dropped,
        `点到猫=${poked}，拖了猫=${dropped}，输入框内容="${value}"，前台窗口=${input.windowText(fg)}`,
      );
    });

    if (!process.argv.includes('--skip-notepad'))
      await h.scenario('焦点', async () => {
        const { cat: a, others } = await A();
        await notepadTest(h, point(a, others), notepadFiles);
      });

    // ===== M1 的互动 =====
    await h.scenario('M1 互动', async () => {
      // 单击（戳一下）
      const { cat: a, others } = await A();
      const core = point(a, others);
      h.moveTo(core);
      await h.sleep(120);
      const m = await h.mark();
      await h.click(core);
      const got = await h.whoGot(m, core);
      let reacted = '';
      await waitFor(
        async () => {
          const clip = (await h.reportOf(a.id))?.clip ?? '';
          if (clip === 'poked' || clip === 'meow') reacted = clip;
          return reacted !== '';
        },
        1500,
        50,
      );
      record(
        'M1 互动',
        '单击猫',
        got === a.id && reacted !== '',
        `点击落到：${got}，猫的反应片段：${reacted || '没有'}`,
      );
    });

    await h.scenario('M1 互动', async () => {
      // 撸猫：在猫身上来回划
      const { cat: a, others } = await A();
      const purr = h.purr.get(a.id);
      if (!purr) throw new Error(`没有 ${a.id} 的呼噜片段`);
      const stroke = strokePoints([a, { ...a, clip: purr.clip, mask: purr.mask }], others);
      // 来回划一下至少要移动标准猫身高的 12%（core/stage 的判定），这里留点余量
      if (!stroke || stroke.right.x - stroke.left.x < 0.12 * 150 * a.scale * 1.2)
        throw new Error('猫身上找不到足够宽的地方来回划');
      const { left, right } = stroke;
      h.moveTo(left);
      await h.sleep(150);
      const m = await h.mark();
      const clips = new Set<string>();
      for (let i = 0; i < 8; i++) {
        h.moveTo(i % 2 === 0 ? right : left);
        await h.sleep(110);
        const clip = (await h.reportOf(a.id))?.clip;
        if (clip) clips.add(clip);
      }
      // 停下来不动，600ms 后撸猫结束
      await h.sleep(1200);
      const facts = await h.factsSince(m);
      const petted = facts.find((f) => f.type === 'cat/petted' && f.cat === a.id);
      const other = facts.filter((f) => f.type !== 'cat/petted');
      record(
        'M1 互动',
        '撸猫（在猫身上来回划）',
        petted !== undefined &&
          petted.type === 'cat/petted' &&
          petted.durationMs > 0 &&
          clips.has('purr') &&
          other.length === 0,
        `撸猫结束=${petted !== undefined}（时长 ${petted?.type === 'cat/petted' ? petted.durationMs : '-'}ms），播过呼噜片段=${clips.has('purr')}，误触发其他互动 ${other.length} 次`,
        { clips: [...clips] },
      );
    });

    await h.scenario('M1 互动', async () => {
      // 拎起、放下
      const { cat: a, others } = await A();
      const grab = point(a, others);
      const to = { x: grab.x + 160, y: grab.y - 120 };
      const m = await h.mark();
      h.moveTo(grab);
      await h.sleep(120);
      h.down();
      await h.sleep(40);
      for (let i = 1; i <= 4; i++) {
        h.moveTo({ x: grab.x + 40 * i, y: grab.y - 30 * i });
        await h.sleep(30);
      }
      const dangled =
        (await waitFor(async () => (await h.reportOf(a.id))?.clip === 'dangle', 1500, 50)) !== null;
      h.check();
      h.up();
      await h.sleep(150);
      const facts = await h.factsSince(m);
      cats = await h.freeze();
      const now = cats[a.id];
      const expectedX = h.expectedDropX(a, to.x - grab.x);
      const landed = now !== undefined && Math.abs(now.x - expectedX) < 3;
      record(
        'M1 互动',
        '拎起放下',
        facts.some((f) => f.type === 'cat/pickedUp' && f.cat === a.id) &&
          facts.some((f) => f.type === 'cat/dropped' && f.cat === a.id) &&
          dangled &&
          landed,
        `拎起=${facts.some((f) => f.type === 'cat/pickedUp')}，拎着时播悬空片段=${dangled}，放下=${facts.some((f) => f.type === 'cat/dropped')}，落在松手的位置=${landed}`,
      );
    });

    await h.scenario('M1 互动', async () => {
      // 右键菜单：在探针窗口打字时右键点猫，菜单弹出；先按 Esc 关，关不掉就像真人一样点回输入框，再继续打字
      await probePage.evaluate("document.getElementById('input').value = ''");
      await h.click(inputBox);
      await h.sleep(200);
      await h.type('abc');
      const { cat: a, others } = await A();
      const core = point(a, others);
      h.moveTo(core);
      await h.sleep(120);
      const m = await h.mark();
      const before = (await h.mainLog()).menus;
      const menus = async (): Promise<MainLog['menus']> => (await h.mainLog()).menus;
      let closedBy = '';
      try {
        await h.click(core, 30, 'secondary');
        const shown =
          (await waitFor(async () => (await menus()).shown > before.shown, 1500, 20)) !== null;
        await h.sleep(200);
        const fgDuring = input.foregroundWindow();
        const menuAsked = (await h.overlaySince(m)).some(
          (o) => o.type === 'catMenu' && o.cat === a.id,
        );
        h.check();
        input.key(VK.ESCAPE, true);
        input.key(VK.ESCAPE, false);
        if ((await waitFor(async () => (await menus()).closed > before.closed, 1000, 20)) !== null)
          closedBy = 'Esc';
        else {
          await h.click(inputBox);
          if (
            (await waitFor(async () => (await menus()).closed > before.closed, 1000, 20)) !== null
          )
            closedBy = '点回输入框';
        }
        await h.sleep(200);
        await h.type('def');
        await h.sleep(200);
        const value = await probePage.evaluate<string>("document.getElementById('input').value");
        const fgAfter = input.foregroundWindow();
        const facts = await h.factsSince(m);
        record(
          'M1 互动',
          '右键菜单不抢焦点',
          menuAsked &&
            shown &&
            fgDuring === probeHwnd &&
            closedBy !== '' &&
            fgAfter === probeHwnd &&
            value === 'abcdef' &&
            facts.length === 0,
          `请求菜单=${menuAsked}，菜单弹出=${shown}，菜单开着时前台=${input.windowText(fgDuring)}，关菜单的方式=${closedBy || '关不掉'}，之后前台=${input.windowText(fgAfter)}，输入框内容="${value}"，误触发互动 ${facts.length} 次`,
        );
      } finally {
        // 无论结果如何，都不能让一个没关掉的菜单影响后面的测试
        if (!closedBy) await h.closeMenu();
      }
    });

    // ===== 防卡死 =====
    const antiStuck = (name: string, leave: () => Point, hangMs = 0): Promise<void> =>
      h.scenario('防卡死', async () => {
        const { cat: a, others } = await A();
        const core = point(a, others);
        h.moveTo(core);
        await waitFor(() => !h.transparent(), 1000, 2);
        await h.sleep(100);
        if (hangMs) {
          // 真的让桌面层的渲染进程卡住
          await overlay.evaluate(
            `setTimeout(() => { const until = performance.now() + ${hangMs}; while (performance.now() < until) {} }, 10)`,
          );
          await h.sleep(60);
        }
        const left = Date.now();
        const to = leave();
        h.moveTo(to);
        const t = await waitFor(() => h.transparent(), 2000, 2);
        let clickOk = true;
        if (hangMs) {
          // 渲染进程还卡着，但 200ms 时点空白处应该已经落到下面的窗口
          await sleep(Math.max(0, 200 - (Date.now() - left)));
          const before = (await h.probeEvents()).length;
          await h.click(h.EMPTY2);
          await sleep(150);
          const sp = h.screenDip(h.EMPTY2);
          clickOk = (await h.probeEvents())
            .slice(before)
            .some(
              (e) =>
                e.type === 'mousedown' && Math.abs(e.x - sp.x) <= 3 && Math.abs(e.y - sp.y) <= 3,
            );
          await sleep(hangMs);
        }
        record(
          '防卡死',
          name,
          t !== null && t <= 200 && clickOk,
          `${t}ms 恢复穿透${hangMs ? `；200ms 时点空白处${clickOk ? '落到了下面的窗口' : '没有落到下面的窗口'}` : ''}`,
        );
      });
    await antiStuck('从猫身上移到空白处', () => h.EMPTY);
    await antiStuck('从猫身上移到桌面层外面（任务栏）', () => h.OUTSIDE);
    await antiStuck('渲染进程卡住 1 秒时从猫身上移开', () => h.EMPTY, 1000);

    const summary = {
      time: new Date().toISOString(),
      display: h.display,
      overlaySize: { width: h.W, height: h.H },
      versions,
      floorDepthDuringTest: TEST_FLOOR_DEPTH,
      cats: { A: roles.A.id, B: roles.B.id, C: roles.C.id },
      interferences,
      passed: results.filter((r) => r.pass).length,
      failed: results.filter((r) => !r.pass).length,
      results,
      lostClicks,
    };
    const dir = join(appRoot, 'out/interaction');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `interaction-${displayLabel(h.display)}-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify(summary, null, 2) + '\n');
    console.log(
      `\n显示配置 ${displayLabel(h.display)}：通过 ${summary.passed} 项，失败 ${summary.failed} 项` +
        `（被打断重做 ${interferences.length} 次）。结果：${file}`,
    );
    process.exitCode = summary.failed ? 1 : 0;
  } finally {
    if (input.isKeyDown(VK.CONTROL)) input.key(VK.LCONTROL, false);
    input.mouseButton(false);
    await app.close().catch(() => {});
    await probe?.close().catch(() => {});
    for (const file of notepadFiles) rmSync(file, { force: true });
  }
}

/**
 * 记事本：在记事本里打字时点一下猫，确认焦点和输入都没被抢走。
 *
 * 只在测试自己新建的临时文档里操作：新版记事本会恢复用户上次没保存的内容，
 * 所以绝不全选、删除或关闭整个记事本窗口，只核对、保存、关掉自己的这个文档。
 */
async function notepadTest(h: Harness, core: Point, files: string[]): Promise<void> {
  const marker = `ttcats-notepad-test-${process.pid}-${Date.now()}`;
  const file = join(tmpdir(), `${marker}.txt`);
  writeFileSync(file, '');
  files.push(file);
  /** 前台是记事本，而且当前显示的正是测试自己的文档 */
  const ours = (hwnd: number): boolean =>
    input.windowClass(hwnd) === 'Notepad' && input.windowText(hwnd).includes(marker);
  spawn('notepad.exe', [file], { detached: true, stdio: 'ignore' }).unref();
  let np = 0;
  await waitFor(
    () => {
      const fg = input.foregroundWindow();
      if (ours(fg)) np = fg;
      return np !== 0;
    },
    8000,
    100,
  );
  let saved = false;
  try {
    if (!np) {
      record('焦点', '在记事本里打字时点猫', false, '测试文档没有出现在前台，跳过');
      return;
    }
    await h.sleep(500);
    if (!ours(input.foregroundWindow())) {
      record('焦点', '在记事本里打字时点猫', false, '测试文档不在前台，为安全起见不打字');
      return;
    }
    await h.type('abc');
    await h.sleep(150);
    h.moveTo(core);
    await h.sleep(120);
    const m = await h.mark();
    await h.click(core);
    await h.sleep(200);
    const clicked = (await h.factsSince(m)).some((f) => f.type === 'cat/poked');
    const stillFront = ours(input.foregroundWindow());
    let text = '';
    if (stillFront) {
      await h.type('def');
      await h.sleep(150);
      // 保存到测试文档，再从文件里读回内容核对（不碰剪贴板，也不全选）
      if (ours(input.foregroundWindow())) {
        chord(VK.S);
        await waitFor(() => readFileSync(file, 'utf8').length > 0, 3000, 100);
        text = readFileSync(file, 'utf8').replace(BOM, '').trim();
        saved = text.length > 0;
      }
    }
    record(
      '焦点',
      '在记事本里打字时点猫',
      clicked && stillFront && text === 'abcdef',
      `点到猫=${clicked}，点猫后测试文档仍在前台=${stillFront}，测试文档里的内容="${text}"`,
    );
  } finally {
    await sleep(200);
    if (np) await closeOurDocument(np, ours, saved);
  }
}

/** 只关掉测试自己的文档：新版记事本用 Ctrl+W 关当前标签页；旧版记事本一个窗口只有一个文档，直接关窗口 */
async function closeOurDocument(
  np: number,
  ours: (hwnd: number) => boolean,
  saved: boolean,
): Promise<void> {
  if (saved && ours(input.foregroundWindow())) {
    chord(VK.W);
    await sleep(800);
    // 旧版记事本不认 Ctrl+W；此时窗口里只有这一个已保存的测试文档，关窗口不会影响别的内容
    if (input.windowExists(np) && ours(np)) input.closeWindow(np);
    await sleep(800);
  }
  if (input.windowExists(np) && ours(np))
    console.warn(
      `测试用的记事本文档没有自动关掉（${input.windowText(np)}），请手动关闭这个标签页，不用保存。`,
    );
}

/** 按 Ctrl+某键 */
function chord(vk: number): void {
  input.key(VK.LCONTROL, true);
  input.key(vk, true);
  input.key(vk, false);
  input.key(VK.LCONTROL, false);
}

await main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
