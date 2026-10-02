import type { Platform } from './types';

export type { Platform, ScreenPoint } from './types';

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
