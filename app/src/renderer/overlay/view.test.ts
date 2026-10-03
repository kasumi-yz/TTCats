// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatPlacement, StageCore, StageFrame } from '../../shared/core-api';
import type { Clip } from '../../shared/schemas';
import { catalog, testCat, testClip } from '../../core/stage/test-fixtures';
import type { MainToOverlay, OverlayBridge, StageCommand, StateSnapshot } from '../../shared/ipc';
import { defaultSettings } from '../../shared/schemas/settings';

const mock = vi.hoisted(() => {
  class Container {
    static instances: Container[] = [];
    children: unknown[] = [];
    position = { set: vi.fn() };
    alpha = 1;
    destroy = vi.fn();
    constructor() {
      Container.instances.push(this);
    }
    addChild(...children: unknown[]) {
      for (const child of children) {
        this.children = this.children.filter((entry) => entry !== child);
        this.children.push(child);
      }
    }
    setChildIndex(child: unknown, index: number) {
      this.children = this.children.filter((entry) => entry !== child);
      this.children.splice(index, 0, child);
    }
  }
  class Graphics {
    static instances: Graphics[] = [];
    position = { set: vi.fn() };
    scale = { set: vi.fn() };
    alpha = 1;
    destroy = vi.fn();
    clear = vi.fn(() => this);
    roundRect = vi.fn(() => this);
    fill = vi.fn(() => this);
    moveTo = vi.fn(() => this);
    bezierCurveTo = vi.fn(() => this);
    circle = vi.fn(() => this);
    constructor() {
      Graphics.instances.push(this);
    }
  }
  class Text {
    static instances: Text[] = [];
    anchor = { set: vi.fn() };
    position = { set: vi.fn() };
    text: string;
    height = 16;
    get width() {
      return this.text.length * 8;
    }
    constructor(options: { text: string }) {
      this.text = options.text;
      Text.instances.push(this);
    }
  }
  return {
    Container,
    Graphics,
    Text,
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
        destroy: vi.fn(),
      };
    }),
  };
});
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
    stage = new mock.Container();
    start = vi.fn();
    stop = vi.fn();
    init() {
      return mock.ready;
    }
    destroy = vi.fn();
  },
  Container: mock.Container,
  Texture: vi.fn(),
  VideoSource: vi.fn(),
  Sprite: mock.sprite,
  Graphics: mock.Graphics,
  Text: mock.Text,
}));
import { createOverlayView } from './view';

beforeEach(() => {
  mock.ready = Promise.resolve();
  mock.load.mockReset();
  mock.sprite.mockClear();
  mock.Container.instances.length = 0;
  mock.Graphics.instances.length = 0;
  mock.Text.instances.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  const snapshot: StateSnapshot = {
    revision: 1,
    at: 0,
    settings: defaultSettings([]),
    doNotDisturb: { mode: 'off' },
    hideAll: false,
    silencedBy: [],
    clockOffsetMs: 0,
    events: { lastTriggeredAt: {}, firstLaunchHandledOn: null },
  };
  let onSnapshot: ((snapshot: StateSnapshot) => void) | undefined;
  let onCommand: ((command: StageCommand) => void) | undefined;
  let onOverlay: ((message: MainToOverlay) => void) | undefined;
  const off = vi.fn();
  const sendOverlay = vi.fn();
  const bridge: OverlayBridge = {
    sendCommand: vi.fn(),
    sendFact: vi.fn(),
    sendOverlay,
    getSnapshot: () => Promise.resolve(snapshot),
    getContent: () => Promise.resolve({ cats: {}, disabled: [], events: {} }),
    onSnapshot: (listener) => {
      onSnapshot = listener;
      return off;
    },
    onStageCommand: (listener) => {
      onCommand = listener;
      return off;
    },
    onOverlay: (listener) => {
      onOverlay = listener;
      return off;
    },
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
    setLedges: vi.fn(),
    update: () => ({ cats: [], bubbles: [], effects: [], sounds: [] }),
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
    sendOverlay,
    pushSnapshot: () => onSnapshot?.(snapshot),
    pushCommand: () => onCommand?.({ type: 'cat/sleep', cat: 'test' }),
    pushOverlay: (message: MainToOverlay) => onOverlay?.(message),
  };
}

function placement(cat: string, clip = 'idle-stand'): CatPlacement {
  return {
    cat,
    clip,
    variant: 1,
    clipTimeMs: 0,
    playbackRate: 1,
    x: 100,
    y: 100,
    scale: 1,
    mirrored: false,
    depth: 0,
    pose: 'stand',
  };
}
function media(clip: Clip) {
  return {
    clip,
    frame: 0,
    mask: new Uint8Array(Math.ceil((clip.width * clip.height) / 8) * clip.frameCount).fill(255),
    texture: {},
    video: { pause: vi.fn() },
    freezeForPose: vi.fn(),
    sync: vi.fn(),
    dispose: vi.fn(),
  };
}
const smallClip = () =>
  testClip('idle-stand', {
    width: 8,
    height: 8,
    frameCount: 1,
    hitMaskScale: 1,
    footAnchors: [{ x: 4, y: 7 }],
  });

describe('桌面层审查回归', () => {
  it('穿透点击按消息坐标和最前猫的遮罩转发，幽灵模式也保留命中，暂停时丢弃', async () => {
    const fixture = setup();
    const clip = smallClip();
    mock.load.mockImplementation((_cat: string, loaded: Clip) => Promise.resolve(media(loaded)));
    fixture.stage.update = () => ({
      cats: [placement('a'), placement('b')],
      bubbles: [],
      effects: [],
      sounds: [],
    });
    const view = await createOverlayView(
      catalog([
        { cat: testCat('a'), clips: [clip] },
        { cat: testCat('b'), clips: [clip] },
      ]),
      fixture.stage,
      fixture.bridge,
    );
    try {
      mock.draw();
      await vi.waitFor(() => {
        expect(view.inspect().cats.every((cat) => cat.visible)).toBe(true);
      });
      fixture.pushOverlay({ type: 'ghost', active: true });
      fixture.pushOverlay({ type: 'clickThrough', x: 100, y: 95 });
      expect(fixture.handlePointer).toHaveBeenLastCalledWith(
        { type: 'clickThrough', x: 100, y: 95, cat: 'b' },
        expect.any(Number),
      );
      fixture.pushOverlay({ type: 'clickThrough', x: 200, y: 95 });
      expect(fixture.handlePointer).toHaveBeenLastCalledWith(
        { type: 'clickThrough', x: 200, y: 95, cat: null },
        expect.any(Number),
      );
      fixture.pushOverlay({ type: 'paused', paused: true });
      fixture.handlePointer.mockClear();
      fixture.pushOverlay({ type: 'clickThrough', x: 200, y: 95 });
      expect(fixture.handlePointer).not.toHaveBeenCalled();
    } finally {
      view.dispose();
    }
  });
  it('同纵深时点击最前面的猫，绘制顺序变化后不能沿用创建顺序', async () => {
    const fixture = setup();
    const clip = smallClip();
    mock.load.mockImplementation((_cat: string, loaded: Clip) => Promise.resolve(media(loaded)));
    let order = [placement('a'), placement('b')];
    fixture.stage.update = () => ({ cats: order, bubbles: [], effects: [], sounds: [] });
    const view = await createOverlayView(
      catalog([
        { cat: testCat('a'), clips: [clip] },
        { cat: testCat('b'), clips: [clip] },
      ]),
      fixture.stage,
      fixture.bridge,
    );
    try {
      mock.draw();
      await vi.waitFor(() => {
        expect(view.inspect().cats.every((cat) => cat.visible)).toBe(true);
      });
      mock.draw();
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100, clientY: 95 }));
      expect(fixture.handlePointer).toHaveBeenLastCalledWith(
        { type: 'move', x: 100, y: 95, cat: 'b' },
        expect.any(Number),
      );
      order = [placement('b'), placement('a')];
      mock.draw();
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100, clientY: 95 }));
      expect(fixture.handlePointer).toHaveBeenLastCalledWith(
        { type: 'move', x: 100, y: 95, cat: 'a' },
        expect.any(Number),
      );
      const sprites = mock.sprite.mock.results
        .filter((result) => result.type === 'return')
        .map((result) => result.value);
      expect(view.app.stage.children.slice(0, 2)).toEqual([sprites[1], sprites[0]]);
    } finally {
      view.dispose();
    }
  });

  it('鼠标在同一命中状态内移动不重复发 hover，进入和离开立即通知，50ms 定时器继续续租', async () => {
    vi.useFakeTimers();
    const fixture = setup();
    const clip = smallClip();
    mock.load.mockResolvedValue(media(clip));
    fixture.stage.update = () => ({
      cats: [placement('test')],
      bubbles: [],
      effects: [],
      sounds: [],
    });
    const view = await createOverlayView(
      catalog([{ cat: testCat('test'), clips: [clip] }]),
      fixture.stage,
      fixture.bridge,
    );
    const send = fixture.sendOverlay;
    try {
      mock.draw();
      await vi.advanceTimersByTimeAsync(0);
      mock.draw();
      const move = (x: number) =>
        window.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: 95 }));
      move(0);
      send.mockClear();
      for (let i = 0; i < 100; i++) move(i % 10);
      expect(send).not.toHaveBeenCalled();
      move(100);
      for (let i = 0; i < 100; i++) move(100 + (i % 2));
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenLastCalledWith({ type: 'hover', onCat: true });
      await vi.advanceTimersByTimeAsync(50);
      expect(send).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenLastCalledWith({ type: 'hover', onCat: true });
      move(0);
      expect(send).toHaveBeenLastCalledWith({ type: 'hover', onCat: false });
      expect(send).toHaveBeenCalledTimes(3);
    } finally {
      view.dispose();
    }
  });

  it('冷加载用新片段的姿势冻结旧过渡，不因朝向修正丢掉姿势信息', async () => {
    const fixture = setup();
    const clip = testClip('stand-to-sit');
    const old = media(clip);
    mock.load.mockResolvedValueOnce(old).mockImplementationOnce(() => new Promise(() => {}));
    const p = placement('test', clip.name);
    fixture.stage.update = () => ({ cats: [p], bubbles: [], effects: [], sounds: [] });
    const view = await createOverlayView(
      catalog([{ cat: testCat('test'), clips: [clip, testClip('idle-stand')] }]),
      fixture.stage,
      fixture.bridge,
    );
    try {
      mock.draw();
      await vi.waitFor(() => {
        expect(view.inspect().cats[0]?.visible).toBe(true);
      });
      p.clip = 'idle-stand';
      mock.draw();
      expect(old.freezeForPose).toHaveBeenCalledWith('stand');
    } finally {
      view.dispose();
    }
  });

  it('气泡有白底并跟随实际帧锚点，同一文字和特效复用对象，结束时销毁', async () => {
    const fixture = setup();
    const clip = smallClip();
    const current = media(clip);
    mock.load.mockResolvedValue(current);
    const p = placement('test');
    p.scale = 2;
    const frame: StageFrame = {
      cats: [p],
      bubbles: [{ cat: 'test', text: '喵', ageMs: 150 }],
      effects: [{ id: 7, effect: 'hearts', x: 100, y: 70, ageMs: 150, durationMs: 1200 }],
      sounds: [],
    };
    fixture.stage.update = () => frame;
    const view = await createOverlayView(
      catalog([{ cat: testCat('test'), clips: [clip] }]),
      fixture.stage,
      fixture.bridge,
    );
    try {
      mock.draw();
      await vi.waitFor(() => {
        expect(view.inspect().cats[0]?.visible).toBe(true);
      });
      mock.draw();
      const bubble = mock.Container.instances.at(-1);
      const background = mock.Graphics.instances.find(
        (graphics) => graphics.roundRect.mock.calls.length > 0,
      );
      const heart = mock.Graphics.instances.find(
        (graphics) => graphics.moveTo.mock.calls.length > 0,
      );
      expect(background?.fill).toHaveBeenCalledWith({ color: 0xffffff, alpha: 0.95 });
      expect(bubble?.position.set).toHaveBeenLastCalledWith(100, 78);
      expect(mock.Text.instances).toHaveLength(1);
      expect(mock.Graphics.instances).toHaveLength(2);
      const backgrounds = background?.clear.mock.calls.length;
      const bubbleData = frame.bubbles[0];
      const effectData = frame.effects[0];
      if (!bubbleData || !effectData) throw new Error('测试气泡或特效缺失');
      bubbleData.ageMs = 200;
      effectData.ageMs = 200;
      for (let i = 0; i < 10; i++) mock.draw();
      expect(mock.Text.instances).toHaveLength(1);
      expect(mock.Graphics.instances).toHaveLength(2);
      expect(background?.clear.mock.calls.length).toBe(backgrounds);
      bubbleData.text = '喵喵';
      mock.draw();
      expect(mock.Text.instances[0]?.text).toBe('喵喵');
      expect(background?.clear.mock.calls.length).toBe((backgrounds ?? 0) + 1);
      current.clip.footAnchors[0] = { x: 4, y: 5 };
      mock.draw();
      expect(bubble?.position.set).toHaveBeenLastCalledWith(100, 82);
      frame.bubbles = [];
      frame.effects = [];
      mock.draw();
      expect(bubble?.destroy).toHaveBeenCalledWith({ children: true });
      expect(heart?.destroy).toHaveBeenCalledOnce();
    } finally {
      view.dispose();
    }
  });
});
describe('桌面层启动时序', () => {
  it('画布尚未初始化时也不能丢失设置快照和桌面层命令', async () => {
    let ready!: () => void;
    mock.ready = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const fixture = setup();
    const starting = createOverlayView(
      { cats: {}, disabled: [], events: {} },
      fixture.stage,
      fixture.bridge,
    );
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
      createOverlayView({ cats: {}, disabled: [], events: {} }, fixture.stage, fixture.bridge),
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
        freezeForPose: vi.fn(),
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
      fixture.stage.update = () => ({ cats: [placement], bubbles: [], effects: [], sounds: [] });
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
