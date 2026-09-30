// "探针窗口"：一个普通的、放在猫下面的窗口，记录它自己收到的鼠标点击和键盘输入。
// 它是独立的进程（和桌面层不是同一个程序），用来确认"猫下面的窗口能正常收到点击"。
//
// 参数：--bounds=x,y,w,h（DIP）  --color=#rrggbb  --fullscreen  --title=文字
//       --on-top  置顶（仍在桌面层下面）。测试时防止别的程序的窗口盖住探针窗口、让穿透的点击误落到别的程序上

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow, desktopCapturer, ipcMain, screen } from 'electron';
import { startControlServer } from '../shared/control';
import { hwndOf } from '../shared/win32';

const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

app.setPath('userData', join(tmpdir(), 'ttcats-overlay-spike-probe'));

interface ProbeEvent {
  t: number;
  type: string;
  x?: number;
  y?: number;
  ctrl?: boolean;
  value?: string;
}
const events: ProbeEvent[] = [];
let win: BrowserWindow;
let value = '';

app.whenReady().then(async () => {
  const [x, y, width, height] = (arg('bounds') ?? '100,100,1000,700').split(',').map(Number);
  win = new BrowserWindow({
    x,
    y,
    width,
    height,
    title: arg('title') ?? 'TTCats 探针窗口',
    backgroundColor: arg('color') ?? '#3a6ea5',
    autoHideMenuBar: true,
    fullscreen: process.argv.includes('--fullscreen'),
    webPreferences: { preload: join(__dirname, 'probe-preload.js'), contextIsolation: true },
  });
  if (process.argv.includes('--on-top')) win.setAlwaysOnTop(true, 'floating');
  win.loadFile(join(__dirname, 'probe.html'), { query: { color: arg('color') ?? '#3a6ea5' } });
  ipcMain.on('probe-event', (_e, ev: ProbeEvent) => {
    events.push({ ...ev, t: Date.now() });
    if (ev.type === 'input') value = ev.value ?? '';
  });
  await startControlServer({
    'GET /events': (_b, q) => events.filter((e) => e.t > Number(q.get('since') ?? 0)),
    'GET /state': () => ({
      pid: process.pid,
      hwnd: hwndOf(win.getNativeWindowHandle()),
      bounds: win.getBounds(),
      contentBounds: win.getContentBounds(),
      focused: win.isFocused(),
      fullscreen: win.isFullScreen(),
      value,
    }),
    'POST /cmd': async (b) => {
      switch (b.type) {
        case 'fullscreen':
          win.setFullScreen(Boolean(b.on));
          break;
        case 'bounds':
          win.setBounds(b.bounds as Electron.Rectangle);
          break;
        case 'clear':
          events.length = 0;
          value = '';
          await win.webContents.executeJavaScript('document.querySelector("textarea").value = ""');
          break;
        case 'focus':
          win.focus();
          break;
        case 'quit':
          setTimeout(() => app.quit(), 50);
          break;
        case 'capture': {
          // 用 Chromium 的屏幕采集（浏览器/Electron 类会议软件共享屏幕走的就是这条路）取一个像素
          const d = screen.getPrimaryDisplay();
          const size = { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
          const [src] = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
          const img = src.thumbnail;
          const bmp = img.toBitmap();
          const w = img.getSize().width;
          const o = (Number(b.y) * w + Number(b.x)) * 4;
          return { rgb: [bmp[o + 2], bmp[o + 1], bmp[o]], size: img.getSize() };
        }
      }
      return { ok: true };
    },
  });
});
app.on('window-all-closed', () => app.quit());
