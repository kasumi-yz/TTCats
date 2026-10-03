import { describe, expect, it, vi } from 'vitest';
import { createAutostart, LOGIN_ARGUMENT, LOGIN_ITEM_NAME, startupOptions } from './index';
import { createGameSession } from '../game-session';
import { defaultGameState } from '../../shared/schemas';
import { STARTUP_QUIET_MS } from '../../shared/core-api';
import type { SaveStore } from '../save';
import type { GameState } from '../../shared/schemas';
import { zh } from '../../shared/strings.zh-CN';

function setup(isPackaged = true) {
  const item = {
    name: LOGIN_ITEM_NAME,
    path: 'C:/TTCats/TTCats.exe',
    args: [LOGIN_ARGUMENT],
    scope: 'user' as const,
    enabled: true,
  };
  const current = {
    openAtLogin: false,
    wasOpenedAtLogin: false,
    status: 'not-registered' as const,
    executableWillLaunchAtLogin: false,
    launchItems: [] as (typeof item)[],
  };
  const app = {
    isPackaged,
    setAppUserModelId: vi.fn(),
    getLoginItemSettings: vi.fn(() => current),
    setLoginItemSettings: vi.fn(),
  };
  const log = vi.fn();
  return {
    app,
    log,
    item,
    current,
    autostart: createAutostart({ app, executable: item.path, log }),
  };
}

describe('开机启动', () => {
  it('默认开启时注册安装版路径和开机参数，关闭时移除同名项', () => {
    const { app, current, item, autostart } = setup();
    autostart.sync(true);
    expect(app.setLoginItemSettings).toHaveBeenLastCalledWith({
      name: LOGIN_ITEM_NAME,
      path: item.path,
      args: [LOGIN_ARGUMENT],
      openAtLogin: true,
    });
    current.openAtLogin = true;
    current.launchItems = [item];
    autostart.sync(false);
    expect(app.setLoginItemSettings).toHaveBeenLastCalledWith({
      name: LOGIN_ITEM_NAME,
      path: item.path,
      args: [LOGIN_ARGUMENT],
      openAtLogin: false,
    });
  });

  it('开发模式从不查询或注册系统启动项，只记一次日志', () => {
    const { app, log, autostart } = setup(false);
    autostart.sync(true);
    autostart.sync(true);
    expect(app.getLoginItemSettings).not.toHaveBeenCalled();
    expect(app.setAppUserModelId).not.toHaveBeenCalled();
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledExactlyOnceWith(zh.autostart.development);
  });

  it('Windows 禁用优先于应用偏好，每次启动核对但不能重新启用', () => {
    const { app, log, item, current, autostart } = setup();
    item.enabled = false;
    current.launchItems = [item];
    autostart.sync(true);
    createAutostart({ app, executable: item.path, log }).sync(true);
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(zh.autostart.disabledByWindows);
    autostart.sync(false);
    expect(app.setLoginItemSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ openAtLogin: false }),
    );
  });

  it('启动项已经一致时不写注册表，快照重复发布也不重新查询', () => {
    const { app, current, item, autostart } = setup();
    current.openAtLogin = true;
    current.launchItems = [item];
    autostart.sync(true);
    autostart.sync(true);
    expect(app.getLoginItemSettings).toHaveBeenCalledTimes(1);
    expect(app.setAppUserModelId).toHaveBeenCalledWith(LOGIN_ITEM_NAME);
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
  });

  it('注册失败留下中文原因，下次同步可以重试', () => {
    const { app, log, autostart } = setup();
    app.setLoginItemSettings.mockImplementationOnce(() => {
      throw new Error('denied');
    });
    autostart.sync(true);
    autostart.sync(true);
    expect(log).toHaveBeenCalledWith(zh.autostart.failed('Error: denied'));
    expect(app.setLoginItemSettings).toHaveBeenCalledTimes(2);
  });

  it('开机参数优先于打开设置参数，手动启动仍可打开设置', () => {
    expect(startupOptions([LOGIN_ARGUMENT, '--settings'])).toEqual({
      startupQuiet: true,
      openSettings: false,
    });
    expect(startupOptions(['--settings'])).toEqual({ startupQuiet: false, openSettings: true });
    expect(startupOptions([])).toEqual({ startupQuiet: false, openSettings: false });
  });

  it('主进程传入开机静默，真实时间推进后推送解除静默，临时状态不写存档', () => {
    const state = defaultGameState([]);
    state.settings.quietHoursStart = state.settings.quietHoursEnd;
    const requestSave = vi.fn();
    const save = { requestSave, readOnly: false } as unknown as SaveStore<GameState>;
    const publish = vi.fn();
    let now = 0;
    const session = createGameSession({
      content: { cats: {}, disabled: [], events: {} },
      state,
      save,
      now: () => now,
      publish,
      log: vi.fn(),
      ...startupOptions([LOGIN_ARGUMENT]),
    });
    expect(session.snapshot().silencedBy).toEqual(['startupQuiet']);
    now = STARTUP_QUIET_MS - 1;
    session.tick();
    expect(publish).not.toHaveBeenCalled();
    now++;
    session.tick();
    expect(publish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ silencedBy: [] }));
    expect(requestSave).not.toHaveBeenCalled();
    session.command({ type: 'debug/startupQuiet' });
    expect(session.snapshot().silencedBy).toEqual(['startupQuiet']);
    session.command({ type: 'debug/advanceClock', minutes: 1 });
    expect(session.snapshot().silencedBy).toEqual([]);
  });
});
