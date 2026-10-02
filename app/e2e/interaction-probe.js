// 真实桌面验收（#29）的探针窗口：独立的 Electron 进程，铺满工作区、放在猫下面。
// 记录它收到的每次鼠标按下（屏幕 DIP 坐标、是否按着 Ctrl），以及输入框里打进去的字。
// 普通窗口，不置顶：桌面层（置顶）必须一直在它上面。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow, screen } from 'electron';

app.setPath('userData', mkdtempSync(join(tmpdir(), 'ttcats-probe-')));
app.on('window-all-closed', () => {
  app.quit();
});
// 不能在顶层 await whenReady：Playwright 的加载器要等主模块执行完才放行 ready。
void app.whenReady().then(async () => {
  // 性能测试的"全屏时自动隐藏"阶段用真正的全屏窗口，让系统报告前台有全屏程序。
  const fullscreen = process.env.TTCATS_PROBE_FULLSCREEN === '1';
  const window = new BrowserWindow({
    ...screen.getPrimaryDisplay().workArea,
    title: 'TTCats interaction probe',
    frame: false,
    // 不可调整大小的窗口在 Windows 上切不到真正的全屏
    resizable: fullscreen,
    backgroundColor: '#4d6f8f',
    show: false,
    webPreferences: { sandbox: true },
  });
  await window.loadURL(
    'data:text/html;charset=utf-8,' +
      encodeURIComponent(`<!doctype html><title>TTCats interaction probe</title>
  <body style="margin:0;background:#4d6f8f;overflow:hidden;font:14px sans-serif;color:#fff">
  <input id="input" style="position:absolute;left:40px;top:40px;width:320px;height:32px;font-size:18px">
  <div style="position:absolute;left:40px;top:84px">TTCats 交互测试探针窗口：测试期间请不要动鼠标和键盘</div>
  <script>
  window.events = [];
  document.addEventListener('mousedown', (e) => {
    window.events.push({ t: Date.now(), type: 'mousedown', x: e.screenX, y: e.screenY, ctrl: e.ctrlKey, button: e.button });
  }, true);
  </script>
  </body>`),
  );
  window.show();
  window.focus();
  // 构造时直接设 fullscreen 在 Windows 上可能只拿到工作区大小，要显示以后再切换
  if (fullscreen) {
    const entered = new Promise((resolve) => window.once('enter-full-screen', resolve));
    window.setFullScreen(true);
    await entered;
  }
  globalThis.probe = {
    hwnd: Number(window.getNativeWindowHandle().readBigUInt64LE(0)),
    window,
  };
});
