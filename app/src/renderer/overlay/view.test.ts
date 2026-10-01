// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatPlacement, StageCore } from '../../shared/core-api';
import { catalog, testCat, testClip } from '../../core/stage/test-fixtures';
import type { OverlayBridge, StageCommand, StateSnapshot } from '../../shared/ipc';
import { defaultSettings } from '../../shared/schemas/settings';

const mock = vi.hoisted(() => ({
  ready: Promise.resolve(),
  draw: () => {},
  load: vi.fn(),
  sprite: vi.fn(function () {
    return {
      visible: false,
      texture: {},
      scale: { set: vi.fn() },
      pivot: { set: vi.fn() },
      position: { set: vi.fn() },
    };
  }),
}));
vi.mock('./media', () => ({ ClipMedia: { load: mock.load } }));
vi.mock('pixi.js', () => ({
  Application: class {
    canvas = document.createElement('canvas');
    ticker = {
      maxFPS: 0,
      add: (draw: () => void) => {
        mock.draw = draw;
      },
    };
    stage = { addChild: vi.fn(), setChildIndex: vi.fn(), children: [] };
    init() {
      return mock.ready;
    }
    destroy = vi.fn();
  },
  Container: class {
    removeChildren = () => [];
  },
  Texture: vi.fn(),
  VideoSource: vi.fn(),
  Sprite: mock.sprite,
  Graphics: vi.fn(),
  Text: vi.fn(),
}));
import { createOverlayView } from './view';

beforeEach(() => {
  mock.ready = Promise.resolve();
  mock.load.mockReset();
});

function setup() {
  const snapshot: StateSnapshot = { revision: 1, at: 0, settings: defaultSettings([]) };
  let onSnapshot: ((snapshot: StateSnapshot) => void) | undefined;
  let onCommand: ((command: StageCommand) => void) | undefined;
  const off = vi.fn();
  const bridge: OverlayBridge = {
    sendCommand: vi.fn(),
    sendFact: vi.fn(),
    sendOverlay: vi.fn(),
    getSnapshot: () => Promise.resolve(snapshot),
    getContent: () => Promise.resolve({ cats: {}, disabled: [] }),
    onSnapshot: (listener) => {
      onSnapshot = listener;
      return off;
    },
    onStageCommand: (listener) => {
      onCommand = listener;
      return off;
    },
    onOverlay: () => off,
  };
  const applySnapshot = vi.fn();
  const handleCommand = vi.fn();
  const handlePointer = vi.fn();
  const stage: StageCore = {
    applySnapshot,
    handleCommand,
    handlePointer,
    setGhostMode: vi.fn(),
    setBounds: vi.fn(),
    update: () => ({ cats: [], bubbles: [], effects: [] }),
    drainFacts: () => [],
    debugReport: (at) => ({ at, cats: [] }),
  };
  return {
    applySnapshot,
    handleCommand,
    handlePointer,
    snapshot,
    bridge,
    stage,
    off,
    pushSnapshot: () => onSnapshot?.(snapshot),
    pushCommand: () => onCommand?.({ type: 'cat/sleep', cat: 'test' }),
  };
}
describe('桌面层启动时序', () => {
  it('画布尚未初始化时也不能丢失设置快照和桌面层命令', async () => {
    let ready!: () => void;
    mock.ready = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const fixture = setup();
    const starting = createOverlayView({ cats: {}, disabled: [] }, fixture.stage, fixture.bridge);
    fixture.pushSnapshot();
    fixture.pushCommand();
    expect(fixture.applySnapshot).toHaveBeenCalledWith(fixture.snapshot, expect.any(Number));
    expect(fixture.handleCommand).toHaveBeenCalledWith(
      { type: 'cat/sleep', cat: 'test' },
      expect.any(Number),
    );
    ready();
    const view = await starting;
    view.dispose();
    expect(fixture.off).toHaveBeenCalledTimes(3);
  });
  it('画布初始化失败时取消已注册的监听，不能留下失效桌面层', async () => {
    mock.ready = Promise.reject(new Error('WebGL unavailable'));
    const fixture = setup();
    await expect(
      createOverlayView({ cats: {}, disabled: [] }, fixture.stage, fixture.bridge),
    ).rejects.toThrow('WebGL unavailable');
    expect(fixture.off).toHaveBeenCalledTimes(2);
  });
});

describe('未缓存片段的朝向切换', () => {
  it.each([false, true])(
    '旧片段镜像为 %s 时，加载期间画面和点击区域都保持原朝向',
    async (mirrored) => {
      const fixture = setup();
      const oldClip = testClip('idle-stand', {
        facing: mirrored ? 'left' : 'right',
        width: 8,
        height: 8,
        frameCount: 1,
        hitMaskScale: 1,
        footAnchors: [{ x: 4, y: 7 }],
      });
      const newClip = { ...oldClip, name: 'walk', facing: mirrored ? 'right' : 'left' } as const;
      const mask = new Uint8Array(8);
      mask[2] = 1 << 2; // 非对称遮罩，让错误镜像也会导致点击测试失败。
      const oldMedia = {
        clip: oldClip,
        frame: 0,
        mask,
        texture: {},
        video: { pause: vi.fn() },
        freezeLastFrame: vi.fn(),
        sync: vi.fn(),
        dispose: vi.fn(),
      };
      const newMedia = { ...oldMedia, clip: newClip, texture: {} };
      let finishLoading!: (media: typeof newMedia) => void;
      mock.load.mockResolvedValueOnce(oldMedia).mockImplementationOnce(
        () =>
          new Promise<typeof newMedia>((resolve) => {
            finishLoading = resolve;
          }),
      );
      const placement: CatPlacement = {
        cat: 'test',
        clip: oldClip.name,
        variant: 1,
        clipTimeMs: 0,
        playbackRate: 1,
        x: 100,
        y: 100,
        scale: 2,
        mirrored,
        depth: 0,
        pose: 'stand',
      };
      fixture.stage.update = () => ({ cats: [placement], bubbles: [], effects: [] });
      const view = await createOverlayView(
        catalog([{ cat: testCat('test'), clips: [oldClip, newClip] }]),
        fixture.stage,
        fixture.bridge,
      );
      try {
        mock.draw();
        await vi.waitFor(() => {
          expect(view.inspect().cats[0]?.current).toBe('idle-stand:1');
        });
        mock.draw();
        const result = mock.sprite.mock.results.at(-1);
        if (!result || result.type !== 'return') throw new Error('测试猫画面未创建');
        const sprite = result.value;
        const oldScale = mirrored ? -2 : 2;
        expect(sprite.scale.set).toHaveBeenLastCalledWith(oldScale, 2);
        const move = (x: number) => {
          window.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: 91 }));
        };
        const oldHitX = 100 - 1.5 * oldScale;
        move(oldHitX);
        expect(fixture.handlePointer).toHaveBeenLastCalledWith(
          { type: 'move', x: oldHitX, y: 91, cat: 'test' },
          expect.any(Number),
        );

        // 两段素材的原始朝向相反，但 StageCore 要求猫在屏幕上继续朝右。
        placement.clip = newClip.name;
        placement.mirrored = !mirrored;
        mock.draw();
        await vi.waitFor(() => {
          expect(mock.load).toHaveBeenCalledTimes(2);
        });
        mock.draw();
        expect(sprite.texture).toBe(oldMedia.texture);
        expect(sprite.scale.set).toHaveBeenLastCalledWith(oldScale, 2);
        move(oldHitX);
        expect(fixture.handlePointer).toHaveBeenLastCalledWith(
          { type: 'move', x: oldHitX, y: 91, cat: 'test' },
          expect.any(Number),
        );

        finishLoading(newMedia);
        await vi.waitFor(() => {
          expect(view.inspect().cats[0]?.current).toBe('walk:1');
        });
        // 纹理和翻转必须同时切换，不能等下一次 draw 才修正朝向。
        expect(sprite.texture).toBe(newMedia.texture);
        expect(sprite.scale.set).toHaveBeenLastCalledWith(-oldScale, 2);
        move(oldHitX);
        expect(fixture.handlePointer).toHaveBeenLastCalledWith(
          { type: 'move', x: oldHitX, y: 91, cat: null },
          expect.any(Number),
        );
        move(200 - oldHitX);
        expect(fixture.handlePointer).toHaveBeenLastCalledWith(
          { type: 'move', x: 200 - oldHitX, y: 91, cat: 'test' },
          expect.any(Number),
        );
        mock.draw();
        expect(sprite.scale.set).toHaveBeenLastCalledWith(-oldScale, 2);
      } finally {
        view.dispose();
      }
    },
  );
});
