import { describe, expect, it, vi } from 'vitest';
import { createAppStatus } from './app-status';

const display = { id: 1, label: 'DELL', width: 1920, height: 1080, scaleFactor: 1, primary: true };
const initial = {
  version: '0.2.0',
  update: { state: 'unsupported' as const },
  hideAllShortcut: { accelerator: 'Ctrl+Alt+H', registered: false },
  displays: [],
  overlayDisplayId: null,
};

describe('程序状态', () => {
  it('各模块更新自己的字段并推送递增的整份状态，面板不能改写主进程状态', () => {
    const publish = vi.fn();
    const status = createAppStatus(initial, publish);
    status.update({ hideAllShortcut: { accelerator: 'Ctrl+Alt+H', registered: true } });
    status.update({ update: { state: 'checking' } });
    status.update({ overlayDisplayId: 42 });
    expect(publish.mock.lastCall?.[0]).toMatchObject({
      revision: 3,
      version: '0.2.0',
      update: { state: 'checking' },
      hideAllShortcut: { registered: true },
      overlayDisplayId: 42,
    });
    status.current().hideAllShortcut.registered = false;
    expect(status.current().hideAllShortcut.registered).toBe(true);
  });

  it('改了才推送，内容一样时不再推', () => {
    const publish = vi.fn();
    const status = createAppStatus(initial, publish);
    expect(status.current()).toMatchObject({ revision: 0, overlayDisplayId: null });
    status.update({ displays: [display], overlayDisplayId: 1 });
    expect(publish).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ revision: 1, displays: [display], overlayDisplayId: 1 }),
    );
    // 显示器事件一来一批，内容一样时不再推
    status.update({ displays: [{ ...display }], overlayDisplayId: 1 });
    expect(publish).toHaveBeenCalledOnce();
    status.update({ overlayDisplayId: 2 });
    expect(publish).toHaveBeenCalledTimes(2);
    expect(status.current()).toMatchObject({ revision: 2, overlayDisplayId: 2 });
  });
});
