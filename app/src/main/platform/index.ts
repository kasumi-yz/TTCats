import * as os from 'node:os';
import type { Platform, SystemInfo } from './types';
import { readWindowsSystemInfo } from './win/system-info';

export type { Platform, ScreenPoint, SystemInfo } from './types';

/** 非 Windows 环境不加载 Windows DLL，也不查询系统按键。 */
export async function createPlatform(): Promise<Platform> {
  if (process.platform === 'win32') {
    const { createWindowsPlatform } = await import('./win');
    return createWindowsPlatform();
  }
  return {
    isFullscreen: () => false,
    isCtrlDown: () => false,
    isLeftButtonDown: () => false,
  };
}

/** 诊断导出用的系统信息。非 Windows 环境（CI 的 Linux）只给出通用字段。 */
export function readSystemInfo(): SystemInfo {
  if (process.platform === 'win32') return readWindowsSystemInfo();
  const cpus = os.cpus();
  return {
    home: os.homedir(),
    username: os.userInfo().username,
    os: { version: os.version(), release: os.release(), arch: os.arch() },
    cpu: { model: cpus[0]?.model.trim() ?? null, cores: cpus.length },
    memory: { totalBytes: os.totalmem(), freeBytes: os.freemem() },
  };
}
