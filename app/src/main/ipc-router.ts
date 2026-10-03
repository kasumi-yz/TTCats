import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron';
import type { ContentCatalog } from '../shared/core-api';
import type {
  AppStatus,
  Fact,
  GameCommand,
  MainCommand,
  StateSnapshot,
  ToMainCommand,
} from '../shared/ipc';
import { IPC_CHANNELS, isMainCommand } from '../shared/ipc';
import { zh } from '../shared/strings.zh-CN';
import { CommandSchema, FactSchema } from './messages';
import { attachCrashCommand } from './recovery';

export type MainCommandHandlers = {
  [Type in MainCommand['type']]: (
    command: Extract<MainCommand, { type: Type }>,
  ) => void | Promise<void>;
};

export function registerIpcRoutes(options: {
  ipc: IpcMain;
  allowedSender: (id: number) => boolean;
  overlayContents: () => WebContents | undefined;
  acceptFacts: () => boolean;
  command: (message: GameCommand) => void;
  mainCommands: MainCommandHandlers;
  fact: (message: Fact) => void;
  snapshot: () => StateSnapshot;
  appStatus: () => AppStatus;
  content: ContentCatalog;
  report: (error: unknown) => void;
}): () => void {
  const { ipc, report } = options;
  const text = zh.integration;
  const allowed = (event: IpcMainEvent | IpcMainInvokeEvent): boolean =>
    event.senderFrame === event.sender.mainFrame && options.allowedSender(event.sender.id);
  const invalidMessage = (payload: unknown, issues: { path: PropertyKey[] }[]): void => {
    const type =
      payload !== null && typeof payload === 'object' && 'type' in payload
        ? String(payload.type)
        : text.unknownMessageType;
    report(
      text.invalidMessage(
        type,
        issues.map((issue) => issue.path.join('.') || '(root)'),
      ),
    );
  };
  const dispatch = (message: ToMainCommand): void => {
    if (!isMainCommand(message)) {
      options.command(message);
      return;
    }
    // 注册表的键与处理函数的消息类型成对；只在这一个分发边界擦除具体类型。
    const handlers = options.mainCommands as Record<
      MainCommand['type'],
      (command: MainCommand) => void | Promise<void>
    >;
    try {
      const result = handlers[message.type](message);
      if (result) void result.catch(report);
    } catch (error) {
      report(error);
    }
  };
  const onCommand = (event: IpcMainEvent, payload: unknown): void => {
    if (!allowed(event)) return;
    const parsed = CommandSchema.safeParse(payload);
    if (!parsed.success) {
      invalidMessage(payload, parsed.error.issues);
      return;
    }
    // 保留恢复模块原有的崩溃调试监听器及其接收规则，避免拆分改变行为。
    if (parsed.data.type !== 'debug/crashOverlay') dispatch(parsed.data);
  };
  const onFact = (event: IpcMainEvent, payload: unknown): void => {
    if (!allowed(event) || event.sender !== options.overlayContents() || !options.acceptFacts())
      return;
    const parsed = FactSchema.safeParse(payload);
    if (!parsed.success) {
      invalidMessage(payload, parsed.error.issues);
      return;
    }
    try {
      options.fact(parsed.data);
    } catch (error) {
      report(error);
    }
  };
  ipc.on(IPC_CHANNELS.command, onCommand);
  ipc.on(IPC_CHANNELS.fact, onFact);
  ipc.handle(IPC_CHANNELS.getSnapshot, (event) => {
    if (!allowed(event)) throw new Error(text.unknownSender);
    return options.snapshot();
  });
  ipc.handle(IPC_CHANNELS.getAppStatus, (event) => {
    if (!allowed(event)) throw new Error(text.unknownSender);
    return options.appStatus();
  });
  ipc.handle(IPC_CHANNELS.getContent, (event) => {
    if (!allowed(event)) throw new Error(text.unknownSender);
    return options.content;
  });
  ipc.handle(IPC_CHANNELS.getAppStatus, (event) => {
    if (!allowed(event)) throw new Error(text.unknownSender);
    return options.appStatus();
  });
  const detachCrash = attachCrashCommand(ipc, options.allowedSender, () => {
    dispatch({ type: 'debug/crashOverlay' });
  });
  return () => {
    detachCrash();
    ipc.removeListener(IPC_CHANNELS.command, onCommand);
    ipc.removeListener(IPC_CHANNELS.fact, onFact);
    ipc.removeHandler(IPC_CHANNELS.getSnapshot);
    ipc.removeHandler(IPC_CHANNELS.getAppStatus);
    ipc.removeHandler(IPC_CHANNELS.getContent);
    ipc.removeHandler(IPC_CHANNELS.getAppStatus);
  };
}
