import { beforeEach, describe, expect, it, vi } from 'vitest';

// preload 只能在 Electron 里运行，这里把 electron 换成记录调用的假对象
const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { send: vi.fn(), invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
}));
vi.mock('electron', () => electron);

const { bridge } = await import('./index');
const overlayBridge: import('../shared/ipc').OverlayBridge = bridge;
const panelsBridge: import('../shared/ipc').PanelsBridge = bridge;
const { BRIDGE_KEY, IPC_CHANNELS } = await import('../shared/ipc');
// 挂桥发生在导入 preload 的时候，先记下来（每个测试前 mock 的调用记录会被清掉）
const exposed = [...electron.contextBridge.exposeInMainWorld.mock.calls];

beforeEach(() => {
  electron.ipcRenderer.send.mockClear();
  electron.ipcRenderer.invoke.mockClear();
  electron.ipcRenderer.on.mockClear();
  electron.ipcRenderer.removeListener.mockClear();
});

describe('preload 桥', () => {
  it('桥挂在 window.ttcats 上', () => {
    expect(exposed).toEqual([[BRIDGE_KEY, bridge]]);
  });

  it('命令、事实、窗口控制消息发到各自的通道', () => {
    overlayBridge.sendCommand({ type: 'cat/sleep', cat: 'test-a' });
    overlayBridge.sendFact({ type: 'cat/poked', cat: 'test-a', at: 1 });
    overlayBridge.sendOverlay({ type: 'hover', onCat: true });
    panelsBridge.sendCommand({ type: 'debug/crashOverlay' });
    expect(electron.ipcRenderer.send.mock.calls).toEqual([
      [IPC_CHANNELS.command, { type: 'cat/sleep', cat: 'test-a' }],
      [IPC_CHANNELS.fact, { type: 'cat/poked', cat: 'test-a', at: 1 }],
      [IPC_CHANNELS.overlayToMain, { type: 'hover', onCat: true }],
      [IPC_CHANNELS.command, { type: 'debug/crashOverlay' }],
    ]);
  });

  it('快照和内容用 invoke 向主进程要', async () => {
    electron.ipcRenderer.invoke.mockResolvedValueOnce({ revision: 3 });
    await expect(panelsBridge.getSnapshot()).resolves.toEqual({ revision: 3 });
    electron.ipcRenderer.invoke.mockResolvedValueOnce({ cats: {}, disabled: [] });
    await expect(overlayBridge.getContent()).resolves.toEqual({ cats: {}, disabled: [] });
    expect(electron.ipcRenderer.invoke.mock.calls).toEqual([
      [IPC_CHANNELS.getSnapshot],
      [IPC_CHANNELS.getContent],
    ]);
  });

  it('监听推送时只把消息内容交给回调，取消后不再监听', () => {
    const received: unknown[] = [];
    const off = overlayBridge.onOverlay((message) => received.push(message));
    const [channel, handler] = electron.ipcRenderer.on.mock.calls[0] as [
      string,
      (event: unknown, payload: unknown) => void,
    ];
    expect(channel).toBe(IPC_CHANNELS.mainToOverlay);
    handler({ sender: 'ignored' }, { type: 'ghost', active: true });
    expect(received).toEqual([{ type: 'ghost', active: true }]);
    off();
    expect(electron.ipcRenderer.removeListener).toHaveBeenCalledWith(channel, handler);
  });

  it('面板收快照和调试台的画面状态', () => {
    panelsBridge.onSnapshot(() => undefined);
    panelsBridge.onStageDebug(() => undefined);
    expect(electron.ipcRenderer.on.mock.calls.map((call) => call[0] as string)).toEqual([
      IPC_CHANNELS.snapshot,
      IPC_CHANNELS.stageDebug,
    ]);
  });
});
