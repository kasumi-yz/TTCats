import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  net,
  protocol,
  screen,
  Tray,
} from 'electron';
import type {
  GameCommand,
  MainToOverlay,
  PanelName,
  StageCommand,
  StateSnapshot,
} from '../shared/ipc';
import { IPC_CHANNELS } from '../shared/ipc';
import { CONTENT_PROTOCOL } from '../shared/content-url';
import { CURRENT_SAVE_VERSION, defaultSettings, GameStateSchema } from '../shared/schemas';
import { zh } from '../shared/strings.zh-CN';
import {
  contentDirectory,
  loadContent,
  registerContentProtocol,
  registerContentScheme,
} from './content';
import { createGameSession } from './game-session';
import { attachMainLog, attachRendererLog, createApplicationLog } from './log';
import { CommandSchema, FactSchema } from './messages';
import { configureOverlayGpu, createOverlay } from './overlay';
import { createPlatform } from './platform';
import { attachCrashCommand, attachRecovery } from './recovery';
import { SaveStore } from './save';

const text = zh.integration;
const debugShortcut = 'CommandOrControl+Shift+F10';

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
        defaultState: () => ({ settings: defaultSettings([]) }),
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
        loaded.source === 'default'
          ? { settings: defaultSettings(Object.keys(content.cats)) }
          : loaded.state;
      registerContentProtocol(protocol, net, directory, content);
      const windows = new Set<BrowserWindow>();
      const panels = new Map<string, BrowserWindow>();
      // eslint-disable-next-line prefer-const -- 窗口加载期间的回调需要读取尚未就绪的控制器。
      let overlay: Awaited<ReturnType<typeof createOverlay>> | undefined;
      let recovery: ReturnType<typeof attachRecovery> | undefined;
      // eslint-disable-next-line prefer-const -- 启动期间状态更新可能早于托盘创建。
      let tray: Tray | undefined;
      let closing = false;
      const send = (window: BrowserWindow, channel: string, payload: unknown): void => {
        if (
          !window.isDestroyed() &&
          !window.webContents.isDestroyed() &&
          !window.webContents.isCrashed()
        )
          window.webContents.send(channel, payload);
      };
      const overlaySend = (channel: string, payload: StageCommand | MainToOverlay): void => {
        if (overlay?.window && !session.safeMode) send(overlay.window, channel, payload);
      };
      const publish = (snapshot: StateSnapshot): void => {
        for (const window of windows) send(window, IPC_CHANNELS.snapshot, snapshot);
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
      });
      const updateDebug = (): void => {
        overlaySend(IPC_CHANNELS.mainToOverlay, {
          type: 'stageDebug',
          enabled: panels.has('debug'),
        });
      };
      const registerWindow = (window: BrowserWindow): void => {
        windows.add(window);
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        window.webContents.on('will-navigate', (event) => {
          event.preventDefault();
        });
        window.once('closed', () => {
          windows.delete(window);
        });
      };
      const loadPanel = async (
        window: BrowserWindow,
        panel: PanelName,
        cat?: string,
      ): Promise<void> => {
        const query = { panel, ...(cat === undefined ? {} : { cat }) };
        const url = process.env['ELECTRON_RENDERER_URL'];
        if (url) await window.loadURL(`${url}/panels/index.html?${new URLSearchParams(query)}`);
        else
          await window.loadFile(join(import.meta.dirname, '../renderer/panels/index.html'), {
            query,
          });
      };
      const openPanel = (panel: PanelName, cat?: string): void => {
        const key = panel === 'profile' ? `${panel}:${cat ?? ''}` : panel;
        const existing = panels.get(key);
        if (existing && !existing.isDestroyed()) {
          existing.show();
          existing.focus();
          return;
        }
        const window = new BrowserWindow({
          width: 600,
          height: 760,
          title: zh.app.panelsTitle,
          show: false,
          webPreferences: {
            preload: join(import.meta.dirname, '../preload/index.cjs'),
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
          },
        });
        registerWindow(window);
        panels.set(key, window);
        const detach = attachRendererLog(window.webContents, `panels:${panel}`, log);
        window.once('closed', () => {
          detach();
          panels.delete(key);
          updateDebug();
        });
        window.webContents.on('did-finish-load', updateDebug);
        void loadPanel(window, panel, cat)
          .then(() => {
            if (!window.isDestroyed()) window.show();
          })
          .catch(report);
        updateDebug();
      };
      const command = (message: GameCommand): void => {
        if (closing) return;
        try {
          const result = session.command(message);
          for (const stage of result.stageCommands) overlaySend(IPC_CHANNELS.stageCommand, stage);
        } catch (error) {
          report(error);
        }
      };
      const summon = (cat: string): void => {
        if (session.safeMode || !overlay?.window) return;
        const cursor = screen.getCursorScreenPoint();
        const bounds = overlay.window.getBounds();
        command({
          type: 'cat/summon',
          cat,
          to: { x: cursor.x - bounds.x, y: cursor.y - bounds.y },
        });
      };
      function updateTray(): void {
        if (!tray) return;
        const settings = session.snapshot().settings;
        tray.setContextMenu(
          Menu.buildFromTemplate([
            {
              label: text.summon,
              submenu: Object.entries(content.cats).map(([id, { cat }]) => ({
                id: `summon:${id}`,
                label: cat.name,
                enabled: !session.safeMode && settings.visibleCats.includes(id),
                click: () => {
                  summon(id);
                },
              })),
            },
            {
              label: text.visibility,
              submenu: Object.entries(content.cats).map(([id, { cat }]) => ({
                id: `visible:${id}`,
                label: cat.name,
                type: 'checkbox' as const,
                checked: settings.visibleCats.includes(id),
                enabled: !session.safeMode,
                click: (item) => {
                  command({ type: 'cat/setVisible', cat: id, visible: item.checked });
                },
              })),
            },
            {
              id: 'capture',
              label: text.capture,
              type: 'checkbox',
              checked: settings.showInScreenCapture,
              click: (item) => {
                command({ type: 'settings/update', patch: { showInScreenCapture: item.checked } });
              },
            },
            { type: 'separator' },
            {
              id: 'settings',
              label: text.settings,
              click: () => {
                openPanel('settings');
              },
            },
            {
              id: 'quit',
              label: text.quit,
              click: () => {
                app.quit();
              },
            },
          ]),
        );
      }
      const allowedSender = (id: number): boolean =>
        [...windows].some((window) => !window.isDestroyed() && window.webContents.id === id);
      const allowed = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean =>
        event.senderFrame === event.sender.mainFrame && allowedSender(event.sender.id);
      const onCommand = (event: Electron.IpcMainEvent, payload: unknown): void => {
        if (!allowed(event)) return;
        const parsed = CommandSchema.safeParse(payload);
        if (!parsed.success) {
          report(text.invalidMessage);
          return;
        }
        if (parsed.data.type !== 'debug/crashOverlay') command(parsed.data);
      };
      const onFact = (event: Electron.IpcMainEvent, payload: unknown): void => {
        if (
          !allowed(event) ||
          event.sender !== overlay?.window?.webContents ||
          session.safeMode ||
          closing
        )
          return;
        const parsed = FactSchema.safeParse(payload);
        if (!parsed.success) {
          report(text.invalidMessage);
          return;
        }
        try {
          session.fact(parsed.data);
        } catch (error) {
          report(error);
        }
      };
      ipcMain.on(IPC_CHANNELS.command, onCommand);
      ipcMain.on(IPC_CHANNELS.fact, onFact);
      ipcMain.handle(IPC_CHANNELS.getSnapshot, (event) => {
        if (!allowed(event)) throw new Error(text.unknownSender);
        return session.snapshot();
      });
      ipcMain.handle(IPC_CHANNELS.getContent, (event) => {
        if (!allowed(event)) throw new Error(text.unknownSender);
        return content;
      });
      const detachCrash = attachCrashCommand(ipcMain, allowedSender, () => {
        if (!closing) recovery?.crash();
      });
      const overlayReady = createOverlay({
        onReady: updateDebug,
        system: await createPlatform(),
        settings: initialState.settings,
        onError: report,
        onWindow: (window) => {
          registerWindow(window);
          recovery = attachRecovery({
            overlay: window,
            save,
            log,
            defaultState: () => ({ settings: defaultSettings([...names.keys()]) }),
            activeCats: () =>
              session
                .snapshot()
                .settings.visibleCats.filter((id) => Object.hasOwn(content.cats, id)),
            catName: (id) => names.get(id) ?? id,
            faultedCat: () => undefined,
            reload: async () => {
              await (await overlayReady).reload();
              updateDebug();
            },
            applySafeMode: (result) => {
              overlay?.enterSafeMode();
              session.applySafeMode(result);
              // 面板只在加载时读取内容目录；重新加载以显示停用包和中文原因。
              for (const panel of panels.values()) panel.reload();
            },
            onSafeMode: () => {
              session.suspendSaving();
              overlay?.enterSafeMode();
            },
          });
          window.webContents.on('did-finish-load', updateDebug);
        },
        onMessage: (message) => {
          if (session.safeMode || closing) return;
          if (message.type === 'stageDebug') {
            const debug = panels.get('debug');
            if (debug) send(debug, IPC_CHANNELS.stageDebug, message.report);
          } else if (
            message.type === 'catMenu' &&
            Object.hasOwn(content.cats, message.cat) &&
            overlay?.window
          ) {
            const id = message.cat;
            Menu.buildFromTemplate([
              {
                label: text.come,
                click: () => {
                  summon(id);
                },
              },
              {
                label: text.sleep,
                click: () => {
                  command({ type: 'cat/sleep', cat: id });
                },
              },
              {
                label: text.hide,
                click: () => {
                  command({ type: 'cat/setVisible', cat: id, visible: false });
                },
              },
              {
                label: text.profile,
                click: () => {
                  openPanel('profile', id);
                },
              },
            ]).popup({ window: overlay.window });
          }
        },
      });
      overlay = await overlayReady;
      if (session.safeMode) overlay.enterSafeMode();
      // 自带小图标，不依赖外部图标文件或真实猫素材。
      const pixels = Buffer.alloc(16 * 16 * 4);
      for (let y = 2; y < 14; y++)
        for (let x = 2; x < 14; x++) {
          if (y < 5 && x > 5 && x < 10) continue;
          pixels.set([80, 155, 235, 255], (y * 16 + x) * 4);
        }
      tray = new Tray(nativeImage.createFromBitmap(pixels, { width: 16, height: 16 }));
      tray.setToolTip(zh.app.name);
      tray.on('double-click', () => {
        openPanel('settings');
      });
      updateTray();
      if (
        !globalShortcut.register(debugShortcut, () => {
          openPanel('debug');
        })
      )
        report(text.shortcutFailed);
      const onSecondInstance = (): void => {
        openPanel('settings');
      };
      app.on('second-instance', onSecondInstance);
      // 关闭所有面板后继续驻留托盘。
      const onAllClosed = (): void => {};
      app.on('window-all-closed', onAllClosed);
      app.on('before-quit', (event) => {
        if (closing) return;
        event.preventDefault();
        try {
          session.flush();
        } catch (error) {
          report(error);
          void dialog.showMessageBox({ type: 'error', message: text.saveFailed });
          return;
        }
        closing = true;
        detachCrash();
        recovery?.dispose();
        ipcMain.removeListener(IPC_CHANNELS.command, onCommand);
        ipcMain.removeListener(IPC_CHANNELS.fact, onFact);
        ipcMain.removeHandler(IPC_CHANNELS.getSnapshot);
        ipcMain.removeHandler(IPC_CHANNELS.getContent);
        globalShortcut.unregister(debugShortcut);
        tray.destroy();
        protocol.unhandle(CONTENT_PROTOCOL);
        app.removeListener('second-instance', onSecondInstance);
        app.removeListener('window-all-closed', onAllClosed);
        for (const panel of panels.values()) panel.destroy();
        void overlay.dispose().finally(() => {
          detachMainLog();
          app.quit();
        });
      });
      if (process.argv.includes('--settings')) openPanel('settings');
    })
    .catch((error: unknown) => {
      log.report(String(error));
      dialog.showErrorBox(zh.app.name, `${text.startupFailed}\n${String(error)}`);
      detachMainLog();
      app.exit(1);
    });
}
