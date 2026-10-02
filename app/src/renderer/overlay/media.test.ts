// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testClip } from '../../core/stage/test-fixtures';
import { hitMaskLayout } from '../../shared/hitmask';

vi.mock('pixi.js', () => ({
  VideoSource: class {
    autoUpdate = true;
    update = vi.fn();
  },
  Texture: class {
    destroy = vi.fn();
    constructor(readonly source: unknown) {}
  },
}));
import { ClipMedia } from './media';

const callbackDescriptor = Object.getOwnPropertyDescriptor(
  HTMLVideoElement.prototype,
  'requestVideoFrameCallback',
);
const cancelDescriptor = Object.getOwnPropertyDescriptor(
  HTMLVideoElement.prototype,
  'cancelVideoFrameCallback',
);
const pause = vi.fn();
beforeEach(() => {
  pause.mockClear();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(pause);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    queueMicrotask(() => this.dispatchEvent(new Event('loadeddata')));
  });
  Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
    configurable: true,
    value: vi.fn(() => 1),
  });
  Object.defineProperty(HTMLVideoElement.prototype, 'cancelVideoFrameCallback', {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (callbackDescriptor)
    Object.defineProperty(
      HTMLVideoElement.prototype,
      'requestVideoFrameCallback',
      callbackDescriptor,
    );
  else Reflect.deleteProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback');
  if (cancelDescriptor)
    Object.defineProperty(HTMLVideoElement.prototype, 'cancelVideoFrameCallback', cancelDescriptor);
  else Reflect.deleteProperty(HTMLVideoElement.prototype, 'cancelVideoFrameCallback');
});

describe('加载新片段时的冻结姿势', () => {
  it.each([
    { name: 'stand-to-sit', pose: 'stand', first: true },
    { name: 'stand-to-sit', pose: 'sit', first: false },
    { name: 'sit-to-stand', pose: 'sit', first: true },
    { name: 'sit-to-stand', pose: 'stand', first: false },
    { name: 'idle-stand', pose: 'stand', first: false },
  ] as const)(
    '$name 接 $pose 姿势时选择对应端点，不能先跳到相反姿势',
    async ({ name, pose, first }) => {
      const clip = testClip(name);
      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.resolve(new Response(new Uint8Array(hitMaskLayout(clip).totalBytes)))),
      );
      const media = await ClipMedia.load('test', clip);
      try {
        media.video.currentTime = 0.2;
        media.freezeForPose(pose);
        expect(media.video.currentTime).toBe(first ? 0 : (clip.frameCount - 1) / clip.fps);
        expect(pause).toHaveBeenCalled();
      } finally {
        media.dispose();
      }
    },
  );
});
