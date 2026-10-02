// 独立的 Windows 验收入口；正式入口由 #28 接入，不随正式构建发布。
import * as fs from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { app, BrowserWindow, ipcMain } from 'electron';
import { CURRENT_SAVE_VERSION, defaultGameState, GameStateSchema } from '../../shared/schemas/save';
import { zh } from '../../shared/strings.zh-CN';
import { FileLog, attachMainLog, attachRendererLog } from '../log';
import { SaveStore } from '../save';
import { attachCrashCommand, attachRecovery } from './index';

const directory = process.env['TTCATS_RECOVERY_CHECK_DIR'];
if (directory === undefined) throw new Error('TTCATS_RECOVERY_CHECK_DIR');
const root = directory;
const scenario = process.env['TTCATS_RECOVERY_SCENARIO'];
app.commandLine.removeSwitch('disable-hang-monitor');
app.setPath('userData', join(root, 'electron'));

void app.whenReady().then(async () => {
  const log = new FileLog({ directory: join(root, 'logs'), maxBytes: 1024 });
  const detachMain = attachMainLog(log);
  const save = new SaveStore({
    directory: root,
    currentVersion: CURRENT_SAVE_VERSION,
    schema: GameStateSchema,
    now: Date.now,
    log: (message) => {
      log.write(message);
    },
    defaultState: () => defaultGameState([]),
  });
  save.requestSave(defaultGameState(['backup-cat']));
  save.flush();
  save.requestSave(defaultGameState(['test-cat']));
  save.flush();
  const overlay = new BrowserWindow({ title: 'Recovery overlay', width: 300, height: 200 });
  const panels = new BrowserWindow({
    title: 'Recovery panels',
    width: 420,
    height: 250,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
    },
  });
  const detachPanels = attachRendererLog(panels.webContents, 'panels', log);
  const timeline: { event: string; at: number }[] = [];
  const record = (event: string): void => {
    timeline.push({ event, at: performance.now() });
    fs.writeFileSync(join(root, 'timeline.json'), JSON.stringify(timeline));
  };
  overlay.webContents.on('render-process-gone', () => {
    record('gone');
  });
  let started = 0;
  const slowServer = createServer((request, response) => {
    if (request.url === '/slow') {
      started++;
      fs.writeFileSync(join(root, 'loading-started.json'), JSON.stringify(started));
      response.setHeader('Content-Type', 'text/html');
      response.setHeader('Cache-Control', 'no-store');
      response.end('<title>Recovery overlay</title><img src="/wait">');
    } else {
      const timer = setTimeout(
        () => response.end('resource'),
        scenario === 'slow-load' ? 12000 : 60000,
      );
      response.once('close', () => {
        clearTimeout(timer);
      });
    }
  });
  let slowUrl: string | undefined;
  if (scenario === 'loading-crash' || scenario === 'slow-load') {
    await new Promise<void>((resolve) => {
      slowServer.listen(0, '127.0.0.1', resolve);
    });
    const address = slowServer.address();
    if (address === null || typeof address === 'string') throw new Error('No fixture server');
    slowUrl = `http://127.0.0.1:${address.port}/slow`;
  }
  let reloads = 0;
  let attempts = 0;
  const loadOverlay = async (): Promise<void> => {
    await overlay.loadURL('data:text/html,<title>Recovery overlay</title><p>Overlay</p>');
  };
  const recovery = attachRecovery({
    overlay,
    log,
    save,
    defaultState: () => defaultGameState([]),
    activeCats: () => ['test-cat'],
    catName: () => '测试猫',
    reload: async () => {
      attempts++;
      fs.writeFileSync(join(root, 'reload-attempts.json'), JSON.stringify(attempts));
      try {
        if (slowUrl === undefined) await loadOverlay();
        else await overlay.loadURL(slowUrl);
      } catch (error) {
        record('reject');
        throw error;
      }
      reloads++;
      fs.writeFileSync(join(root, 'reloads.json'), JSON.stringify(reloads));
    },
    applySafeMode: (result) => {
      fs.writeFileSync(join(root, 'safe-mode.json'), JSON.stringify(result));
    },
    // 默认的原生 dialog 按钮由单元测试覆盖；桌面验收用可自动读取的中文提示窗口。
    notify: async (message) => {
      const notice = new BrowserWindow({
        title: zh.recovery.safeModeTitle,
        width: 600,
        height: 300,
      });
      await notice.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(`<title>${zh.recovery.safeModeTitle}</title><p>${message}</p>`)}`,
      );
    },
  });
  const detachCommand = attachCrashCommand(
    ipcMain,
    (id) => id === panels.webContents.id,
    recovery.crash,
  );
  app.on('before-quit', () => {
    detachCommand();
    recovery.dispose();
    if (slowServer.listening) {
      slowServer.closeAllConnections();
      slowServer.close();
    }
    detachMain();
    detachPanels();
  });
  if (scenario === 'double-crash') {
    // 刻意对已经死亡、尚未重载的进程再发一次命令：它不会产生第二个 gone。
    overlay.webContents.once('render-process-gone', () => {
      recovery.crash();
    });
  }
  await loadOverlay();
  await panels.loadURL('data:text/html,<title>Recovery panels</title><p>Debug panel</p>');
});
app.on('window-all-closed', () => {
  app.quit();
});
