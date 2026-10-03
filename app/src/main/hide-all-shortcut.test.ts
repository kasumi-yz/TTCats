import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createHideAllShortcut } from './hide-all-shortcut';

const native = vi.hoisted(() => ({ register: vi.fn(() => true), unregister: vi.fn() }));
vi.mock('electron', () => ({ globalShortcut: native }));
beforeEach(() => {
  vi.clearAllMocks();
  native.register.mockReturnValue(true);
});

describe('一键隐藏快捷键', () => {
  it('改键释放旧键，等价写法不重复注册，回调只切换隐藏，退出释放最新键', () => {
    const toggle = vi.fn();
    const publish = vi.fn();
    const shortcut = createHideAllShortcut({ toggle, publish, report: vi.fn() });
    shortcut.update('Ctrl+Alt+H');
    expect(native.register).toHaveBeenCalledWith('Ctrl+Alt+H', toggle);
    shortcut.update('Control+Alt+H');
    expect(native.register).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenLastCalledWith({ accelerator: 'Control+Alt+H', registered: true });
    shortcut.update('Ctrl+Alt+K');
    expect(native.unregister).toHaveBeenCalledWith('Control+Alt+H');
    shortcut.dispose();
    expect(native.unregister).toHaveBeenLastCalledWith('Ctrl+Alt+K');
  });
  it.each(['false', 'throw'])('注册 %s 时让面板收到失败并写日志，不继续保留旧键', (failure) => {
    const publish = vi.fn();
    const report = vi.fn();
    const shortcut = createHideAllShortcut({ toggle: vi.fn(), publish, report });
    shortcut.update('Ctrl+Alt+H');
    if (failure === 'false') native.register.mockReturnValue(false);
    else
      native.register.mockImplementationOnce(() => {
        throw new Error('失败');
      });
    shortcut.update('Ctrl+Alt+K');
    expect(native.unregister).toHaveBeenCalledWith('Ctrl+Alt+H');
    expect(publish).toHaveBeenLastCalledWith({ accelerator: 'Ctrl+Alt+K', registered: false });
    expect(report).toHaveBeenCalled();
    native.unregister.mockClear();
    shortcut.dispose();
    expect(native.unregister).not.toHaveBeenCalled();
  });
});
