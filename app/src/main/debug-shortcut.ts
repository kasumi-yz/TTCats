import { globalShortcut } from 'electron';
import { DEBUG_PANEL_SHORTCUT } from '../shared/accelerator';
import type { PanelName } from '../shared/ipc';
import { zh } from '../shared/strings.zh-CN';
import type { MainFeature } from './features';

/** 隐藏快捷键 Ctrl+Shift+F10 打开调试台。 */
export function createDebugShortcut(options: {
  openPanel: (panel: PanelName) => void;
  report: (error: unknown) => void;
}) {
  return {
    start(): void {
      if (
        !globalShortcut.register(DEBUG_PANEL_SHORTCUT, () => {
          options.openPanel('debug');
        })
      )
        options.report(zh.integration.shortcutFailed);
    },
    dispose(): void {
      globalShortcut.unregister(DEBUG_PANEL_SHORTCUT);
    },
  } satisfies MainFeature;
}
