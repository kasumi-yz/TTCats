import { Menu, type BrowserWindow } from 'electron';
import type { GameCommand, PanelName } from '../shared/ipc';
import { zh } from '../shared/strings.zh-CN';

export function showCatMenu(options: {
  cat: string;
  window: BrowserWindow;
  summon: (cat: string) => void;
  command: (message: GameCommand) => void;
  openPanel: (panel: PanelName, cat?: string) => void;
}): void {
  const { cat, summon, command, openPanel, window } = options;
  const text = zh.integration;
  Menu.buildFromTemplate([
    {
      label: text.come,
      click: () => {
        summon(cat);
      },
    },
    {
      label: text.sleep,
      click: () => {
        command({ type: 'cat/sleep', cat });
      },
    },
    {
      label: text.hide,
      click: () => {
        command({ type: 'cat/setVisible', cat, visible: false });
      },
    },
    {
      label: text.profile,
      click: () => {
        openPanel('profile', cat);
      },
    },
  ]).popup({ window });
}
