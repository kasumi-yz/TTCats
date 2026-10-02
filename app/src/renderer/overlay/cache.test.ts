import { describe, expect, it, vi } from 'vitest';
import { ClipCache } from './cache';
function deferred() {
  let resolve!: (value: { dispose: () => void }) => void;
  const promise = new Promise<{ dispose: () => void }>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe('片段按需加载缓存', () => {
  it('保留当前及最近两段，淘汰最久未用的片段并释放解码资源', async () => {
    const disposed: string[] = [];
    const cache = new ClipCache((key) =>
      Promise.resolve({
        dispose: () => {
          disposed.push(key);
        },
      }),
    );
    for (const key of ['stand', 'sit', 'sleep', 'walk']) {
      await cache.request(key);
      cache.activate(key);
    }
    expect(cache.keys()).toEqual(['sit', 'sleep', 'walk']);
    expect(disposed).toEqual(['stand']);
    await cache.request('sit');
    cache.activate('sit');
    await cache.request('dangle');
    cache.activate('dangle');
    expect(disposed).toEqual(['stand', 'sleep']);
    expect(cache.keys()).toEqual(['sit', 'walk', 'dangle']);
  });
  it('快速连续打断时不能释放当前或任何仍在加载的片段', async () => {
    const pending = new Map<string, ReturnType<typeof deferred>>();
    const cache = new ClipCache((key) => {
      const loading = deferred();
      pending.set(key, loading);
      return loading.promise;
    });
    const disposed = vi.fn();
    const stand = cache.request('stand');
    await Promise.resolve();
    pending.get('stand')?.resolve({ dispose: disposed });
    await stand;
    cache.activate('stand');
    const sit = cache.request('sit');
    const walk = cache.request('walk');
    const sleep = cache.request('sleep');
    const dangle = cache.request('dangle');
    await Promise.resolve();
    for (const key of ['walk', 'sleep', 'dangle']) pending.get(key)?.resolve({ dispose: vi.fn() });
    await Promise.all([walk, sleep, dangle]);
    expect(cache.keys()).toContain('stand');
    expect(cache.keys()).toContain('sit');
    expect(disposed).not.toHaveBeenCalled();
    pending.get('sit')?.resolve({ dispose: vi.fn() });
    await sit;
    cache.dispose();
    expect(disposed).toHaveBeenCalledOnce();
  });
  it('重复请求同一片段只加载一次；加载失败后可重试', async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('missing'))
      .mockResolvedValue({ dispose: vi.fn() });
    const cache = new ClipCache<{ dispose: () => void }>(load);
    const first = cache.request('stand');
    expect(cache.request('stand')).toBe(first);
    await expect(first).rejects.toThrow('missing');
    await cache.request('stand');
    expect(load).toHaveBeenCalledTimes(2);
  });
  it('隐藏或关闭时，未完成的加载完成后也会释放而不能复活', async () => {
    const loading = deferred();
    const cache = new ClipCache(() => loading.promise);
    const result = cache.request('sit');
    cache.dispose();
    const dispose = vi.fn();
    loading.resolve({ dispose });
    await result;
    expect(dispose).toHaveBeenCalledOnce();
    expect(cache.keys()).toEqual([]);
  });
});
