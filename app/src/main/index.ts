import { app, dialog, ipcMain, net, protocol } from 'electron';
import type { StateSnapshot } from '../shared/ipc';
import { CONTENT_PROTOCOL } from '../shared/content-url';
import { zh } from '../shared/strings.zh-CN';
import { createAppListeners } from './app-listeners';
import { createAppStatus } from './app-status';
import { createAutostartFeature, startupOptions } from './autostart';
import { registerContentProtocol, registerContentScheme } from './content';
import { createDebugShortcut } from './debug-shortcut';
import { createDiagnosticsExport } from './diagnostics';
import { createDoNotDisturbMenu } from './do-not-disturb-menu';
import { combineFeatures } from './features';
import { createGameCommands } from './game-commands';
import { isolateTestAppData, loadGameData } from './game-data';
import { createGameSession } from './game-session';
import { createGameTicker } from './game-ticker';
import { createHideAllShortcutFeature } from './hide-all-shortcut';
import { registerIpcRoutes } from './ipc-router';
import { attachMainLog, createApplicationLog } from './log';
import { configureOverlayGpu } from './overlay';
import { createOverlayFeature } from './overlay/feature';
import { createPanelWindows } from './panel-windows';
import { readSystemInfo } from './platform';
import { createPhotoFeature } from './photo';
import { attachShutdown } from './shutdown';
import {
  applicationMenuSection,
  captureMenuSection,
  catMenuSection,
  createTrayMenu,
} from './tray-menu';
import { createUpdaterFeature } from './updater';

// 入口只按顺序接线；各功能的逻辑在自己的模块里（见 README“加一个新功能”）。
const startup = startupOptions(process.argv);
isolateTestAppData();

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
      const { save, directory, content, initialState } = loadGameData(report);
      registerContentProtocol(protocol, net, directory, content);
      // eslint-disable-next-line prefer-const -- 启动期间状态更新可能早于托盘创建。
      let tray: ReturnType<typeof createTrayMenu> | undefined;
      // eslint-disable-next-line prefer-const -- IPC 和窗口回调在退出监听器注册前已经接线。
      let shutdown: ReturnType<typeof attachShutdown> | undefined;
      const stopping = (): boolean => shutdown?.closing === true || shutdown?.quitting === true;
      const updateTray = (): void => {
        tray?.update();
      };
      const panels = createPanelWindows({
        log,
        report,
        overlaySend: (channel, payload) => {
          overlay.send(channel, payload);
        },
        stageDebugRequired: () => overlay.waitingForExit(),
      });
      // 程序状态全程序只有这一份；各功能通过 appStatus.update 改自己的字段。
      const appStatus = createAppStatus(
        {
          version: app.getVersion(),
          update: { state: 'unsupported' },
          hideAllShortcut: {
            accelerator: initialState.settings.hideAllShortcut,
            registered: false,
          },
          displays: [],
          overlayDisplayId: null,
        },
        (status) => {
          panels.publishAppStatus(status);
        },
      );
      const publish = (snapshot: StateSnapshot): void => {
        panels.publish(snapshot);
        features.onSnapshot(snapshot);
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
        overlayWindow: () => overlay.window(),
        overlaySend: (channel, payload) => {
          overlay.send(channel, payload);
        },
        updateTray,
        report,
      });
      const exportDiagnostics = createDiagnosticsExport({
        logDirectory: log.directory,
        saveFile: save.file,
        contentDirectory: directory,
        content,
        safeMode: () => session.safeMode,
        stopping,
        overlayWindow: () => overlay.window(),
        report,
        system: readSystemInfo,
      });
      const overlay = createOverlayFeature({
        settings: initialState.settings,
        content,
        session,
        save,
        log,
        panels: () => panels,
        command,
        summon,
        exportDiagnostics,
        onDisplays: (displays, current) => {
          appStatus.update({ displays, overlayDisplayId: current });
        },
        updateTray,
        stopping,
        closing: () => shutdown?.closing === true,
        report,
      });
      const updates = createUpdaterFeature({
        packaged: app.isPackaged,
        enabled: initialState.settings.autoUpdate,
        publish: (update) => {
          appStatus.update({ update });
        },
        updateTray,
        stopping,
        report,
        quit: () => {
          app.quit();
        },
      });
      // 登记顺序就是快照通知、托盘菜单段（猫的菜单之后）、启动和退出清理的顺序。
      const features = combineFeatures([
        createGameTicker({ session, stopping, report }),
        createAutostartFeature({
          app,
          executable: process.execPath,
          log: report,
          enabled: initialState.settings.launchAtLogin,
          safeMode: () => session.safeMode,
        }),
        createHideAllShortcutFeature({
          accelerator: () => session.snapshot().settings.hideAllShortcut,
          toggle: () => {
            command({ type: 'hideAll/toggle' });
          },
          publish: (hideAllShortcut) => {
            appStatus.update({ hideAllShortcut });
          },
          report,
        }),
        { menuSection: createDoNotDisturbMenu(session.snapshot) },
        { menuSection: captureMenuSection },
        createPhotoFeature({
          overlay: overlay.controller,
          session,
          content,
          stopping,
          updateTray,
          report,
        }),
        updates,
        overlay,
        { mainCommands: { 'diagnostics/export': exportDiagnostics } },
        createDebugShortcut({ openPanel: panels.openPanel, report }),
        createAppListeners({ app, openPanel: panels.openPanel }),
      ]);
      const detachIpc = registerIpcRoutes({
        ipc: ipcMain,
        allowedSender: panels.allowedSender,
        overlayContents: () => overlay.window()?.webContents,
        acceptFacts: () => !session.safeMode && !stopping(),
        command,
        mainCommands: features.mainCommands,
        fact: (message) => {
          session.fact(message);
        },
        snapshot: session.snapshot,
        appStatus: appStatus.current,
        content,
        report,
      });
      await overlay.open();
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
        sections: [catMenuSection, ...features.menuSections, applicationMenuSection],
        openSettings: () => {
          panels.openPanel('settings');
        },
      });
      updateTray();
      features.start();
      // 先存档，再按顺序同步清理，等桌面层释放，最后才安装更新并退出。
      shutdown = attachShutdown({
        flush: () => {
          session.flush();
        },
        report,
        steps: [
          ...features.disposeSteps,
          detachIpc,
          () => {
            tray.dispose();
          },
          () => {
            protocol.unhandle(CONTENT_PROTOCOL);
          },
          () => {
            panels.dispose();
          },
        ],
        disposeOverlay: overlay.disposeWindow,
        detachMainLog,
        finishQuit: () => {
          updates.finishQuit();
        },
      });
      if (startup.openSettings) panels.openPanel('settings');
    })
    .catch((error: unknown) => {
      log.report(String(error));
      if (!startup.startupQuiet)
        dialog.showErrorBox(zh.app.name, `${zh.integration.startupFailed}\n${String(error)}`);
      detachMainLog();
      app.exit(1);
    });
}
