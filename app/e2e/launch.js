import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import fs, { readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { extname, join, resolve, sep } from 'node:path';
import { app, Tray, Menu, dialog, globalShortcut, screen } from 'electron';
import koffi from 'koffi';

// 拍照测试写入临时图片目录，不污染用户相册。
if (process.env.TTCATS_TEST_APP_DATA) {
  const pictures = join(process.env.TTCATS_TEST_APP_DATA, 'pictures');
  fs.mkdirSync(pictures, { recursive: true });
  app.setPath('pictures', pictures);
}
// 只观察原生边界，业务仍执行正式构建入口。
globalThis.smoke = {
  trays: [],
  menus: [],
  popups: [],
  popupWindows: [],
  dialogs: [],
  saveBlocked: false,
  saveDialogResolvers: [],
  shortcuts: new Map(),
  blockedShortcut: null,
  fullscreen: false,
  crashes: 0,
  slowRequests: 0,
  pointerInput: null,
};
// #60 冒烟仅替换输入采样，保留正式的看门狗、IPC、遮罩和 Stage；真鼠标穿透由 #69 验收。
app.once('ready', () => {
  const cursorScreenPoint = screen.getCursorScreenPoint.bind(screen);
  screen.getCursorScreenPoint = () => {
    const input = globalThis.smoke.pointerInput;
    return input ? { x: input.x, y: input.y } : cursorScreenPoint();
  };
});
// 在文件系统边界模拟存档目录拒绝写入，保留正式 SaveStore、退出流程和日志。
const openSync = fs.openSync;
fs.openSync = function (path, ...args) {
  if (globalThis.smoke.saveBlocked && String(path).endsWith('save.json.tmp')) {
    throw Object.assign(new Error('EACCES: permission denied, open ' + String(path)), {
      code: 'EACCES',
    });
  }
  return openSync.call(this, path, ...args);
};
syncBuiltinESMExports();
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
  if (args[0] !== 'shell32.dll' && args[0] !== 'user32.dll') return library;
  return {
    ...library,
    func(...signature) {
      if (String(signature[0]).includes('GetAsyncKeyState')) {
        const native = library.func(...signature);
        return (key) => {
          const input = globalThis.smoke.pointerInput;
          if (!input) return native(key);
          return (key === 0x11 ? input.ctrlDown : (key === 1 || key === 2) && input.leftDown)
            ? -32768
            : 0;
        };
      }
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
// #66 允许在系统边界受控。仅并行本机测试显式启用；默认和 CI 仍注册真实快捷键。
const controlledShortcuts = process.env.TTCATS_SMOKE_CONTROL_SHORTCUTS === '1';
globalShortcut.register = (accelerator, callback) => {
  const registered =
    globalThis.smoke.blockedShortcut !== accelerator &&
    (controlledShortcuts || register(accelerator, callback));
  if (registered) globalThis.smoke.shortcuts.set(accelerator, callback);
  return registered;
};
const unregister = globalShortcut.unregister.bind(globalShortcut);
globalShortcut.unregister = (accelerator) => {
  globalThis.smoke.shortcuts.delete(accelerator);
  if (!controlledShortcuts) unregister(accelerator);
};
if (controlledShortcuts)
  globalShortcut.isRegistered = (accelerator) => globalThis.smoke.shortcuts.has(accelerator);
dialog.showMessageBox = async (options) => {
  globalThis.smoke.dialogs.push(options);
  if (options.buttons?.includes('不保存，直接退出')) {
    return new Promise((resolve) => {
      globalThis.smoke.saveDialogResolvers.push((response) =>
        resolve({ response, checkboxChecked: false }),
      );
    });
  }
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
