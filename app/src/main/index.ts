import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { app, dialog, globalShortcut, ipcMain, net, protocol } from 'electron';
import type { MainToOverlay, StageCommand, StateSnapshot } from '../shared/ipc';
import { CONTENT_PROTOCOL } from '../shared/content-url';
import {
  CURRENT_SAVE_VERSION,
  defaultGameState,
  GameStateSchema,
  SAVE_MIGRATIONS,
} from '../shared/schemas';
import { zh } from '../shared/strings.zh-CN';
import {
  contentDirectory,
  loadContent,
  registerContentProtocol,
  registerContentScheme,
} from './content';
import { showCatMenu } from './cat-menu';
import { createAutostart, startupOptions } from './autostart';
import { createGameCommands } from './game-commands';
import { createGameSession } from './game-session';
import { registerIpcRoutes } from './ipc-router';
import { attachMainLog, createApplicationLog } from './log';
import { configureOverlayGpu, createOverlay } from './overlay';
import { createPanelWindows, sendToWindow } from './panel-windows';
import { createPlatform } from './platform';
import { createPhoto } from './photo';
import { attachRecovery } from './recovery';
import { SaveStore } from './save';
import { attachShutdown } from './shutdown';
import {
  applicationMenuSection,
  captureMenuSection,
  catMenuSection,
  createTrayMenu,
} from './tray-menu';

const text = zh.integration;
const debugShortcut = 'CommandOrControl+Shift+F10';
const startup = startupOptions(process.argv);

// 隔离自动测试数据，正式安装包不接受此开发选项。
if (!app.isPackaged && process.env['TTCATS_TEST_APP_DATA']) {
  const directory = resolve(process.env['TTCATS_TEST_APP_DATA']);
  mkdirSync(directory, { recursive: true });
  app.setPath('appData', directory);
  app.setPath('userData', join(directory, 'TTCats'));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  configureOverlayGpu();
  registerContentScheme(protocol);
  const log = createApplicationLog();
  const detachMainLog = attachMainLog(log);
  void app
    .whenReady()
    .then(async () => {
      const report = (error: unknown): void => {
        log.report(String(error));
      };
      const save = new SaveStore({
        directory: join(app.getPath('appData'), 'TTCats'),
        currentVersion: CURRENT_SAVE_VERSION,
        schema: GameStateSchema,
        defaultState: () => defaultGameState([]),
        migrations: SAVE_MIGRATIONS,
        now: Date.now,
        log: report,
      });
      const loaded = save.load();
      const directory =
        !app.isPackaged && process.argv.includes('--test-content')
          ? join(app.getAppPath(), 'test-content')
          : contentDirectory({
              isPackaged: app.isPackaged,
              resourcesPath: process.resourcesPath,
              appPath: app.getAppPath(),
            });
      const content = loadContent(directory, report);
      const names = new Map(Object.entries(content.cats).map(([id, pack]) => [id, pack.cat.name]));
      const initialState =
        loaded.source === 'default' ? defaultGameState(Object.keys(content.cats)) : loaded.state;
      registerContentProtocol(protocol, net, directory, content);
      // eslint-disable-next-line prefer-const -- 窗口加载期间的回调需要读取尚未就绪的控制器。
      let overlay: Awaited<ReturnType<typeof createOverlay>> | undefined;
      let recovery: ReturnType<typeof attachRecovery> | undefined;
      // eslint-disable-next-line prefer-const -- 启动期间状态更新可能早于托盘创建。
      let tray: ReturnType<typeof createTrayMenu> | undefined;
      // eslint-disable-next-line prefer-const -- IPC 和窗口回调在退出监听器注册前已经接线。
      let shutdown: ReturnType<typeof attachShutdown> | undefined;
      const stopping = (): boolean => shutdown?.closing === true || shutdown?.quitting === true;
      const overlaySend = (channel: string, payload: StageCommand | MainToOverlay): void => {
        if (overlay?.window && !session.safeMode) sendToWindow(overlay.window, channel, payload);
      };
      const panels = createPanelWindows({ log, report, overlaySend });
      const autostart = createAutostart({ app, executable: process.execPath, log: report });
      autostart.sync(initialState.settings.launchAtLogin);
      const updateTray = (): void => {
        tray?.update();
      };
      const publish = (snapshot: StateSnapshot): void => {
        if (!session.safeMode) autostart.sync(snapshot.settings.launchAtLogin);
        panels.publish(snapshot);
        overlay?.updateSettings(snapshot.settings);
        updateTray();
      };
      const session = createGameSession({
        content,
        state: initialState,
        save,
        now: Date.now,
        publish,
        log: report,
        startupQuiet: startup.startupQuiet,
      });
      const { command, summon } = createGameCommands({
        session,
        stopping,
        overlayWindow: () => overlay?.window,
        overlaySend,
        updateTray,
        report,
      });
      const photo = createPhoto({
        overlay: () => overlay,
        allowed: () =>
          !session.safeMode &&
          !stopping() &&
          session.snapshot().settings.visibleCats.some((id) => Object.hasOwn(content.cats, id)),
        updateTray,
        report,
      });
      const detachIpc = registerIpcRoutes({
        ipc: ipcMain,
        allowedSender: panels.allowedSender,
        overlayContents: () => overlay?.window?.webContents,
        acceptFacts: () => !session.safeMode && !stopping(),
        command,
        mainCommands: {
          'photo/take': photo.take,
          'diagnostics/export': (message) => {
            report(zh.interfaces.commandNotReady(message.type));
          },
          'update/check': (message) => {
            report(zh.interfaces.commandNotReady(message.type));
          },
          'update/install': (message) => {
            report(zh.interfaces.commandNotReady(message.type));
          },
          'debug/simulateFullscreen': (message) => {
            report(zh.interfaces.commandNotReady(message.type));
          },
          'debug/crashOverlay': () => {
            if (!shutdown?.closing) recovery?.crash();
          },
        },
        fact: (message) => {
          session.fact(message);
        },
        snapshot: session.snapshot,
        content,
        report,
      });
      const overlayReady = createOverlay({
        onReady: panels.updateDebug,
        system: await createPlatform(),
        settings: initialState.settings,
        onError: report,
        onWindow: (window) => {
          panels.registerWindow(window);
          window.on('show', updateTray);
          window.on('hide', updateTray);
          recovery = attachRecovery({
            overlay: window,
            save,
            log,
            defaultState: () => defaultGameState([...names.keys()]),
            activeCats: () =>
              session
                .snapshot()
                .settings.visibleCats.filter((id) => Object.hasOwn(content.cats, id)),
            catName: (id) => names.get(id) ?? id,
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
          if (session.safeMode || stopping()) return;
          if (message.type === 'stageDebug') panels.sendDebugReport(message.report);
          else if (
            message.type === 'catMenu' &&
            Object.hasOwn(content.cats, message.cat) &&
            overlay?.window
          )
            showCatMenu({
              cat: message.cat,
              window: overlay.window,
              summon,
              command,
              openPanel: panels.openPanel,
            });
        },
      });
      overlay = await overlayReady;
      if (session.safeMode) overlay.enterSafeMode();
      tray = createTrayMenu({
        context: () => ({
          content,
          settings: session.snapshot().settings,
          safeMode: session.safeMode,
          command,
          summon,
          openPanel: panels.openPanel,
          quit: () => {
            app.quit();
          },
        }),
        sections: [catMenuSection, captureMenuSection, photo.menuSection, applicationMenuSection],
        openSettings: () => {
          panels.openPanel('settings');
        },
      });
      updateTray();
      if (
        !globalShortcut.register(debugShortcut, () => {
          panels.openPanel('debug');
        })
      )
        report(text.shortcutFailed);
      const onSecondInstance = (_event: Electron.Event, args: string[]): void => {
        if (!startupOptions(args).startupQuiet) panels.openPanel('settings');
      };
      app.on('second-instance', onSecondInstance);
      // 关闭所有面板后继续驻留托盘。
      const onAllClosed = (): void => {};
      app.on('window-all-closed', onAllClosed);
      // 定时器只唤醒；core/game 按传入的真实时间结束静默并推送快照。
      const gameTimer = setInterval(() => {
        if (!stopping()) session.tick();
      }, 1000);
      shutdown = attachShutdown({
        flush: () => {
          session.flush();
        },
        report,
        steps: [
          () => {
            clearInterval(gameTimer);
          },
          () => {
            recovery?.dispose();
          },
          detachIpc,
          () => {
            globalShortcut.unregister(debugShortcut);
          },
          () => {
            tray.dispose();
          },
          () => {
            protocol.unhandle(CONTENT_PROTOCOL);
          },
          () => {
            app.removeListener('second-instance', onSecondInstance);
          },
          () => {
            app.removeListener('window-all-closed', onAllClosed);
          },
          () => {
            panels.dispose();
          },
        ],
        disposeOverlay: () => overlay.dispose(),
        detachMainLog,
      });
      if (startup.openSettings) panels.openPanel('settings');
    })
    .catch((error: unknown) => {
      log.report(String(error));
      if (!startup.startupQuiet)
        dialog.showErrorBox(zh.app.name, `${text.startupFailed}\n${String(error)}`);
      detachMainLog();
      app.exit(1);
    });
}
