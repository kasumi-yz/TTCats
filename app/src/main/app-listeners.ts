import type { App } from 'electron';
import type { PanelName } from '../shared/ipc';
import { startupOptions } from './autostart';
import type { MainFeature } from './features';

/** 再次启动时打开设置（自动启动除外）；关闭所有面板后继续驻留托盘。 */
export function createAppListeners(options: {
  app: Pick<App, 'on' | 'removeListener'>;
  openPanel: (panel: PanelName) => void;
}) {
  const { app } = options;
  const onSecondInstance = (_event: Electron.Event, args: string[]): void => {
    if (!startupOptions(args).startupQuiet) options.openPanel('settings');
  };
  const onAllClosed = (): void => {};
  return {
    start(): void {
      app.on('second-instance', onSecondInstance);
      app.on('window-all-closed', onAllClosed);
    },
    dispose(): void {
      app.removeListener('second-instance', onSecondInstance);
      app.removeListener('window-all-closed', onAllClosed);
    },
  } satisfies MainFeature;
}
