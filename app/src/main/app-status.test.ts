import { describe, expect, it, vi } from 'vitest';
import { createAppStatus } from './app-status';

const display = { id: 1, label: 'DELL', width: 1920, height: 1080, scaleFactor: 1, primary: true };

describe('程序状态', () => {
  it('改了才推送，每推送一次 revision 加 1', () => {
    const publish = vi.fn();
    const status = createAppStatus({ version: '1.2.3', publish });
    expect(status.get()).toMatchObject({ revision: 0, version: '1.2.3', overlayDisplayId: null });
    status.set({ displays: [display], overlayDisplayId: 1 });
    expect(publish).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ revision: 1, displays: [display], overlayDisplayId: 1 }),
    );
    // 显示器事件一来一批，内容一样时不再推
    status.set({ displays: [{ ...display }], overlayDisplayId: 1 });
    expect(publish).toHaveBeenCalledOnce();
    status.set({ overlayDisplayId: 2 });
    expect(publish).toHaveBeenCalledTimes(2);
    expect(status.get()).toMatchObject({ revision: 2, overlayDisplayId: 2 });
  });
});
