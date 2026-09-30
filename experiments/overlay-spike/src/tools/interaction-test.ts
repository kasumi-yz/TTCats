// npm run interaction-test：真实桌面交互测试。
//
// 用 SendInput 发送系统级鼠标、键盘事件（和真人操作走同一条路），
// 同时检查：桌面层有没有接住该接住的点击、猫下面的"探针窗口"（独立进程）有没有收到该收到的点击、
// 焦点有没有被抢走、防卡死是否在 200ms 内恢复鼠标穿透。
//
// 运行期间会移动鼠标、点击、打字（约 3 分钟），请不要碰鼠标和键盘。
// 如果检测到有人动了鼠标，这一项会自动重做（最多 3 次）。
// 参数：--skip-notepad  不做记事本那一项

import { execFileSync, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CatInfo, CatPlacement, LogEvent, OverlayState, Point } from '../shared/protocol';
import {
  closeWindow,
  cursorPos,
  exStyle,
  foregroundWindow,
  key,
  mouseButton,
  mouseMove,
  setDpiAware,
  typeText,
  VK,
  windowClass,
  windowExists,
  windowText,
  WS_EX,
} from '../shared/win32';
import { launch, RESULTS, sleep, waitFor, type Launched } from './common';

interface ProbeEvent {
  t: number;
  type: string;
  x?: number;
  y?: number;
  ctrl?: boolean;
}
interface ProbeState {
  pid: number;
  hwnd: number;
  contentBounds: { x: number; y: number; width: number; height: number };
  value: string;
}
interface Result {
  scenario: string;
  name: string;
  pass: boolean;
  detail: string;
  data?: unknown;
}
type Got = 'cat-a' | 'cat-b' | 'cat-c' | 'probe' | 'swallowed' | 'lost' | 'interfered' | string;

const results: Result[] = [];
const lostClicks: unknown[] = [];
let interferences = 0;

function record(scenario: string, name: string, pass: boolean, detail: string, data?: unknown): void {
  results.push({ scenario, name, pass, detail, data });
  console.log(`${pass ? '通过' : '失败'}  [${scenario}] ${name}：${detail}`);
}

class Interference extends Error {}

const LAYOUT: CatPlacement[] = [
  { id: 'cat-a', x: 520, y: 700, scale: 0.6, z: 0 },
  { id: 'cat-b', x: 980, y: 700, scale: 0.6, z: 1 },
  { id: 'cat-c', x: 1050, y: 712, scale: 0.6, z: 2 },
];
const EMPTY: Point = { x: 1400, y: 380 }; // 探针窗口里、离猫很远的空白处（桌面层窗口内 DIP）
const EMPTY2: Point = { x: 1300, y: 820 };

class Harness {
  S = 1;
  wa = { x: 0, y: 0, width: 0, height: 0 };
  cats: Record<string, CatInfo> = {};
  private expected: { x: number; y: number } | null = null;
  private dirty = false;

  constructor(
    readonly ov: Launched,
    readonly probe: Launched,
  ) {}

  state = (): Promise<OverlayState> => this.ov.get<OverlayState>('/state');
  probeState = (): Promise<ProbeState> => this.probe.get<ProbeState>('/state');
  overlayEvents = (since: number): Promise<LogEvent[]> => this.ov.get<LogEvent[]>(`/events?since=${since}`);
  probeEvents = (since: number): Promise<ProbeEvent[]> => this.probe.get<ProbeEvent[]>(`/events?since=${since}`);

  phys(p: Point): Point {
    return { x: Math.round((p.x + this.wa.x) * this.S), y: Math.round((p.y + this.wa.y) * this.S) };
  }
  screenDip(p: Point): Point {
    return { x: p.x + this.wa.x, y: p.y + this.wa.y };
  }

  /** 检查光标是否还在脚本放的位置；不在就说明有人动了鼠标 */
  checkCursor(): void {
    if (!this.expected) return;
    const c = cursorPos();
    if (Math.abs(c.x - this.expected.x) > 2 || Math.abs(c.y - this.expected.y) > 2) {
      this.dirty = true;
      throw new Interference(`光标在 ${c.x},${c.y}，应该在 ${this.expected.x},${this.expected.y}`);
    }
  }
  moveTo(p: Point): void {
    this.checkCursor();
    const q = this.phys(p);
    mouseMove(q.x, q.y);
    this.expected = q;
  }
  down(): void {
    this.checkCursor();
    mouseButton(true);
  }
  up(): void {
    this.checkCursor();
    mouseButton(false);
  }
  async click(p: Point, holdMs = 30): Promise<void> {
    this.moveTo(p);
    this.down();
    await sleep(holdMs);
    this.up();
  }
  async sleep(ms: number): Promise<void> {
    await sleep(ms);
    this.checkCursor();
  }

  async mark(): Promise<{ seq: number; t: number }> {
    return { seq: (await this.state()).seq, t: Date.now() };
  }

  /** 一次点击最后落到了哪里：哪只猫、探针窗口、被桌面层吃掉（swallowed），还是哪里都没收到（lost） */
  async whoGot(m: { seq: number; t: number }, p: Point): Promise<Got> {
    await sleep(150);
    this.checkCursor();
    const oe = await this.overlayEvents(m.seq);
    const down = oe.find((e) => e.type === 'catDown');
    if (down) return String(down.id);
    if (oe.some((e) => e.type === 'missClick')) return 'swallowed';
    const pe = await this.probeEvents(m.t - 1);
    const sp = this.screenDip(p);
    if (pe.some((e) => e.type === 'mousedown' && Math.abs(e.x! - sp.x) <= 3 && Math.abs(e.y! - sp.y) <= 3)) return 'probe';
    lostClicks.push({ at: p, overlay: oe.map((e) => e.type), probe: pe });
    return 'lost';
  }

  async settle(): Promise<void> {
    this.moveTo(EMPTY);
    await waitFor(async () => {
      const s = await this.state();
      return s.ignoring && !s.dragging && !s.ghost;
    }, 4000);
    await this.sleep(80);
  }

  /** 把三只猫放回初始位置，等它们都回到"站"的循环片段 */
  async resetLayout(): Promise<void> {
    key(VK.LCONTROL, false);
    if (this.expected) mouseButton(false);
    this.expected = null;
    const q = this.phys(EMPTY);
    mouseMove(q.x, q.y);
    this.expected = q;
    await sleep(2300); // 等幽灵模式的 2 秒保持期过去
    await this.ov.cmd({ type: 'layout', layout: 'test', cats: LAYOUT });
    await waitFor(
      async () => {
        const s = await this.state();
        return s.cats.every((c) => c.clip === 'loop_stand' && !c.dragging) && !s.dragging;
      },
      6000,
      50,
    );
    await sleep(300);
    for (const c of (await this.state()).cats) this.cats[c.id] = c;
    await this.settle();
  }

  /** 跑一个场景；如果中途有人动了鼠标，丢掉这次的结果重做 */
  async scenario(name: string, fn: () => Promise<void>): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const before = results.length;
      this.dirty = false;
      try {
        await this.resetLayout();
        await fn();
        if (!this.dirty) return;
      } catch (err) {
        if (!(err instanceof Interference)) throw err;
      }
      interferences++;
      results.splice(before);
      console.warn(`[${name}] 检测到有人动了鼠标，第 ${attempt} 次重做……`);
      await sleep(2000);
    }
    record(name, '（整个场景）', false, '连续 3 次被人为移动鼠标打断，没有结果');
  }
}

async function main(): Promise<void> {
  if (!setDpiAware()) console.warn('设置 DPI 感知失败，坐标可能不准');
  const probe = await launch('probe-main.js', ['--on-top', '--bounds=200,150,1400,800', '--color=#4d6f8f'], '探针窗口');
  const ov = await launch('main.js', ['--layout=test'], '桌面层');
  const h = new Harness(ov, probe);

  try {
    await waitFor(async () => (await h.state()).cats.length === 3, 15000, 100);
    const st0 = await h.state();
    h.S = st0.scaleFactor;
    h.wa = st0.workArea;
    const versions = (await ov.get<{ versions: Record<string, string> }>('/gpu')).versions;
    console.log(`显示缩放 ${Math.round(h.S * 100)}%，工作区 ${h.wa.width}x${h.wa.height}（DIP）`);
    const A = (): CatInfo => h.cats['cat-a'];
    const B = (): CatInfo => h.cats['cat-b'];
    const C = (): CatInfo => h.cats['cat-c'];

    await h.scenario('准备', async () => {
      // 点一下探针窗口的空白处，让它成为前台窗口
      await h.click(EMPTY);
      await h.sleep(300);
      const ps = await h.probeState();
      record('准备', '探针窗口成为前台', foregroundWindow() === ps.hwnd, `前台窗口：${windowText(foregroundWindow())}`);
    });

    // ===== 基础 =====
    await h.scenario('基础', async () => {
      const st = await h.state();
      const style = exStyle(st.hwnd);
      record(
        '基础',
        '窗口样式',
        (style & WS_EX.NOACTIVATE) !== 0 && (style & WS_EX.TOPMOST) !== 0 && (style & WS_EX.TRANSPARENT) !== 0,
        `不抢焦点 WS_EX_NOACTIVATE=${!!(style & WS_EX.NOACTIVATE)}，置顶 TOPMOST=${!!(style & WS_EX.TOPMOST)}，默认穿透 TRANSPARENT=${!!(style & WS_EX.TRANSPARENT)}`,
      );
      let m = await h.mark();
      await h.click(EMPTY2);
      let got = await h.whoGot(m, EMPTY2);
      record('基础', '点空白处', got === 'probe', `点击落到：${got}`);

      await h.settle();
      h.moveTo(A().core!);
      const t = await waitFor(async () => !(await h.state()).ignoring, 1000, 2);
      record('基础', '鼠标移到猫身上后关闭穿透', t !== null && t <= 50, `用时 ${t}ms`);
      await h.sleep(50);
      m = await h.mark();
      await h.click(A().core!);
      got = await h.whoGot(m, A().core!);
      record('基础', '点猫身上（悬停后）', got === 'cat-a', `点击落到：${got}`);

      await h.settle();
      const gap = A().gap!;
      h.moveTo(gap);
      await h.sleep(150);
      m = await h.mark();
      await h.click(gap);
      got = await h.whoGot(m, gap);
      record('基础', '点猫的包围框内的透明处（两腿之间）', got === 'probe', `点击落到：${got}`);
    });

    // ===== 鼠标快速移到猫身上，马上点击 =====
    await h.scenario('快速移到猫身上马上点', async () => {
      const delays = [0, 5, 10, 20, 35, 50, 80, 120];
      const table: Record<number, Record<string, number>> = {};
      for (const d of delays) {
        table[d] = {};
        for (let i = 0; i < 5; i++) {
          await h.settle();
          const m = await h.mark();
          h.moveTo(A().core!);
          if (d) await h.sleep(d);
          h.down();
          await h.sleep(30);
          h.up();
          const got = await h.whoGot(m, A().core!);
          table[d][got] = (table[d][got] ?? 0) + 1;
        }
      }
      const ok = (d: number): boolean => (table[d]['cat-a'] ?? 0) === 5;
      const minReliable = delays.find((d) => delays.filter((x) => x >= d).every(ok));
      const lost = delays.reduce((s, d) => s + (table[d].lost ?? 0) + (table[d].swallowed ?? 0), 0);
      record(
        '快速移到猫身上马上点',
        '移动后隔多久点击才一定能点中猫',
        minReliable !== undefined && minReliable <= 20,
        `隔 ${minReliable ?? '>120'}ms 及以上 5/5 点中；全部 40 次里有 ${lost} 次点击丢失（猫和下面的窗口都没收到）`,
        table,
      );
    });

    await h.scenario('快速移到猫身上马上点', async () => {
      // 反方向：鼠标刚离开猫就点旁边的空白处，点击会不会被桌面层吃掉
      const delays = [0, 5, 10, 20, 50];
      const table: Record<number, Record<string, number>> = {};
      const target: Point = { x: A().bbox.x + A().bbox.width + 40, y: A().core!.y };
      for (const d of delays) {
        table[d] = {};
        for (let i = 0; i < 5; i++) {
          await h.settle();
          h.moveTo(A().core!);
          await waitFor(async () => !(await h.state()).ignoring, 500, 2);
          await h.sleep(60);
          const m = await h.mark();
          h.moveTo(target);
          if (d) await h.sleep(d);
          h.down();
          await h.sleep(30);
          h.up();
          const got = await h.whoGot(m, target);
          table[d][got] = (table[d][got] ?? 0) + 1;
        }
      }
      const bad = delays.reduce((s, d) => s + (table[d].swallowed ?? 0) + (table[d].lost ?? 0), 0);
      const minOk = delays.find((d) => delays.filter((x) => x >= d).every((x) => (table[x].probe ?? 0) === 5));
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
      const a = A();
      const m = await h.mark();
      h.moveTo(a.core!);
      await h.sleep(120);
      h.down();
      await h.sleep(40);
      // 一下子甩出去很远（远超猫的范围），中间再绕到桌面层外面（任务栏）
      const path: Point[] = [
        { x: a.core!.x + 30, y: a.core!.y },
        { x: a.core!.x + 400, y: a.core!.y - 250 },
        { x: 700, y: h.wa.height + 20 },
        { x: 1250, y: 500 },
      ];
      for (const p of path) {
        h.moveTo(p);
        await h.sleep(25);
      }
      await h.sleep(60);
      const midDragging = (await h.state()).dragging;
      h.up();
      await h.sleep(150);
      const oe = await h.overlayEvents(m.seq);
      const pe = (await h.probeEvents(m.t - 1)).filter((e) => e.type !== 'input');
      const drop = oe.some((e) => e.type === 'drop');
      const aNow = (await h.state()).cats.find((c) => c.id === 'cat-a')!;
      const expected = { x: a.foot.x + (1250 - a.core!.x), y: a.foot.y + (500 - a.core!.y) };
      const followed = Math.hypot(aNow.foot.x - expected.x, aNow.foot.y - expected.y) < 3;
      record(
        '拖动时鼠标移出猫的范围',
        '整个拖动过程由桌面层接收',
        midDragging && drop && followed && pe.length === 0,
        `拖动中=${midDragging}，松手=${drop}，猫跟到了松手位置=${followed}，下面的窗口收到 ${pe.length} 个鼠标事件`,
      );
      h.moveTo(EMPTY);
      const t = await waitFor(async () => (await h.state()).ignoring, 1000, 2);
      record('拖动时鼠标移出猫的范围', '松手后离开猫，恢复穿透', t !== null && t <= 200, `用时 ${t}ms`);
      const m2 = await h.mark();
      await h.click(EMPTY);
      const got = await h.whoGot(m2, EMPTY);
      record('拖动时鼠标移出猫的范围', '之后点空白处', got === 'probe', `点击落到：${got}`);
    });

    // ===== 按住 Ctrl 拖动 =====
    await h.scenario('按住 Ctrl 拖动', async () => {
      // (a) 先按住 Ctrl 再去拖猫：鼠标应该穿过猫，下面的窗口收到带 Ctrl 的拖动
      const a = A();
      let m = await h.mark();
      key(VK.LCONTROL, true);
      await h.sleep(100);
      const ghostOn = (await h.state()).ghost;
      h.moveTo(a.core!);
      await h.sleep(100);
      const ignoringOverCat = (await h.state()).ignoring;
      h.down();
      await h.sleep(30);
      h.moveTo({ x: a.core!.x + 150, y: a.core!.y });
      await h.sleep(30);
      h.up();
      await h.sleep(50);
      const aNow = (await h.state()).cats.find((c) => c.id === 'cat-a')!;
      key(VK.LCONTROL, false);
      await h.sleep(100);
      const oe = await h.overlayEvents(m.seq);
      const pe = await h.probeEvents(m.t - 1);
      const probeCtrlDown = pe.some((e) => e.type === 'mousedown' && e.ctrl);
      const still = Math.abs(aNow.foot.x - a.foot.x) < 1;
      record(
        '按住 Ctrl 拖动',
        '先按 Ctrl 再拖：穿过猫，拖到下面的窗口',
        ghostOn && ignoringOverCat && !oe.some((e) => e.type === 'catDown') && probeCtrlDown && still && aNow.alpha < 1,
        `幽灵模式=${ghostOn}，猫的不透明度=${aNow.alpha}，猫身上仍穿透=${ignoringOverCat}，下面的窗口收到 Ctrl+按下=${probeCtrlDown}，猫没动=${still}`,
      );
      // 松开 Ctrl 后 2 秒内仍然是幽灵模式
      h.moveTo(a.core!);
      await h.sleep(850);
      m = await h.mark();
      await h.click(a.core!);
      const at1s = await h.whoGot(m, a.core!);
      await h.sleep(1400);
      h.moveTo(a.core!);
      await h.sleep(120);
      m = await h.mark();
      await h.click(a.core!);
      const at26s = await h.whoGot(m, a.core!);
      record(
        '按住 Ctrl 拖动',
        '松开 Ctrl 后保持 2 秒',
        at1s === 'probe' && at26s === 'cat-a',
        `松开约 1 秒时点猫 → ${at1s}；约 2.6 秒时点猫 → ${at26s}`,
      );
    });

    await h.scenario('按住 Ctrl 拖动', async () => {
      // (b) 先拖起猫，拖到一半再按 Ctrl：已经拎起的猫不扔下，松手后进入幽灵模式
      const b = B();
      const P = b.exclusive!;
      const m = await h.mark();
      h.moveTo(P);
      await h.sleep(120);
      h.down();
      await h.sleep(30);
      h.moveTo({ x: P.x - 100, y: P.y - 60 });
      await h.sleep(40);
      key(VK.LCONTROL, true);
      await h.sleep(120);
      const draggingWithCtrl = (await h.state()).dragging;
      h.moveTo({ x: P.x - 200, y: P.y - 100 });
      await h.sleep(40);
      h.up();
      const t = await waitFor(async () => (await h.state()).ignoring, 1000, 2);
      key(VK.LCONTROL, false);
      await h.sleep(100);
      const pe = (await h.probeEvents(m.t - 1)).filter((e) => e.type !== 'input');
      const bNow = (await h.state()).cats.find((c) => c.id === 'cat-b')!;
      const moved = Math.hypot(bNow.foot.x - (b.foot.x - 200), bNow.foot.y - (b.foot.y - 100)) < 3;
      record(
        '按住 Ctrl 拖动',
        '拖到一半按 Ctrl：继续拖完，松手后穿透',
        draggingWithCtrl && moved && pe.length === 0 && t !== null && t <= 200,
        `按 Ctrl 后仍在拖=${draggingWithCtrl}，猫到了松手位置=${moved}，下面的窗口收到 ${pe.length} 个事件，松手后 ${t}ms 恢复穿透（光标还在猫身上）`,
      );
    });

    // ===== 两只猫重叠 =====
    await h.scenario('两只猫重叠', async () => {
      const cases: { name: string; p: Point | null | undefined; expect: string }[] = [
        { name: '两只猫都不透明的地方 → 前面的猫', p: C().shared?.point ?? B().shared?.point, expect: 'cat-c' },
        { name: '只有后面的猫的地方 → 后面的猫', p: B().exclusive, expect: 'cat-b' },
        { name: '只有前面的猫的地方 → 前面的猫', p: C().exclusive, expect: 'cat-c' },
        { name: '猫的透明处（腿缝），也没被另一只猫盖住 → 下面的窗口', p: C().gap ?? B().gap, expect: 'probe' },
      ];
      for (const c of cases) {
        if (!c.p) {
          record('两只猫重叠', c.name, false, '没找到合适的测试点');
          continue;
        }
        await h.settle();
        h.moveTo(c.p);
        await h.sleep(120);
        const m = await h.mark();
        await h.click(c.p);
        const got = await h.whoGot(m, c.p);
        record('两只猫重叠', c.name, got === c.expect, `点击落到：${got}`);
      }
    });

    // ===== 焦点 =====
    await h.scenario('焦点', async () => {
      const pst = await h.probeState();
      await probe.cmd({ type: 'clear' });
      const ta: Point = { x: pst.contentBounds.x + 100 - h.wa.x, y: pst.contentBounds.y + 40 - h.wa.y };
      await h.click(ta);
      await h.sleep(200);
      typeText('abc');
      await h.sleep(100);
      const a = A();
      h.moveTo(a.core!);
      await h.sleep(120);
      const m = await h.mark();
      await h.click(a.core!);
      await h.sleep(100);
      h.down(); // 再拖一下猫
      await h.sleep(30);
      h.moveTo({ x: a.core!.x + 60, y: a.core!.y });
      await h.sleep(40);
      h.up();
      await h.sleep(200);
      typeText('def');
      await h.sleep(200);
      const oe = await h.overlayEvents(m.seq);
      const after = await h.probeState();
      const fg = foregroundWindow();
      record(
        '焦点',
        '在探针窗口打字时点猫、拖猫',
        after.value === 'abcdef' && fg === after.hwnd && oe.some((e) => e.type === 'catClick') && oe.some((e) => e.type === 'drop'),
        `点到猫=${oe.some((e) => e.type === 'catClick')}，拖了猫=${oe.some((e) => e.type === 'drop')}，输入框内容="${after.value}"，前台窗口=${windowText(fg)}`,
      );
    });

    if (!process.argv.includes('--skip-notepad')) await h.scenario('焦点', () => notepadTest(h, A()));

    // ===== 防卡死 =====
    const antiStuck = (name: string, leave: () => void, hangMs = 0) =>
      h.scenario('防卡死', async () => {
        h.moveTo(A().core!);
        await waitFor(async () => !(await h.state()).ignoring, 1000, 2);
        await h.sleep(100);
        if (hangMs) {
          await ov.cmd({ type: 'hang', ms: hangMs });
          await h.sleep(60);
        }
        const m = await h.mark();
        leave();
        const t = await waitFor(async () => (await h.state()).ignoring, 2000, 2);
        const reason = (await h.overlayEvents(m.seq)).find((e) => e.type === 'ignore' && e.ignore)?.reason;
        let clickOk = true;
        if (hangMs) {
          // 渲染进程还卡着，但 200ms 时点空白处应该已经落到下面的窗口
          await sleep(Math.max(0, 200 - (Date.now() - m.t)));
          const m2 = await h.mark();
          await h.click(EMPTY2);
          clickOk = (await h.whoGot(m2, EMPTY2)) === 'probe';
          await sleep(hangMs);
        }
        record(
          '防卡死',
          name,
          t !== null && t <= 200 && clickOk,
          `${t}ms 恢复穿透（触发原因：${reason ?? '-'}）${hangMs ? `；200ms 时点空白处${clickOk ? '落到了下面的窗口' : '没有落到下面的窗口'}` : ''}`,
        );
      });
    await antiStuck('从猫身上移到空白处', () => h.moveTo(EMPTY));
    await antiStuck('从猫身上移到桌面层外面（任务栏）', () => h.moveTo({ x: 700, y: h.wa.height + 20 }));
    await antiStuck('渲染进程卡住 1 秒时从猫身上移开', () => h.moveTo(EMPTY), 1000);

    const summary = {
      time: new Date().toISOString(),
      scaleFactor: h.S,
      workArea: h.wa,
      versions: { electron: versions.electron, chrome: versions.chrome, node: versions.node },
      interferences,
      passed: results.filter((r) => r.pass).length,
      failed: results.filter((r) => !r.pass).length,
      results,
      lostClicks,
    };
    const file = join(RESULTS, `interaction-${Math.round(h.S * 100)}pct-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify(summary, null, 2));
    console.log(
      `\n显示缩放 ${Math.round(h.S * 100)}%：通过 ${summary.passed} 项，失败 ${summary.failed} 项` +
        `（因有人动鼠标重做 ${interferences} 次）。结果：${file}`,
    );
    process.exitCode = summary.failed ? 1 : 0;
  } finally {
    key(VK.LCONTROL, false);
    await ov.kill();
    await probe.kill();
  }
}

/** 记事本：在记事本里打字时点一下猫，确认焦点和输入都没被抢走 */
async function notepadTest(h: Harness, A: CatInfo): Promise<void> {
  const before = foregroundWindow();
  spawn('notepad.exe', [], { detached: true, stdio: 'ignore' }).unref();
  let np = 0;
  await waitFor(
    () => {
      const fg = foregroundWindow();
      if (fg !== before && windowClass(fg) === 'Notepad') np = fg;
      return np !== 0;
    },
    8000,
    100,
  );
  if (!np) {
    record('焦点', '在记事本里打字时点猫', false, '记事本窗口没有出现在前台，跳过');
    return;
  }
  try {
    await h.sleep(500);
    if (foregroundWindow() !== np) {
      record('焦点', '在记事本里打字时点猫', false, '记事本不在前台，为安全起见不打字');
      return;
    }
    typeText('abc');
    await h.sleep(150);
    h.moveTo(A.core!);
    await h.sleep(120);
    const m = await h.mark();
    await h.click(A.core!);
    await h.sleep(200);
    const clicked = (await h.overlayEvents(m.seq)).some((e) => e.type === 'catClick');
    const stillFront = foregroundWindow() === np;
    let text = '';
    if (stillFront) {
      typeText('def');
      await h.sleep(150);
      // 全选 → 复制，读剪贴板核对内容，然后删掉
      key(VK.LCONTROL, true);
      key(VK.A, true);
      key(VK.A, false);
      key(VK.C, true);
      key(VK.C, false);
      key(VK.LCONTROL, false);
      await h.sleep(250);
      text = execFileSync('powershell', ['-NoProfile', '-Command', 'Get-Clipboard'], { encoding: 'utf8' }).trim();
      if (foregroundWindow() === np) {
        key(VK.DELETE, true);
        key(VK.DELETE, false);
      }
    }
    record(
      '焦点',
      '在记事本里打字时点猫',
      clicked && stillFront && text === 'abcdef',
      `点到猫=${clicked}，点猫后记事本仍在前台=${stillFront}，记事本里的内容="${text}"`,
    );
  } finally {
    await sleep(200);
    closeWindow(np);
    await sleep(1500);
    if (windowExists(np)) console.warn(`记事本窗口没有自动关掉（${windowText(np)}），请手动关闭，不用保存。`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
