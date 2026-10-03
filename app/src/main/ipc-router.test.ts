import { EventEmitter } from 'node:events';
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { catalog, defined, snapshot, testCat } from '../core/stage/test-fixtures';
import { IPC_CHANNELS } from '../shared/ipc';
import { zh } from '../shared/strings.zh-CN';
import { registerIpcRoutes } from './ipc-router';
import { createAppStatus } from './app-status';

vi.mock('electron', () => ({}));

class FakeIpc extends EventEmitter {
  handlers = new Map<string, (event: IpcMainInvokeEvent) => unknown>();
  handle(channel: string, handler: (event: IpcMainInvokeEvent) => unknown) {
    this.handlers.set(channel, handler);
  }
  removeHandler(channel: string) {
    this.handlers.delete(channel);
  }
  invoke(channel: string, event: IpcMainInvokeEvent): unknown {
    return defined(this.handlers.get(channel))(event);
  }
}

function setup() {
  const ipc = new FakeIpc();
  const overlay = { id: 1, mainFrame: {} } as WebContents;
  const panel = { id: 2, mainFrame: {} } as WebContents;
  const unknown = { id: 3, mainFrame: {} } as WebContents;
  const event = (sender = overlay, subframe = false): IpcMainInvokeEvent =>
    ({ sender, senderFrame: subframe ? {} : sender.mainFrame }) as IpcMainInvokeEvent;
  let acceptFacts = true;
  const command = vi.fn();
  const crash = vi.fn();
  const photo = vi.fn<() => void | Promise<void>>();
  const diagnostics = vi.fn<() => void | Promise<void>>();
  const checkUpdate = vi.fn();
  const installUpdate = vi.fn();
  const fullscreen = vi.fn();
  const fact = vi.fn();
  const getSnapshot = vi.fn(() => snapshot(['cat']));
  const content = catalog([{ cat: testCat('cat') }]);
  const report = vi.fn();
  const detach = registerIpcRoutes({
    ipc: ipc as unknown as IpcMain,
    allowedSender: (id) => id === overlay.id || id === panel.id,
    overlayContents: () => overlay,
    acceptFacts: () => acceptFacts,
    command,
    mainCommands: {
      'debug/crashOverlay': crash,
      'photo/take': photo,
      'diagnostics/export': diagnostics,
      'update/check': checkUpdate,
      'update/install': installUpdate,
      'debug/simulateFullscreen': fullscreen,
    },
    fact,
    snapshot: getSnapshot,
    appStatus: createAppStatus(
      {
        version: '0.2.0',
        update: { state: 'unsupported' },
        hideAllShortcut: { accelerator: 'Ctrl+Alt+H', registered: true },
        displays: [],
        overlayDisplayId: null,
      },
      vi.fn(),
    ).current,
    content,
    report,
  });
  return {
    ipc,
    overlay,
    panel,
    unknown,
    event,
    command,
    crash,
    photo,
    diagnostics,
    checkUpdate,
    installUpdate,
    fullscreen,
    fact,
    getSnapshot,
    content,
    report,
    detach,
    stopFacts: () => {
      acceptFacts = false;
    },
  };
}

describe('主进程 IPC 路由', () => {
  it('M2 的 MainCommand 逐项分发，不能误交给游戏规则或其他功能', () => {
    const {
      ipc,
      event,
      command,
      photo,
      diagnostics,
      checkUpdate,
      installUpdate,
      fullscreen,
      crash,
    } = setup();
    const handlers = [photo, diagnostics, checkUpdate, installUpdate, fullscreen];
    const messages = [
      { type: 'photo/take' },
      { type: 'diagnostics/export' },
      { type: 'update/check' },
      { type: 'update/install' },
      { type: 'debug/simulateFullscreen', active: true },
    ];
    messages.forEach((message, index) => {
      handlers.forEach((handler) => handler.mockClear());
      ipc.emit(IPC_CHANNELS.command, event(), message);
      handlers.forEach((handler, handlerIndex) => {
        expect(handler).toHaveBeenCalledTimes(handlerIndex === index ? 1 : 0);
      });
      expect(handlers[index]).toHaveBeenCalledWith(message);
    });
    expect(command).not.toHaveBeenCalled();
    expect(crash).not.toHaveBeenCalled();
  });

  it('MainCommand 同步抛错只记日志，不冒出 IPC 监听器，后续命令仍能处理', () => {
    const { ipc, event, photo, diagnostics, report, command } = setup();
    const error = new Error('拍照失败');
    photo.mockImplementation(() => {
      throw error;
    });
    expect(() => ipc.emit(IPC_CHANNELS.command, event(), { type: 'photo/take' })).not.toThrow();
    expect(report).toHaveBeenCalledExactlyOnceWith(error);
    ipc.emit(IPC_CHANNELS.command, event(), { type: 'diagnostics/export' });
    expect(diagnostics).toHaveBeenCalledOnce();
    expect(command).not.toHaveBeenCalled();
  });

  it('MainCommand 异步失败也由路由记日志，避免未处理的 Promise 拒绝', async () => {
    const { ipc, event, diagnostics, report } = setup();
    const error = new Error('诊断导出失败');
    diagnostics.mockRejectedValue(error);
    ipc.emit(IPC_CHANNELS.command, event(), { type: 'diagnostics/export' });
    await vi.waitFor(() => {
      expect(report).toHaveBeenCalledExactlyOnceWith(error);
    });
  });

  it('GameCommand 交给游戏规则，MainCommand 只调用对应注册函数且只调用一次', () => {
    const { ipc, event, panel, command, crash } = setup();
    const message = { type: 'cat/sleep', cat: 'cat' };
    ipc.emit(IPC_CHANNELS.command, event(panel), message);
    expect(command).toHaveBeenCalledExactlyOnceWith(message);
    expect(crash).not.toHaveBeenCalled();
    ipc.emit(IPC_CHANNELS.command, event(panel), { type: 'debug/crashOverlay' });
    expect(crash).toHaveBeenCalledExactlyOnceWith({ type: 'debug/crashOverlay' });
    expect(command).toHaveBeenCalledOnce();
  });

  it.each(['unknown', 'subframe'] as const)(
    '拒绝 %s 发送方的命令、事实和查询，不能触发崩溃调试',
    (source) => {
      const { ipc, event, unknown, overlay, command, crash, fact, getSnapshot } = setup();
      const sender = source === 'unknown' ? event(unknown) : event(overlay, true);
      ipc.emit(IPC_CHANNELS.command, sender, { type: 'cat/sleep', cat: 'cat' });
      ipc.emit(IPC_CHANNELS.command, sender, { type: 'debug/crashOverlay' });
      ipc.emit(IPC_CHANNELS.fact, sender, { type: 'cat/poked', cat: 'cat', at: 0 });
      for (const channel of [
        IPC_CHANNELS.getSnapshot,
        IPC_CHANNELS.getContent,
        IPC_CHANNELS.getAppStatus,
      ])
        expect(() => ipc.invoke(channel, sender)).toThrow(zh.integration.unknownSender);
      expect(command).not.toHaveBeenCalled();
      expect(crash).not.toHaveBeenCalled();
      expect(fact).not.toHaveBeenCalled();
      expect(getSnapshot).not.toHaveBeenCalled();
    },
  );

  it('只有桌面层能报告事实，安全模式和退出阶段停止接收事实', () => {
    const { ipc, event, panel, fact, stopFacts } = setup();
    const message = { type: 'cat/poked', cat: 'cat', at: 123 };
    ipc.emit(IPC_CHANNELS.fact, event(panel), message);
    expect(fact).not.toHaveBeenCalled();
    ipc.emit(IPC_CHANNELS.fact, event(), message);
    expect(fact).toHaveBeenCalledExactlyOnceWith(message);
    stopFacts();
    ipc.emit(IPC_CHANNELS.fact, event(), message);
    expect(fact).toHaveBeenCalledOnce();
  });

  it('已登记面板查询到当前快照和同一份内容目录', () => {
    const { ipc, event, panel, getSnapshot, content } = setup();
    expect(ipc.invoke(IPC_CHANNELS.getSnapshot, event(panel))).toEqual(snapshot(['cat']));
    expect(getSnapshot).toHaveBeenCalledOnce();
    expect(ipc.invoke(IPC_CHANNELS.getContent, event(panel))).toBe(content);
    expect(ipc.invoke(IPC_CHANNELS.getAppStatus, event(panel))).toMatchObject({
      version: '0.2.0',
      hideAllShortcut: { registered: true },
    });
  });

  it('格式错误先拒绝，日志包含消息类型和字段路径', () => {
    const { ipc, event, command, fact, report } = setup();
    ipc.emit(IPC_CHANNELS.command, event(), { type: 'cat/setVisible', cat: 'cat', visible: 'yes' });
    ipc.emit(IPC_CHANNELS.fact, event(), { type: 'cat/petted', cat: 'cat', at: 0, durationMs: -1 });
    expect(command).not.toHaveBeenCalled();
    expect(fact).not.toHaveBeenCalled();
    expect(report.mock.calls[0]?.[0]).toContain('cat/setVisible');
    expect(report.mock.calls[0]?.[0]).toContain('visible');
    expect(report.mock.calls[1]?.[0]).toContain('durationMs');
  });

  it('保留恢复模块的崩溃调试接收规则，同时记录多余字段的校验错误', () => {
    const { ipc, event, crash, command, report } = setup();
    ipc.emit(IPC_CHANNELS.command, event(), { type: 'debug/crashOverlay', extra: true });
    expect(report).toHaveBeenCalledOnce();
    expect(crash).toHaveBeenCalledExactlyOnceWith({ type: 'debug/crashOverlay' });
    expect(command).not.toHaveBeenCalled();
  });

  it('事实处理失败记日志，退出移除所有监听器和查询处理函数', () => {
    const { ipc, event, fact, report, detach } = setup();
    const error = new Error('事实处理失败');
    fact.mockImplementation(() => {
      throw error;
    });
    ipc.emit(IPC_CHANNELS.fact, event(), { type: 'cat/poked', cat: 'cat', at: 0 });
    expect(report).toHaveBeenCalledExactlyOnceWith(error);
    detach();
    expect(ipc.eventNames()).toEqual([]);
    expect(ipc.handlers.size).toBe(0);
  });
});
