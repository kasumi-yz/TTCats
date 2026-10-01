// npm run record：把三种打断衔接方式并排录下来。
//
// 三只猫并排，左边"交叉淡化 150ms"、中间"硬切 + 小特效"、右边"专门的过渡片段"，
// 每 2.6 秒同时打断一次（站 ↔ 坐）。用 ffmpeg gdigrab 录屏，
// 输出 MP4、GIF，以及一次打断前后逐帧拼成的对比图。
//
// 参数：--seconds=16  --out=<目录>（默认 results/record）  --preload= --fps= --gpu= 原样传给桌面层

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LogEvent, OverlayState } from '../shared/protocol';
import { setDpiAware } from '../shared/win32';
import { launch, RESULTS, sleep, waitFor } from './common';

const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

async function main(): Promise<void> {
  setDpiAware();
  const seconds = Number(arg('seconds') ?? 16);
  const out = arg('out') ?? join(RESULTS, 'record');
  mkdirSync(out, { recursive: true });

  const probe = await launch('probe-main.js', ['--on-top', '--bounds=380,330,1160,520', '--color=#8a939c', '--title=衔接方式录屏'], '背景窗口');
  const ov = await launch('main.js', ['--layout=demo', '--no-hud', ...process.argv.filter((a) => /^--(preload|fps|gpu)=/.test(a))], '桌面层');
  try {
    await waitFor(async () => (await ov.get<OverlayState>('/state')).cats.length === 3, 15000, 100);
    await ov.cmd({ type: 'protection', on: false });
    await sleep(1500);
    const st = await ov.get<OverlayState>('/state');
    const S = st.scaleFactor;
    // 录制区域：三只猫的包围框再放宽一些（物理像素，宽高取偶数）
    const xs = st.cats.flatMap((c) => [c.bbox.x, c.bbox.x + c.bbox.width]);
    const ys = st.cats.flatMap((c) => [c.bbox.y, c.bbox.y + c.bbox.height]);
    const x0 = Math.min(...xs) - 90;
    const y0 = Math.min(...ys) - 70;
    const x1 = Math.max(...xs) + 90;
    const y1 = Math.max(...ys) + 50;
    const even = (v: number): number => Math.round((v * S) / 2) * 2;
    const region = { x: even(x0 + st.workArea.x), y: even(y0 + st.workArea.y), w: even(x1 - x0), h: even(y1 - y0) };

    const seq0 = st.seq;
    const mp4 = join(out, 'interrupts.mp4');
    const t0 = Date.now();
    const ff = spawn(
      'ffmpeg',
      [
        '-y',
        '-loglevel',
        'error',
        '-f',
        'gdigrab',
        '-framerate',
        '30',
        '-draw_mouse',
        '0',
        '-offset_x',
        String(region.x),
        '-offset_y',
        String(region.y),
        '-video_size',
        `${region.w}x${region.h}`,
        '-i',
        'desktop',
        '-t',
        String(seconds),
        '-c:v',
        'libx264',
        '-crf',
        '20',
        '-pix_fmt',
        'yuv420p',
        mp4,
      ],
      { stdio: 'inherit' },
    );
    await new Promise((r) => ff.on('exit', r));
    const events = (await ov.get<LogEvent[]>(`/events?since=${seq0}`)).filter((e) => e.type === 'interrupt');
    const stats = (await ov.get<OverlayState>('/state')).switchStats;

    // 选录制开始 3 秒以后的两次打断（一次站→坐、一次坐→站），各导出打断前 0.1s 到打断后 0.4s 的逐帧对比图（30fps）
    const picked = [...new Map(events.filter((e) => e.t - t0 > 3000).map((e) => [e.t - (e.t % 1000), e])).values()]
      .filter((e, i, a) => i === 0 || e.t - a[i - 1].t > 1000)
      .slice(0, 2);
    const sheets: string[] = [];
    picked.forEach((e, i) => {
      const at = (e.t - t0) / 1000;
      const sheet = join(out, `interrupt-frames-${i + 1}.png`);
      spawnSync('ffmpeg', [
        '-y',
        '-loglevel',
        'error',
        '-ss',
        (at - 0.1).toFixed(3),
        '-t',
        '0.5',
        '-i',
        mp4,
        '-vf',
        "fps=30,scale=520:-2,drawtext=fontfile='C\\:/Windows/Fonts/consola.ttf':text='%{pts\\:hms}':x=6:y=6:fontsize=14:fontcolor=white:box=1:boxcolor=black@0.6,tile=3x5:padding=4:color=white",
        '-frames:v',
        '1',
        sheet,
      ]);
      sheets.push(sheet);
    });
    spawnSync('ffmpeg', [
      '-y',
      '-loglevel',
      'error',
      '-i',
      mp4,
      '-vf',
      'fps=15,scale=640:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=64[p];[b][p]paletteuse=dither=bayer',
      join(out, 'interrupts.gif'),
    ]);
    writeFileSync(
      join(out, 'record.json'),
      JSON.stringify({ region, scaleFactor: S, recordStart: t0, seconds, interrupts: events.map((e) => ({ ...e, atSec: (e.t - t0) / 1000 })), switchStats: stats }, null, 2),
    );
    console.log(`录屏：${mp4}\n对比图：${sheets.join(', ')}\n切换统计：${JSON.stringify(stats)}`);
  } finally {
    await ov.kill();
    await probe.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
