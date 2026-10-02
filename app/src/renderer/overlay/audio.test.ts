import { describe, expect, it, vi } from 'vitest';
import { OverlayAudio } from './audio';
import { snapshot } from '../../core/stage/test-fixtures';
import type { CatPlacement, SoundCue, StageFrame } from '../../shared/core-api';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}
function fixture() {
  const sources: ReturnType<typeof source>[] = [];
  const gains: ReturnType<typeof gain>[] = [];
  function source() {
    return {
      buffer: null,
      loop: false,
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: undefined as (() => void) | undefined,
    };
  }
  function gain() {
    return {
      connect: vi.fn(),
      disconnect: vi.fn(),
      gain: {
        value: 0.6,
        setValueAtTime: vi.fn(),
        cancelScheduledValues: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
      },
    };
  }
  const context = {
    state: 'running',
    currentTime: 1,
    destination: {},
    suspend: vi.fn(() => {
      context.state = 'suspended';
      return Promise.resolve();
    }),
    resume: vi.fn(() => {
      context.state = 'running';
      return Promise.resolve();
    }),
    close: vi.fn(() => {
      context.state = 'closed';
      return Promise.resolve();
    }),
    decodeAudioData: vi.fn(() => Promise.resolve({} as AudioBuffer)),
    createBufferSource: () => {
      const item = source();
      sources.push(item);
      return item;
    },
    createGain: () => {
      const item = gain();
      gains.push(item);
      return item;
    },
  };
  const read = vi.fn<typeof fetch>(() => Promise.resolve(new Response(new ArrayBuffer(8))));
  const failed = vi.fn();
  const create = vi.fn(() => context as unknown as AudioContext);
  let now = 0;
  const audio = new OverlayAudio(failed, create, read, () => now);
  audio.applySnapshot(snapshot(['cat', 'other']));
  return {
    audio,
    context,
    sources,
    gains,
    read,
    failed,
    create,
    setNow: (value: number) => {
      now = value;
    },
  };
}
const meow: SoundCue = { cat: 'cat', sound: 'meow', action: 'start', file: 'sounds/m.wav' };
const purr: SoundCue = { cat: 'cat', sound: 'purr', action: 'start', file: 'sounds/p.wav' };
function frame(sounds: SoundCue[] = [], cats = ['cat', 'other']): StageFrame {
  return { cats: cats.map((cat) => ({ cat }) as CatPlacement), sounds, bubbles: [], effects: [] };
}

describe('桌面层声音播放', () => {
  it('默认音量分别为 0.3 和 0.6，声音解码缓存，播完挂起，下次恢复', async () => {
    const f = fixture();
    expect(f.audio.inspect()).toEqual({ playing: [], suspended: true });
    expect(f.create).not.toHaveBeenCalled();
    f.audio.update(frame([meow, purr]));
    await flush();
    expect(f.sources.map((s) => s.loop)).toEqual([false, true]);
    expect(f.gains[0]?.gain.setValueAtTime).toHaveBeenCalledWith(0.3, 1);
    expect(f.gains[1]?.gain.setValueAtTime).toHaveBeenCalledWith(0.6, 1);
    expect(f.read.mock.calls[0]?.[0]).toBe('ttcats-content://cats/cat/sounds/m.wav');
    f.sources.forEach((s) => s.onended?.());
    await flush();
    expect(f.audio.inspect()).toEqual({ playing: [], suspended: true });
    f.audio.update(frame([meow]));
    await flush();
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.context.decodeAudioData).toHaveBeenCalledTimes(2);
    expect(f.sources[2]?.start).toHaveBeenCalledOnce();
  });

  it('声音开关和零音量禁止新播放，音量变化作用于正在播的声音', async () => {
    const f = fixture();
    f.audio.applySnapshot(snapshot(['cat'], { meowEnabled: false, purrVolume: 0 }, 2));
    f.audio.update(frame([meow, purr]));
    await flush();
    expect(f.create).not.toHaveBeenCalled();
    f.audio.applySnapshot(snapshot(['cat'], {}, 3));
    f.audio.update(frame([meow, purr]));
    await flush();
    f.audio.applySnapshot(snapshot(['cat'], { meowVolume: 0.2, purrVolume: 0.4 }, 4));
    expect(f.gains[0]?.gain.setValueAtTime).toHaveBeenLastCalledWith(0.2, 1);
    expect(f.gains[1]?.gain.setValueAtTime).toHaveBeenLastCalledWith(0.4, 1);
    f.audio.applySnapshot(snapshot(['cat'], { meowEnabled: false, purrEnabled: false }, 5));
    expect(f.sources.every((s) => s.stop.mock.calls.length === 1)).toBe(true);
  });

  it.each(['quietHours', 'doNotDisturb', 'startupQuiet'] as const)(
    '%s 停喵叫、淡出呼噜并拒绝新声音',
    async (reason) => {
      const f = fixture();
      f.audio.update(frame([meow, purr]));
      await flush();
      f.audio.applySnapshot({ ...snapshot(['cat'], {}, 2), silencedBy: [reason] });
      expect(f.sources[0]?.stop).toHaveBeenCalledWith();
      expect(f.sources[1]?.stop).toHaveBeenCalledWith(1.15);
      expect(f.gains[1]?.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, 1.15);
      f.audio.update(frame([meow, purr]));
      await flush();
      expect(f.sources).toHaveLength(2);
      f.sources.forEach((s) => s.onended?.());
      await flush();
      expect(f.audio.inspect().suspended).toBe(true);
    },
  );

  it.each(['pause', 'hideAll', 'hidden', 'exit'] as const)(
    '%s 停掉声音且恢复后不补播',
    async (reason) => {
      const f = fixture();
      f.audio.update(frame([purr]));
      await flush();
      if (reason === 'pause') f.audio.setPaused(true);
      if (reason === 'hideAll')
        f.audio.applySnapshot({ ...snapshot(['cat'], {}, 2), hideAll: true });
      if (reason === 'hidden') f.audio.applySnapshot(snapshot([], {}, 2));
      if (reason === 'exit') f.audio.update(frame([], []));
      expect(f.sources[0]?.stop).toHaveBeenCalledOnce();
      f.sources[0]?.onended?.();
      await flush();
      f.audio.setPaused(false);
      f.audio.applySnapshot(snapshot(['cat'], {}, 3));
      f.audio.update(frame());
      await flush();
      expect(f.sources).toHaveLength(1);
      expect(f.audio.inspect()).toEqual({ playing: [], suspended: true });
    },
  );

  it.each(['stop', 'pause', 'silence', 'exit', 'dispose', 'stale'] as const)(
    '加载未完成时 %s，迟到的声音不能启动',
    async (reason) => {
      const f = fixture();
      const response = deferred<Response>();
      f.read.mockReturnValue(response.promise);
      f.audio.update(frame([purr]));
      await flush();
      if (reason === 'stop') f.audio.update(frame([{ cat: 'cat', sound: 'purr', action: 'stop' }]));
      if (reason === 'pause') f.audio.setPaused(true);
      if (reason === 'silence')
        f.audio.applySnapshot({ ...snapshot(['cat'], {}, 2), silencedBy: ['quietHours'] });
      if (reason === 'exit') f.audio.update(frame([], []));
      if (reason === 'dispose') f.audio.dispose();
      if (reason === 'stale') f.setNow(1001);
      response.resolve(new Response(new ArrayBuffer(8)));
      await flush();
      expect(f.sources).toHaveLength(0);
      expect(f.audio.inspect().suspended).toBe(true);
    },
  );

  it('resume 未完成时暂停，恢复上下文后仍不能补播且重新挂起', async () => {
    const f = fixture();
    const resumed = deferred<undefined>();
    f.context.resume.mockImplementation(async () => {
      await resumed.promise;
      f.context.state = 'running';
    });
    f.audio.update(frame([purr]));
    await flush();
    f.audio.setPaused(true);
    resumed.resolve(undefined);
    await flush();
    expect(f.sources).toHaveLength(0);
    expect(f.context.state).toBe('suspended');
  });

  it('一只猫停止不影响另一只，同类新声音不会被旧声音的结束回调删除', async () => {
    const f = fixture();
    f.audio.update(frame([purr, { ...purr, cat: 'other' }]));
    await flush();
    f.audio.update(frame([purr]));
    await flush();
    f.sources[0]?.onended?.();
    await flush();
    expect(f.sources[1]?.stop).not.toHaveBeenCalled();
    expect(f.context.state).toBe('running');
    f.audio.update(frame([{ cat: 'cat', sound: 'purr', action: 'stop' }]));
    expect(f.sources[2]?.stop).toHaveBeenCalledOnce();
  });

  it('设备拒绝恢复时报告猫和文件，清理后允许重试', async () => {
    const f = fixture();
    f.context.resume.mockRejectedValueOnce(new Error('device unavailable'));
    f.audio.update(frame([meow]));
    await flush();
    expect(String(f.failed.mock.calls[0]?.[0])).toContain('cat：无法播放声音文件 sounds/m.wav');
    expect(f.audio.inspect()).toEqual({ playing: [], suspended: true });
    f.audio.update(frame([meow]));
    await flush();
    expect(f.sources[0]?.start).toHaveBeenCalledOnce();
  });

  it('加载失败报出猫与文件，失败缓存清除可重试', async () => {
    const f = fixture();
    f.read.mockResolvedValueOnce(new Response(null, { status: 404 }));
    f.audio.update(frame([meow]));
    await flush();
    expect(String(f.failed.mock.calls[0]?.[0])).toContain('cat：无法播放声音文件 sounds/m.wav');
    expect(f.context.state).toBe('suspended');
    f.audio.update(frame([meow]));
    await flush();
    expect(f.sources[0]?.start).toHaveBeenCalledOnce();
  });
});
