// 仅开发/验收的独立入口，正式启动接线由 #28 完成。
import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, net, protocol, screen } from 'electron';
import { loadContent, registerContentProtocol, registerContentScheme } from '../content';
import { createPlatform } from '../platform';
import { defaultSettings } from '../../shared/schemas/settings';
import { IPC_CHANNELS, type Fact, type StateSnapshot } from '../../shared/ipc';
import { configureOverlayGpu, createOverlay } from './index';

configureOverlayGpu();
registerContentScheme(protocol);
app.setPath('userData', join(import.meta.dirname, 'user-data'));
void app.whenReady().then(async () => {
  const root = process.env['TTCATS_OVERLAY_CONTENT'];
  if (!root) throw new Error('TTCATS_OVERLAY_CONTENT');
  const content = loadContent(root);
  if (Object.keys(content.cats).length !== 3) throw new Error('Expected 3 validated test cats');
  registerContentProtocol(protocol, net, root, content);
  let snapshot: StateSnapshot = {
    revision: 1,
    at: Date.now(),
    settings: defaultSettings(Object.keys(content.cats)),
  };
  const facts: Fact[] = [];
  const messages: unknown[] = [];
  const problems: string[] = [];
  ipcMain.handle(IPC_CHANNELS.getContent, () => content);
  ipcMain.handle(IPC_CHANNELS.getSnapshot, () => snapshot);
  ipcMain.on(IPC_CHANNELS.fact, (_event, fact: Fact) => {
    facts.push(fact);
  });
  const overlay = await createOverlay({
    system: await createPlatform(),
    settings: snapshot.settings,
    preload: join(import.meta.dirname, '../preload/index.cjs'),
    load: (window) => window.loadFile(join(import.meta.dirname, 'renderer/overlay/test.html')),
    onMessage: (message) => {
      messages.push(message);
    },
    onError: (error) => {
      problems.push(String(error));
      console.error(error);
    },
  });
  let probe: BrowserWindow | undefined;
  const fixture = {
    overlay,
    captureProtection(enabled: boolean) {
      overlay.updateSettings({ ...snapshot.settings, showInScreenCapture: !enabled });
    },
    facts,
    messages,
    problems,
    screen: () => screen.getPrimaryDisplay(),
    async probe(fullscreen: boolean) {
      if (probe && !probe.isDestroyed()) probe.destroy();
      probe = new BrowserWindow({
        ...(fullscreen ? screen.getPrimaryDisplay().bounds : screen.getPrimaryDisplay().workArea),
        title: 'TTCats overlay probe',
        frame: false,
        fullscreen,
        backgroundColor: '#293342',
        webPreferences: { sandbox: true },
      });
      await probe.loadURL(
        'data:text/html,<body style="margin:0"><input id="input" autofocus><script>window.clicks=0;document.addEventListener("mousedown",()=>window.clicks++);</script></body>',
      );
      probe.show();
      probe.focus();
    },
    closeProbe() {
      probe?.destroy();
      probe = undefined;
    },
    hide(hidden: boolean) {
      snapshot = {
        ...snapshot,
        revision: snapshot.revision + 1,
        at: Date.now(),
        settings: { ...snapshot.settings, visibleCats: hidden ? [] : Object.keys(content.cats) },
      };
      overlay.window?.webContents.send(IPC_CHANNELS.snapshot, snapshot);
      overlay.updateSettings(snapshot.settings);
    },
    clip(cat: string, clip: string) {
      overlay.window?.webContents.send(IPC_CHANNELS.stageCommand, {
        type: 'debug/playClip',
        cat,
        clip,
      });
    },
    async rebuildMany() {
      await Promise.all([overlay.rebuild(), overlay.rebuild(), overlay.rebuild()]);
    },
  };
  Object.assign(globalThis, { overlayFixture: fixture });
  app.on('before-quit', () => {
    void overlay.dispose();
  });
});
