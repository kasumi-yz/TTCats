import type { BrowserWindow } from 'electron';
import type { ContentCatalog } from '../../shared/core-api';
import type { DisplayInfo } from '../../shared/display';
import type { GameCommand, MainToOverlay, StageCommand, StateSnapshot } from '../../shared/ipc';
import { defaultGameState, type GameState, type Settings } from '../../shared/schemas';
import { showCatMenu } from '../cat-menu';
import type { MainFeature } from '../features';
import type { createGameSession } from '../game-session';
import type { FileLog } from '../log';
import { sendToWindow, type createPanelWindows } from '../panel-windows';
import { createPlatform } from '../platform';
import { attachRecovery } from '../recovery';
import type { SaveStore } from '../save';
import { zh } from '../../shared/strings.zh-CN';
import { createOverlay } from './index';

/**
 * 桌面层的接线（#98）：创建窗口、接上崩溃恢复、转发桌面层消息，
 * 以及只对桌面层生效的调试命令。窗口在 open() 里异步创建，之前的调用都安全地什么也不做。
 */
export function createOverlayFeature(options: {
  settings: Settings;
  content: ContentCatalog;
  session: ReturnType<typeof createGameSession>;
  save: SaveStore<GameState>;
  log: FileLog;
  panels: () => ReturnType<typeof createPanelWindows>;
  command: (message: GameCommand) => void;
  summon: (cat?: string) => void;
  exportDiagnostics: () => Promise<void>;
  onDisplays: (displays: DisplayInfo[], current: number) => void;
  updateTray: () => void;
  stopping: () => boolean;
  /** 退出清理已经开始（比 stopping 晚）：之后不再接受崩溃调试命令。 */
  closing: () => boolean;
  report: (error: unknown) => void;
}) {
  const { content, session, save, log } = options;
  // 启动时的名字表；安全模式过滤内容目录后，恢复界面仍要用中文名字。
  const names = new Map(Object.entries(content.cats).map(([id, pack]) => [id, pack.cat.name]));
  let overlay: Awaited<ReturnType<typeof createOverlay>> | undefined;
  let recovery: ReturnType<typeof attachRecovery> | undefined;
  const send = (channel: string, payload: StageCommand | MainToOverlay): void => {
    if (overlay?.window && !session.safeMode) sendToWindow(overlay.window, channel, payload);
  };
  const open = async (): Promise<void> => {
    const panels = options.panels();
    const overlayReady = createOverlay({
      onReady: panels.updateDebug,
      onExitChange: panels.updateDebug,
      system: await createPlatform(),
      settings: options.settings,
      onError: options.report,
      onDisplays: options.onDisplays,
      onWindow: (window) => {
        panels.registerWindow(window);
        window.on('show', options.updateTray);
        window.on('hide', options.updateTray);
        recovery = attachRecovery({
          overlay: window,
          save,
          log,
          defaultState: () => defaultGameState([...names.keys()]),
          activeCats: () =>
            session.snapshot().settings.visibleCats.filter((id) => Object.hasOwn(content.cats, id)),
          catName: (id) => names.get(id) ?? id,
          exportDiagnostics: options.exportDiagnostics,
          faultedCat: () => undefined,
          reload: async () => {
            await (await overlayReady).reload();
            panels.updateDebug();
          },
          applySafeMode: (result) => {
            overlay?.enterSafeMode();
            session.applySafeMode(result);
            // 面板只在加载时读取内容目录；重新加载以显示停用包和中文原因。
            panels.reload();
          },
          onSafeMode: () => {
            session.suspendSaving();
            overlay?.enterSafeMode();
          },
        });
        window.webContents.on('did-finish-load', panels.updateDebug);
      },
      onMessage: (message) => {
        if (session.safeMode || options.stopping()) return;
        if (message.type === 'stageDebug') panels.sendDebugReport(message.report);
        else if (
          message.type === 'catMenu' &&
          Object.hasOwn(content.cats, message.cat) &&
          overlay?.window
        )
          showCatMenu({
            cat: message.cat,
            window: overlay.window,
            summon: options.summon,
            command: options.command,
            openPanel: panels.openPanel,
          });
      },
    });
    overlay = await overlayReady;
    overlay.updateHideAll(session.snapshot().hideAll);
    if (session.safeMode) overlay.enterSafeMode();
  };
  return {
    open,
    send,
    controller: () => overlay,
    window: (): BrowserWindow | undefined => overlay?.window,
    waitingForExit: (): boolean => overlay?.waitingForExit === true,
    onSnapshot(snapshot: StateSnapshot): void {
      overlay?.updateSettings(snapshot.settings);
      overlay?.updateHideAll(snapshot.hideAll);
    },
    mainCommands: {
      'debug/simulateFullscreen': (message) => {
        if (!options.stopping() && !session.safeMode) overlay?.simulateFullscreen(message.active);
      },
      'debug/crashOverlay': () => {
        if (!options.closing()) recovery?.crash();
      },
      // 窗口顶边的调试线由 #116 接线。
      'debug/ledgeLines': (message) => {
        options.report(zh.interfaces.commandNotReady(message.type));
      },
    },
    dispose(): void {
      recovery?.dispose();
    },
    /** 交给 attachShutdown 的 disposeOverlay：异步释放窗口。 */
    disposeWindow: (): Promise<void> => overlay?.dispose() ?? Promise.resolve(),
  } satisfies MainFeature & Record<string, unknown>;
}
