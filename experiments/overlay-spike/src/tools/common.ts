// 测试脚本共用的小工具：启动被测程序、调用控制通道、截屏取像素。

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, normalize } from 'node:path';

export const ROOT = normalize(join(__dirname, '..', '..'));
export const RESULTS = join(ROOT, 'results');
mkdirSync(RESULTS, { recursive: true });

const electronPath = createRequire(join(ROOT, 'package.json'))('electron') as unknown as string;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface Launched {
  proc: ChildProcess;
  port: number;
  get<T = unknown>(path: string): Promise<T>;
  cmd(body: Record<string, unknown>): Promise<unknown>;
  kill(): Promise<void>;
}

/** 启动一个 Electron 入口（dist/main.js 或 dist/probe-main.js），等它打印控制端口 */
export function launch(entry: string, args: string[], label: string): Promise<Launched> {
  return new Promise((resolve, reject) => {
    const proc = spawn(electronPath, [join(ROOT, 'dist', entry), '--control', ...args], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    let quitting = false;
    const timer = setTimeout(() => reject(new Error(`${label} 启动超时`)), 20000);
    proc.stdout!.on('data', (d: Buffer) => {
      buf += d.toString();
      const m = /CONTROL_PORT=(\d+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        const port = Number(m[1]);
        const base = `http://127.0.0.1:${port}`;
        const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
          const res = await fetch(base + path, {
            method,
            body: body ? JSON.stringify(body) : undefined,
          });
          const json = await res.json();
          if (!res.ok) throw new Error(`${label} ${path}: ${JSON.stringify(json)}`);
          return json;
        };
        resolve({
          proc,
          port,
          get: (path) => call('GET', path) as Promise<never>,
          cmd: (body) => call('POST', '/cmd', body),
          kill: async () => {
            quitting = true;
            try {
              await call('POST', '/cmd', { type: 'quit' });
            } catch {
              /* 已经退出 */
            }
            await Promise.race([new Promise((r) => proc.once('exit', r)), sleep(3000)]);
            if (proc.exitCode === null) proc.kill();
          },
        });
      }
    });
    proc.stderr!.on('data', (d: Buffer) => {
      const s = d.toString();
      // Chromium 的常见噪音不打印
      if (!/GPU cache|disk_cache|DevTools|Autofill|shared_image|gpu_process_host/.test(s)) process.stderr.write(`[${label}] ${s}`);
    });
    proc.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (!quitting) console.error(`[${label}] 意外退出：退出码 ${code}，信号 ${signal}`);
      if (!buf.includes('CONTROL_PORT')) reject(new Error(`${label} 提前退出，退出码 ${code}`));
    });
  });
}

/** 等待某个条件成立，返回耗时（ms）；超时返回 null */
export async function waitFor(cond: () => Promise<boolean> | boolean, timeoutMs: number, stepMs = 10): Promise<number | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await cond()) return Date.now() - t0;
    await sleep(stepMs);
  }
  return null;
}

/**
 * 用 ffmpeg 截取屏幕上一个小区域（物理像素），返回中心点的 RGB。
 * method = gdigrab（GDI BitBlt，QQ/微信一类老截图工具的做法）或 ddagrab（DXGI 桌面复制，OBS 显示器采集的做法）。
 */
export function grabPixel(method: 'gdigrab' | 'ddagrab', x: number, y: number): [number, number, number] | null {
  const size = 8;
  const ox = Math.max(0, Math.round(x - size / 2));
  const oy = Math.max(0, Math.round(y - size / 2));
  const input =
    method === 'gdigrab'
      ? ['-f', 'gdigrab', '-framerate', '5', '-offset_x', String(ox), '-offset_y', String(oy), '-video_size', `${size}x${size}`, '-i', 'desktop']
      : ['-f', 'lavfi', '-i', `ddagrab=output_idx=0:framerate=5:offset_x=${ox}:offset_y=${oy}:video_size=${size}x${size}:draw_mouse=0,hwdownload,format=bgra`];
  const r = spawnSync('ffmpeg', ['-loglevel', 'error', ...input, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {
    maxBuffer: 1 << 20,
  });
  if (r.status !== 0 || r.stdout.length < size * size * 3) return null;
  const o = ((size / 2) * size + size / 2) * 3;
  return [r.stdout[o], r.stdout[o + 1], r.stdout[o + 2]];
}

export function colorDist(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
