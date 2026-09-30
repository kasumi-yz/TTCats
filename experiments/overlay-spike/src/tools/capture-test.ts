// npm run capture-test：截图隐身（setContentProtection）自动测试。
//
// 在洋红色的探针窗口上放一只猫，分别在"截图里显示猫"开/关两种状态下，用几种截图方式取猫身上的像素：
//   - GDI BitBlt（ffmpeg gdigrab）：QQ、微信这类老截图工具常用的做法
//   - Chromium 屏幕采集（Electron desktopCapturer）：浏览器、Electron 类会议软件共享屏幕的做法
//   - Win+Shift+S（系统截图工具）：模拟按键 + 框选，从剪贴板读结果
// 取到洋红色 = 猫被隐藏；取到猫的颜色 = 猫被截进去了。
// 每次同时取一个"背景点"（猫上方的空白处），背景不是洋红色说明测试画面被别的窗口挡住了，这次结果判为无效。
//
// 参数：--no-snip  不测 Win+Shift+S（它会在"图片\屏幕截图"里留下小截图，并改写剪贴板）
//       --manual   只把测试画面摆出来，不自动测；用托盘菜单切换"截图里显示猫"，手动用微信/QQ/腾讯会议等测试

import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OverlayState, Point } from '../shared/protocol';
import { closeWindow, foregroundWindow, key, mouseButton, mouseMove, setDpiAware, windowPid } from '../shared/win32';
import { colorDist, grabPixel, launch, RESULTS, sleep, waitFor } from './common';

const MAGENTA: [number, number, number] = [255, 0, 255];
type Rgb = [number, number, number];

function powershell(script: string, sta = false): string {
  return execFileSync('powershell', ['-NoProfile', ...(sta ? ['-STA'] : []), '-Command', script], { encoding: 'utf8' }).trim();
}

/** 读剪贴板里图片上几个点的颜色 */
function clipboardPixels(points: Point[]): Rgb[] | null {
  const pts = points.map((p) => '@(' + p.x + ',' + p.y + ')').join(',');
  const out = powershell(
    [
      'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
      '$img = [System.Windows.Forms.Clipboard]::GetImage()',
      'if ($img) { $b = New-Object System.Drawing.Bitmap $img; foreach ($p in @(' +
        pts +
        ')) { $c = $b.GetPixel($p[0], $p[1]); "$($c.R),$($c.G),$($c.B)" } }',
    ].join('; '),
    true,
  );
  return out ? out.split(/\r?\n/).map((l) => l.split(',').map(Number) as Rgb) : null;
}

function clearClipboard(): void {
  powershell('Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::Clear()', true);
}

function processName(pid: number): string {
  try {
    return powershell(`(Get-Process -Id ${pid}).ProcessName`);
  } catch {
    return '';
  }
}

/** 截完图后，系统截图工具可能弹出一个预览窗口盖在测试画面上，把它关掉 */
async function closeSnippingWindows(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const fg = foregroundWindow();
    if (/Snipping|ScreenClipping/i.test(processName(windowPid(fg)))) closeWindow(fg);
    await sleep(300);
  }
}

/** Win+Shift+S 框选一个从背景点到猫身上的竖长方形，返回猫身上和背景两个像素 */
async function snip(cat: Point, bg: Point, half: number): Promise<{ cat: Rgb; bg: Rgb } | null> {
  clearClipboard();
  key(0x5b, true); // LWin
  key(0xa0, true); // LShift
  key(0x53, true); // S
  key(0x53, false);
  key(0xa0, false);
  key(0x5b, false);
  await sleep(1800);
  const x0 = cat.x - half;
  const y0 = bg.y - 10;
  const x1 = cat.x + half;
  const y1 = cat.y + half;
  mouseMove(x0, y0);
  await sleep(100);
  mouseButton(true);
  for (let i = 1; i <= 10; i++) {
    mouseMove(x0 + ((x1 - x0) * i) / 10, y0 + ((y1 - y0) * i) / 10);
    await sleep(20);
  }
  mouseButton(false);
  let px: Rgb[] | null = null;
  await waitFor(
    () => {
      px = clipboardPixels([
        { x: half, y: cat.y - y0 },
        { x: half, y: 10 },
      ]);
      return px !== null;
    },
    5000,
    300,
  );
  await closeSnippingWindows();
  const r = px as Rgb[] | null;
  return r && r.length === 2 ? { cat: r[0], bg: r[1] } : null;
}

async function main(): Promise<void> {
  setDpiAware();
  const manual = process.argv.includes('--manual');
  const probe = await launch(
    'probe-main.js',
    ['--on-top', '--bounds=300,200,1000,600', '--color=#ff00ff', '--title=截图隐身测试'],
    '探针窗口',
  );
  const ov = await launch('main.js', ['--layout=test'], '桌面层');
  try {
    await waitFor(async () => (await ov.get<OverlayState>('/state')).cats.length === 3, 15000, 100);
    await ov.cmd({
      type: 'layout',
      layout: 'test',
      cats: [
        { id: 'cat-a', x: 600, y: 650, scale: 0.8 },
        { id: 'cat-b', x: 850, y: 650, scale: 0.8 },
        { id: 'cat-c', x: 1100, y: 650, scale: 0.8 },
      ],
    });
    await sleep(800);
    const st = await ov.get<OverlayState>('/state');
    const S = st.scaleFactor;
    const core = st.cats.find((c) => c.id === 'cat-b')!.core!;
    const P: Point = { x: Math.round((core.x + st.workArea.x) * S), y: Math.round((core.y + st.workArea.y) * S) };
    // 背景点：探针窗口里、所有猫上方的空白处
    const pst = await probe.get<{ contentBounds: { x: number; y: number } }>('/state');
    const B: Point = { x: P.x, y: Math.round((pst.contentBounds.y + 60) * S) };

    if (manual) {
      console.log('测试画面已摆好。用托盘菜单（橙色圆点图标）勾选/取消"截图里显示猫"，再用各个软件截图或共享屏幕。');
      console.log('看截图里洋红色背景上有没有猫。按 Ctrl+C 结束。');
      await new Promise(() => undefined);
    }

    type Row = { method: string; protection: boolean; rgb: Rgb | null; bg: Rgb | null; result: string };
    const rows: Row[] = [];
    const add = (method: string, protection: boolean, rgb: Rgb | null, bg: Rgb | null): void => {
      let result: string;
      if (rgb === null || bg === null) result = '截图失败';
      else if (colorDist(bg, MAGENTA) >= 60) result = '无效（背景被挡住）';
      else result = colorDist(rgb, MAGENTA) < 60 ? '看不到猫' : '能看到猫';
      rows.push({ method, protection, rgb, bg, result });
    };
    for (const protection of [false, true]) {
      await probe.cmd({ type: 'raise' });
      await ov.cmd({ type: 'raise' });
      await ov.cmd({ type: 'protection', on: protection });
      await sleep(600);
      if (process.env.CAPTURE_DEBUG) spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'gdigrab', '-i', 'desktop', '-frames:v', '1', '-vf', 'scale=1440:-1', join(RESULTS, `capture-debug-${protection}.png`)]);
      add('GDI BitBlt（ffmpeg gdigrab）', protection, grabPixel('gdigrab', P.x, P.y), grabPixel('gdigrab', B.x, B.y));
      const cap = (await probe.cmd({ type: 'capture', x: P.x, y: P.y })) as { rgb: Rgb };
      const capBg = (await probe.cmd({ type: 'capture', x: B.x, y: B.y })) as { rgb: Rgb };
      add('Chromium 屏幕采集（desktopCapturer）', protection, cap.rgb, capBg.rgb);
      if (!process.argv.includes('--no-snip')) {
        const s = await snip(P, B, Math.round(40 * S));
        add('Win+Shift+S（系统截图工具）', protection, s?.cat ?? null, s?.bg ?? null);
        await sleep(1000);
      }
    }
    console.log('\n截图方式 | 截图里显示猫=开（不保护） | 截图里显示猫=关（保护，默认）');
    for (const m of [...new Set(rows.map((r) => r.method))]) {
      const off = rows.find((r) => r.method === m && !r.protection)!;
      const on = rows.find((r) => r.method === m && r.protection)!;
      console.log(`${m} | ${off.result} ${JSON.stringify(off.rgb)} | ${on.result} ${JSON.stringify(on.rgb)}`);
    }
    const file = join(RESULTS, `capture-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify({ time: new Date().toISOString(), scaleFactor: S, point: P, background: B, rows }, null, 2));
    console.log(`结果：${file}`);
    process.exitCode = rows.some((r) => r.result.startsWith('无效') || r.result === '截图失败') ? 1 : 0;
  } finally {
    await ov.kill();
    await probe.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
