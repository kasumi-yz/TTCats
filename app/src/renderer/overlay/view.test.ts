// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { StageCore } from '../../shared/core-api';
import type { OverlayBridge, StageCommand, StateSnapshot } from '../../shared/ipc';
import { defaultSettings } from '../../shared/schemas/settings';

const mock = vi.hoisted(() => ({ ready: Promise.resolve() }));
vi.mock('pixi.js', () => ({
  Application: class {
    canvas = document.createElement('canvas');
    ticker = { maxFPS: 0, add: vi.fn() };
    stage = { addChild: vi.fn() };
    init() {
      return mock.ready;
    }
    destroy = vi.fn();
  },
  Container: vi.fn(),
  Texture: vi.fn(),
  VideoSource: vi.fn(),
  Sprite: vi.fn(),
  Graphics: vi.fn(),
  Text: vi.fn(),
}));
import { createOverlayView } from './view';

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
  const stage: StageCore = {
    applySnapshot,
    handleCommand,
    handlePointer: vi.fn(),
    setGhostMode: vi.fn(),
    setBounds: vi.fn(),
    update: () => ({ cats: [], bubbles: [], effects: [] }),
    drainFacts: () => [],
    debugReport: (at) => ({ at, cats: [] }),
  };
  return {
    applySnapshot,
    handleCommand,
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
