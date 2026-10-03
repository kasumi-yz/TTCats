import type { MenuItemConstructorOptions } from 'electron';
import { expect, it, vi } from 'vitest';
import { catalog, snapshot } from '../core/stage/test-fixtures';
import { createDoNotDisturbMenu } from './do-not-disturb-menu';
import { zh } from '../shared/strings.zh-CN';

it('勿扰段按定稿时长发命令，显示真实结束时刻，刷新 off 后移除结束项，安全模式禁用', () => {
  let state = snapshot([]);
  const command = vi.fn();
  const section = createDoNotDisturbMenu(() => state);
  const context = {
    content: catalog([]),
    settings: state.settings,
    safeMode: false,
    command,
    summon: vi.fn(),
    openPanel: vi.fn(),
    quit: vi.fn(),
  };
  const items = () => section(context)[0]?.submenu as MenuItemConstructorOptions[];
  const click = (id: string) => {
    const item = items().find((item) => item.id === id);
    item?.click?.({} as Electron.MenuItem, undefined, {});
  };
  expect(items().map((item) => item.id)).toEqual([
    'doNotDisturb:30m',
    'doNotDisturb:1h',
    'doNotDisturb:2h',
    'doNotDisturb:untilOff',
  ]);
  click('doNotDisturb:30m');
  expect(command).toHaveBeenLastCalledWith({ type: 'doNotDisturb/start', duration: '30m' });
  const until = new Date(2026, 9, 3, 14, 30).getTime();
  state = { ...state, clockOffsetMs: 3600000, doNotDisturb: { mode: 'timed', until } };
  expect(items().some((item) => item.label === zh.m2Wiring.until('14:30'))).toBe(true);
  click('doNotDisturb:end');
  expect(command).toHaveBeenLastCalledWith({ type: 'doNotDisturb/end' });
  context.safeMode = true;
  expect(
    items()
      .filter((item) => item.id)
      .every((item) => item.enabled === false),
  ).toBe(true);
  state = { ...state, doNotDisturb: { mode: 'off' } };
  expect(items().find((item) => item.id === 'doNotDisturb:end')).toBeUndefined();
});
