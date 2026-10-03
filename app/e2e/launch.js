import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import fs, { readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { extname, join, resolve, sep } from 'node:path';
import { app, Tray, Menu, dialog, globalShortcut, screen, shell } from 'electron';
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
  saveDialogs: [],
  savePath: null,
  shownItems: [],
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
// 冒烟只关心入场、出场、让开等流程，不关心测试猫走多慢。在读文件边界把测试猫
// 走路、奔跑片段的 speed 放大，免得按真实时间等 30 px/s 的猫横穿屏幕。
// 只在冒烟里生效：test-content 本身不变，交互测试和性能测试仍用原速度。
const speedup = Number(process.env.TTCATS_SMOKE_WALK_SPEEDUP ?? '1');
const clipJson = /[\\/]test-content[\\/]cats[\\/][^\\/]+[\\/]clips[\\/][^\\/]+\.json$/;
const readFile = fs.readFileSync;
fs.readFileSync = function (path, ...args) {
  const data = readFile.call(this, path, ...args);
  if (speedup === 1 || typeof data !== 'string' || !clipJson.test(String(path))) return data;
  const clip = JSON.parse(data);
  if (!(clip.speed > 0)) return data;
  return JSON.stringify({ ...clip, speed: clip.speed * speedup });
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
const isRegistered = globalShortcut.isRegistered.bind(globalShortcut);
const unregister = globalShortcut.unregister.bind(globalShortcut);
// #66 允许在系统边界受控。仅并行本机测试显式启用；默认和 CI 仍注册真实快捷键。
const controlledShortcuts = process.env.TTCATS_SMOKE_CONTROL_SHORTCUTS === '1';
// 本机并行会话可以为冒烟分配独立快捷键；CI 默认仍验证正式快捷键。
const smokeAccelerator = (accelerator) =>
  accelerator === 'CommandOrControl+Shift+F10'
    ? (process.env.TTCATS_SMOKE_DEBUG_SHORTCUT ?? accelerator)
    : accelerator;
globalShortcut.register = (accelerator, callback) => {
  const registered =
    globalThis.smoke.blockedShortcut !== accelerator &&
    (controlledShortcuts || register(smokeAccelerator(accelerator), callback));
  if (registered) globalThis.smoke.shortcuts.set(accelerator, callback);
  return registered;
};
globalShortcut.unregister = (accelerator) => {
  globalThis.smoke.shortcuts.delete(accelerator);
  if (!controlledShortcuts) unregister(smokeAccelerator(accelerator));
};
globalShortcut.isRegistered = (accelerator) =>
  controlledShortcuts
    ? globalThis.smoke.shortcuts.has(accelerator)
    : isRegistered(smokeAccelerator(accelerator));
dialog.showMessageBox = async (options) => {
  globalThis.smoke.dialogs.push(options);
  if (options.buttons?.includes('不保存，直接退出')) {
    return new Promise((resolve) => {
      globalThis.smoke.saveDialogResolvers.push((response) =>
        resolve({ response, checkboxChecked: false }),
      );
    });
  }
  // 其余提示框按取消键（关闭）处理。
  return { response: options.cancelId ?? 1, checkboxChecked: false };
};
// 保存对话框返回测试指定的路径；没指定时当作取消。
dialog.showSaveDialog = async (options) => {
  globalThis.smoke.saveDialogs.push(options);
  const filePath = globalThis.smoke.savePath;
  return filePath ? { canceled: false, filePath } : { canceled: true, filePath: '' };
};
shell.showItemInFolder = (path) => {
  globalThis.smoke.shownItems.push(path);
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
