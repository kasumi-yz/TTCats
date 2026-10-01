import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPlatform } from './index';

afterEach(() => vi.unstubAllGlobals());

describe('非 Windows 的桌面层系统状态', () => {
  it.each(['linux', 'darwin'])('%s 不加载 Windows DLL，查询结果均为未触发', async (os) => {
    vi.stubGlobal('process', { platform: os });
    const platform = await createPlatform();
    expect(platform.isFullscreen()).toBe(false);
    expect(platform.isCtrlDown()).toBe(false);
    expect(platform.isLeftButtonDown()).toBe(false);
  });
});
