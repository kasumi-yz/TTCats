// 独立进程的真实 DPI 不感知回归窗口。预检只创建在屏幕外，不激活用户窗口。
import { spawn } from 'node:child_process';
import { join } from 'node:path';

export async function createLegacyWindow(left: number, top: number) {
  const child = spawn(
    'powershell',
    [
      '-NoProfile',
      '-File',
      join(import.meta.dirname, 'window-ledges-fixture.ps1'),
      '-ParentId',
      String(process.pid),
      '-Left',
      String(left),
      '-Top',
      String(top),
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const ended = new Promise<void>((resolve) => {
    child.once('close', () => {
      resolve();
    });
  });
  const close = async (): Promise<void> => {
    if (child.exitCode === null && !child.killed) child.kill();
    await ended;
  };
  let output = '',
    errorOutput = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (data: string) => {
    errorOutput += data;
  });
  try {
    const id = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('创建独立 Legacy 窗口超过 10 秒。'));
      }, 10000);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', () => {
        clearTimeout(timer);
        reject(new Error(errorOutput || 'Legacy 进程提前退出。'));
      });
      child.stdout.on('data', (data: string) => {
        output += data;
        const match = /HWND:(\d+)/.exec(output);
        if (match?.[1]) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
    });
    return { id, close };
  } catch (error) {
    await close();
    throw error;
  }
}
