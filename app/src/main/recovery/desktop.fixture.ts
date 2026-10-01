// 独立的 Windows 验收入口；正式入口由 #28 接入，不随正式构建发布。
import * as fs from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, ipcMain } from 'electron';
import { CURRENT_SAVE_VERSION, GameStateSchema } from '../../shared/schemas/save';
import { defaultSettings } from '../../shared/schemas/settings';
import { zh } from '../../shared/strings.zh-CN';
import { FileLog, attachMainLog, attachRendererLog } from '../log';
import { SaveStore } from '../save';
import { attachCrashCommand, attachRecovery } from './index';

const directory = process.env['TTCATS_RECOVERY_CHECK_DIR'];
if (directory === undefined) throw new Error('TTCATS_RECOVERY_CHECK_DIR');
const root = directory;
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
    defaultState: () => ({ settings: defaultSettings([]) }),
  });
  save.requestSave({ settings: defaultSettings(['backup-cat']) });
  save.flush();
  save.requestSave({ settings: defaultSettings(['test-cat']) });
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
  let reloads = 0;
  const loadOverlay = async (): Promise<void> => {
    await overlay.loadURL('data:text/html,<title>Recovery overlay</title><p>Overlay</p>');
  };
  const recovery = attachRecovery({
    overlay,
    log,
    save,
    defaultState: () => ({ settings: defaultSettings([]) }),
    activeCats: () => ['test-cat'],
    reload: async () => {
      await loadOverlay();
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
    detachMain();
    detachPanels();
  });
  await loadOverlay();
  await panels.loadURL('data:text/html,<title>Recovery panels</title><p>Debug panel</p>');
});
app.on('window-all-closed', () => {
  app.quit();
});
