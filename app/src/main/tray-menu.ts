import { Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron';
import type { ContentCatalog } from '../shared/core-api';
import type { GameCommand, PanelName } from '../shared/ipc';
import type { Settings } from '../shared/schemas';
import { zh } from '../shared/strings.zh-CN';

const text = zh.integration;

export interface TrayMenuContext {
  content: ContentCatalog;
  settings: Settings;
  safeMode: boolean;
  command: (message: GameCommand) => void;
  summon: (cat?: string) => void;
  openPanel: (panel: PanelName, cat?: string) => void;
  quit: () => void;
}

export type TrayMenuSection = (context: TrayMenuContext) => MenuItemConstructorOptions[];

export const catMenuSection: TrayMenuSection = ({
  content,
  settings,
  safeMode,
  summon,
  command,
}) => [
  {
    label: text.summon,
    submenu: [
      {
        id: 'summon:all',
        label: zh.m2Wiring.all,
        enabled: !safeMode && settings.visibleCats.some((id) => Object.hasOwn(content.cats, id)),
        click: () => {
          summon();
        },
      },
      ...Object.entries(content.cats).map(([id, { cat }]) => ({
        id: `summon:${id}`,
        label: cat.name,
        enabled: !safeMode && settings.visibleCats.includes(id),
        click: () => {
          summon(id);
        },
      })),
    ],
  },
  {
    label: text.visibility,
    submenu: Object.entries(content.cats).map(([id, { cat }]) => ({
      id: `visible:${id}`,
      label: cat.name,
      type: 'checkbox' as const,
      checked: settings.visibleCats.includes(id),
      enabled: !safeMode,
      click: (item) => {
        command({ type: 'cat/setVisible', cat: id, visible: item.checked });
      },
    })),
  },
];

export const captureMenuSection: TrayMenuSection = ({ settings, command }) => [
  {
    id: 'capture',
    label: text.capture,
    type: 'checkbox',
    checked: settings.showInScreenCapture,
    click: (item) => {
      command({ type: 'settings/update', patch: { showInScreenCapture: item.checked } });
    },
  },
];

export const applicationMenuSection: TrayMenuSection = ({ openPanel, quit }) => [
  { type: 'separator' },
  {
    id: 'settings',
    label: text.settings,
    click: () => {
      openPanel('settings');
    },
  },
  {
    id: 'quit',
    label: text.quit,
    click: () => {
      quit();
    },
  },
];

export function createTrayMenu(options: {
  context: () => TrayMenuContext;
  sections: readonly TrayMenuSection[];
  openSettings: () => void;
}) {
  // 自带小图标，不依赖外部图标文件或真实猫素材。
  const pixels = Buffer.alloc(16 * 16 * 4);
  for (let y = 2; y < 14; y++)
    for (let x = 2; x < 14; x++) {
      if (y < 5 && x > 5 && x < 10) continue;
      pixels.set([80, 155, 235, 255], (y * 16 + x) * 4);
    }
  const tray = new Tray(nativeImage.createFromBitmap(pixels, { width: 16, height: 16 }));
  tray.setToolTip(zh.app.name);
  tray.on('double-click', () => {
    options.openSettings();
  });
  return {
    update(): void {
      const context = options.context();
      tray.setContextMenu(
        Menu.buildFromTemplate(options.sections.flatMap((section) => section(context))),
      );
    },
    dispose(): void {
      tray.destroy();
    },
  };
}
