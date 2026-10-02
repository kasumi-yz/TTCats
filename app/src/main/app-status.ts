import type { AppStatus } from '../shared/ipc';

/**
 * 程序状态（#52）：主进程各模块各改各的字段，每改一次 revision 加 1 并推给面板。
 * 目前接上的只有显示器（#65）。更新和快捷键的字段由 #68、#66 接入前，按"还没做"的样子给：
 * 不是能自动更新的安装版；还没尝试注册快捷键（accelerator 为空）。
 */
export function createAppStatus(options: {
  version: string;
  publish: (status: AppStatus) => void;
}) {
  let status: AppStatus = {
    revision: 0,
    version: options.version,
    update: { state: 'unsupported' },
    hideAllShortcut: { accelerator: '', registered: false },
    displays: [],
    overlayDisplayId: null,
  };
  return {
    get: (): AppStatus => status,
    set(patch: Partial<Omit<AppStatus, 'revision'>>): void {
      const next = { ...status, ...patch };
      // 显示器事件常常一来一批，内容没变就不推送
      if (JSON.stringify({ ...next, revision: 0 }) === JSON.stringify({ ...status, revision: 0 }))
        return;
      status = { ...next, revision: status.revision + 1 };
      options.publish(status);
    },
  };
}
