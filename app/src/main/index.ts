// 主进程入口。目前只打开一个空的面板窗口，供冒烟测试确认应用能启动。
// 桌面层、托盘、core/game、存档等在 M1 里按各自的 issue 加进来。
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { zh } from '../shared/strings.zh-CN';

function createPanelsWindow(): void {
  const win = new BrowserWindow({
    width: 480,
    height: 320,
    title: zh.app.panelsTitle,
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  const devServerUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devServerUrl !== undefined) {
    void win.loadURL(`${devServerUrl}/panels/index.html`);
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/panels/index.html'));
  }
}

void app.whenReady().then(createPanelsWindow);

app.on('window-all-closed', () => {
  app.quit();
});
