import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { app, Tray, Menu, dialog, globalShortcut } from 'electron';
import koffi from 'koffi';

// 只观察原生边界，业务仍执行正式构建入口。
globalThis.smoke = {
  trays: [],
  menus: [],
  popups: [],
  popupWindows: [],
  dialogs: [],
  shortcuts: new Map(),
  fullscreen: false,
  crashes: 0,
  slowRequests: 0,
};
app.on('browser-window-created', (_event, window) => {
  window.webContents.on('render-process-gone', () => {
    globalThis.smoke.crashes++;
  });
});
// CI/当前桌面可能持续报告忙碌。只控制这一个系统查询，验证正式主进程的隐藏/恢复。
// 不把这项测试当作原生全屏识别或桌面焦点验收（后者属于 #29）。
const load = koffi.load;
koffi.load = function (...args) {
  const library = load(...args);
  if (args[0] !== 'shell32.dll') return library;
  return {
    ...library,
    func(...signature) {
      if (String(signature[0]).includes('SHQueryUserNotificationState'))
        return (state) => {
          state[0] = globalThis.smoke.fullscreen ? 3 : 5;
          return 0;
        };
      return library.func(...signature);
    },
  };
};
const setContextMenu = Tray.prototype.setContextMenu;
Tray.prototype.setContextMenu = function (menu) {
  if (!globalThis.smoke.trays.includes(this)) globalThis.smoke.trays.push(this);
  globalThis.smoke.menus.push(menu);
  return setContextMenu.call(this, menu);
};
Menu.prototype.popup = function (options) {
  globalThis.smoke.popups.push(this);
  globalThis.smoke.popupWindows.push({
    id: options.window.id,
    focusable: options.window.isFocusable(),
  });
};
const register = globalShortcut.register.bind(globalShortcut);
globalShortcut.register = (accelerator, callback) => {
  globalThis.smoke.shortcuts.set(accelerator, callback);
  return register(accelerator, callback);
};
dialog.showMessageBox = async (options) => {
  globalThis.smoke.dialogs.push(options);
  return { response: 1, checkboxChecked: false };
};
dialog.showErrorBox = (title, message) => {
  console.error(title, message);
};
app.setAppPath(fileURLToPath(new URL('../', import.meta.url)));
if (process.env.TTCATS_SMOKE_SLOW_OVERLAY === '1') {
  const root = fileURLToPath(new URL('../out/renderer/', import.meta.url));
  const server = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/slow.js') {
      globalThis.smoke.slowRequests++;
      setTimeout(() => {
        response.writeHead(200, { 'Content-Type': 'text/javascript' });
        response.end('');
      }, 3000);
      return;
    }
    const file = resolve(root, '.' + pathname);
    if (!file.startsWith(resolve(root) + sep)) {
      response.writeHead(403);
      response.end();
      return;
    }
    try {
      let content = readFileSync(file);
      if (pathname === '/overlay/index.html' && globalThis.smoke.crashes > 0)
        content = Buffer.from(
          content.toString().replace('</head>', '<script src="/slow.js"></script></head>'),
        );
      response.writeHead(200, {
        'Content-Type':
          { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(file)] ??
          'application/octet-stream',
      });
      response.end(content);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.ELECTRON_RENDERER_URL = `http://127.0.0.1:${server.address().port}`;
  app.on('will-quit', () => {
    server.close();
    server.closeAllConnections();
  });
}
await import('../out/main/index.js');
