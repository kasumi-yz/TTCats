import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPlatform, readSystemInfo } from './index';

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

describe('诊断用的系统信息', () => {
  it('给出用户目录、用户名、系统版本、CPU 和内存', () => {
    const info = readSystemInfo();
    expect(info.home).not.toBe('');
    expect(info.username).not.toBe('');
    expect(info.os.version).not.toBe('');
    expect(info.cpu.cores).toBeGreaterThan(0);
    expect(info.memory.totalBytes).toBeGreaterThan(info.memory.freeBytes);
  });
});
