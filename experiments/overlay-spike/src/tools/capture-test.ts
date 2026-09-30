// npm run capture-test：截图隐身（setContentProtection）自动测试。
//
// 在洋红色的探针窗口上放一只猫，分别在"截图里显示猫"开/关两种状态下，用几种截图方式取猫身上的像素：
//   - GDI BitBlt（ffmpeg gdigrab）：QQ、微信这类老截图工具常用的做法
//   - Chromium 屏幕采集（Electron desktopCapturer）：浏览器、Electron 类会议软件共享屏幕的做法
//   - Win+Shift+S（系统截图工具）：模拟按键 + 框选，从剪贴板读结果
// 取到洋红色 = 猫被隐藏；取到猫的颜色 = 猫被截进去了。
//
// 参数：--no-snip  不测 Win+Shift+S（它会在"图片\屏幕截图"里留下小截图，并改写剪贴板）
//       --manual   只把测试画面摆出来，不自动测；用托盘菜单切换"截图里显示猫"，手动用微信/QQ/腾讯会议等测试

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OverlayState, Point } from '../shared/protocol';
import { key, mouseButton, mouseMove, setDpiAware } from '../shared/win32';
import { colorDist, grabPixel, launch, RESULTS, sleep, waitFor } from './common';

const MAGENTA: [number, number, number] = [255, 0, 255];
type Rgb = [number, number, number];

function clipboardCenterPixel(): Rgb | null {
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
    '$img = [System.Windows.Forms.Clipboard]::GetImage()',
    'if ($img) { $b = New-Object System.Drawing.Bitmap $img; $c = $b.GetPixel([int]($b.Width/2), [int]($b.Height/2)); "$($c.R),$($c.G),$($c.B)" }',
  ].join('; ');
  const out = execFileSync('powershell', ['-NoProfile', '-STA', '-Command', ps], { encoding: 'utf8' }).trim();
  return out ? (out.split(',').map(Number) as Rgb) : null;
}
function clearClipboard(): void {
  execFileSync('powershell', ['-NoProfile', '-STA', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::Clear()']);
}

async function snip(center: Point, half: number): Promise<Rgb | null> {
  clearClipboard();
  key(0x5b, true); // LWin
  key(0xa0, true); // LShift
  key(0x53, true); // S
  key(0x53, false);
  key(0xa0, false);
  key(0x5b, false);
  await sleep(1800);
  mouseMove(center.x - half, center.y - half);
  await sleep(100);
  mouseButton(true);
  for (let i = 1; i <= 10; i++) {
    mouseMove(center.x - half + (2 * half * i) / 10, center.y - half + (2 * half * i) / 10);
    await sleep(20);
  }
  mouseButton(false);
  let rgb: Rgb | null = null;
  await waitFor(
    () => {
      rgb = clipboardCenterPixel();
      return rgb !== null;
    },
    5000,
    300,
  );
  key(0x1b, true); // Esc：关掉可能弹出的截图工具窗口/通知不影响结果
  key(0x1b, false);
  return rgb;
}

async function main(): Promise<void> {
  setDpiAware();
  const manual = process.argv.includes('--manual');
  const probe = await launch('probe-main.js', ['--on-top', '--bounds=300,200,1000,600', '--color=#ff00ff', '--title=截图隐身测试'], '探针窗口');
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

    if (manual) {
      console.log('测试画面已摆好。用托盘菜单（橙色圆点图标）勾选/取消"截图里显示猫"，再用各个软件截图或共享屏幕。');
      console.log('看截图里洋红色背景上有没有猫。按 Ctrl+C 结束。');
      await new Promise(() => undefined);
    }

    const rows: { method: string; protection: boolean; rgb: Rgb | null; result: string }[] = [];
    const classify = (rgb: Rgb | null): string => (rgb === null ? '截图失败' : colorDist(rgb, MAGENTA) < 60 ? '看不到猫' : '能看到猫');
    for (const protection of [false, true]) {
      await ov.cmd({ type: 'protection', on: protection });
      await sleep(600);
      const gdi = grabPixel('gdigrab', P.x, P.y);
      rows.push({ method: 'GDI BitBlt（ffmpeg gdigrab）', protection, rgb: gdi, result: classify(gdi) });
      const cap = (await probe.cmd({ type: 'capture', x: P.x, y: P.y })) as { rgb: Rgb };
      rows.push({ method: 'Chromium 屏幕采集（desktopCapturer）', protection, rgb: cap.rgb, result: classify(cap.rgb) });
      if (!process.argv.includes('--no-snip')) {
        const s = await snip(P, Math.round(40 * S));
        rows.push({ method: 'Win+Shift+S（系统截图工具）', protection, rgb: s, result: classify(s) });
        await sleep(1000);
      }
    }
    console.log('\n截图方式 | 截图里显示猫=开（不保护） | 截图里显示猫=关（保护，默认）');
    const methods = [...new Set(rows.map((r) => r.method))];
    for (const m of methods) {
      const off = rows.find((r) => r.method === m && !r.protection)!;
      const on = rows.find((r) => r.method === m && r.protection)!;
      console.log(`${m} | ${off.result} ${JSON.stringify(off.rgb)} | ${on.result} ${JSON.stringify(on.rgb)}`);
    }
    const file = join(RESULTS, `capture-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify({ time: new Date().toISOString(), scaleFactor: S, point: P, rows }, null, 2));
    console.log(`结果：${file}`);
  } finally {
    await ov.kill();
    await probe.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
