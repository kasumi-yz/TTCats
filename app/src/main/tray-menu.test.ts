import { EventEmitter } from 'node:events';
import type { MenuItemConstructorOptions } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { catalog, defined, testCat } from '../core/stage/test-fixtures';
import { defaultSettings } from '../shared/schemas';
import { zh } from '../shared/strings.zh-CN';
import {
  applicationMenuSection,
  captureMenuSection,
  catMenuSection,
  createTrayMenu,
  type TrayMenuContext,
  type TrayMenuSection,
} from './tray-menu';

const mock = vi.hoisted(() => ({
  templates: [] as MenuItemConstructorOptions[][],
  trays: [] as EventEmitter[],
  destroy: vi.fn(),
}));
vi.mock('electron', () => ({
  nativeImage: { createFromBitmap: vi.fn() },
  Menu: { buildFromTemplate: (items: MenuItemConstructorOptions[]) => items },
  Tray: class extends EventEmitter {
    constructor() {
      super();
      mock.trays.push(this);
    }
    setToolTip = vi.fn();
    setContextMenu(items: MenuItemConstructorOptions[]) {
      mock.templates.push(items);
    }
    destroy = mock.destroy;
  },
}));

function setup(
  sections: TrayMenuSection[] = [catMenuSection, captureMenuSection, applicationMenuSection],
) {
  const context: TrayMenuContext = {
    content: catalog(
      [testCat('first', { name: '第一只猫' }), testCat('second', { name: '第二只猫' })].map(
        (cat) => ({ cat }),
      ),
    ),
    settings: defaultSettings(['first']),
    safeMode: false,
    command: vi.fn(),
    summon: vi.fn(),
    openPanel: vi.fn(),
    quit: vi.fn(),
  };
  const getContext = vi.fn(() => context);
  const openSettings = vi.fn();
  const tray = createTrayMenu({ context: getContext, sections, openSettings });
  tray.update();
  const menu = (): MenuItemConstructorOptions[] => defined(mock.templates.at(-1));
  const cats = (index: number): MenuItemConstructorOptions[] =>
    defined(menu()[index]).submenu as MenuItemConstructorOptions[];
  return { tray, context, getContext, openSettings, menu, cats };
}

describe('托盘菜单段', () => {
  beforeEach(() => {
    mock.templates.length = 0;
    mock.trays.length = 0;
    vi.clearAllMocks();
  });

  it('按注册顺序拼装，保留原有菜单文字、分隔线和猫咪包顺序', () => {
    const { menu, cats } = setup();
    expect(menu().map((item) => item.label ?? item.type)).toEqual([
      zh.integration.summon,
      zh.integration.visibility,
      zh.integration.capture,
      'separator',
      zh.integration.settings,
      zh.integration.quit,
    ]);
    expect(cats(0).map((item) => [item.id, item.label])).toEqual([
      ['summon:first', '第一只猫'],
      ['summon:second', '第二只猫'],
    ]);
    expect(cats(1).map((item) => item.id)).toEqual(['visible:first', 'visible:second']);
  });

  it('新菜单段插在指定位置，不改变相邻段的顺序', () => {
    const extra: TrayMenuSection = () => [{ id: 'extra', label: '测试菜单段' }];
    const { menu } = setup([catMenuSection, extra, captureMenuSection, applicationMenuSection]);
    expect(menu().map((item) => item.id ?? item.label ?? item.type)).toEqual([
      zh.integration.summon,
      zh.integration.visibility,
      'extra',
      'capture',
      'separator',
      'settings',
      'quit',
    ]);
  });

  it('安全模式封住召唤和显示入口，仍可改截图显示、打开设置和退出', () => {
    const { tray, context, cats, menu } = setup();
    expect(cats(0).map((item) => item.enabled)).toEqual([true, false]);
    expect(cats(1).map((item) => item.checked)).toEqual([true, false]);
    context.safeMode = true;
    tray.update();
    expect([...cats(0), ...cats(1)].every((item) => item.enabled === false)).toBe(true);
    for (const id of ['capture', 'settings', 'quit'])
      expect(menu().find((item) => item.id === id)?.enabled).not.toBe(false);
  });

  it('刷新重新读取快照，复选框跟随主进程的显示偏好', () => {
    const { tray, context, cats, menu } = setup();
    context.settings = { ...context.settings, visibleCats: ['second'], showInScreenCapture: true };
    tray.update();
    expect(cats(0).map((item) => item.enabled)).toEqual([false, true]);
    expect(cats(1).map((item) => item.checked)).toEqual([false, true]);
    expect(menu().find((item) => item.id === 'capture')?.checked).toBe(true);
  });

  it('双击只打开设置，不额外查询快照；退出时销毁托盘', () => {
    const { tray, getContext, openSettings } = setup();
    getContext.mockClear();
    defined(mock.trays[0]).emit('double-click');
    expect(openSettings).toHaveBeenCalledOnce();
    expect(getContext).not.toHaveBeenCalled();
    tray.dispose();
    expect(mock.destroy).toHaveBeenCalledOnce();
  });
});
