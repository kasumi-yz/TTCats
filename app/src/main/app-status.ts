import type { AppStatus } from '../shared/ipc';

/**
 * 程序状态（#52）：主进程各模块各改各的字段——#65 显示器、#66 一键隐藏快捷键、#68 自动更新。
 * 每改一次 revision 加 1 并推给面板；内容没变（比如显示器事件一来一批）就不推送。
 */
export function createAppStatus(
  initial: Omit<AppStatus, 'revision'>,
  publish: (status: AppStatus) => void,
) {
  let status: AppStatus = { ...structuredClone(initial), revision: 0 };
  return {
    current: (): AppStatus => structuredClone(status),
    update(patch: Partial<Omit<AppStatus, 'revision' | 'version'>>): void {
      const next = structuredClone({ ...status, ...patch });
      if (JSON.stringify({ ...next, revision: 0 }) === JSON.stringify({ ...status, revision: 0 }))
        return;
      status = { ...next, revision: status.revision + 1 };
      publish(structuredClone(status));
    },
  };
}
