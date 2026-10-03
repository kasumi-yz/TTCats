import { expect, it, vi } from 'vitest';
import { createAppStatus } from './app-status';

it('各模块更新自己的字段并推送递增的整份状态，面板不能改写主进程状态', () => {
  const publish = vi.fn();
  const status = createAppStatus(
    {
      version: '0.2.0',
      update: { state: 'unsupported' },
      hideAllShortcut: { accelerator: 'Ctrl+Alt+H', registered: false },
      displays: [],
      overlayDisplayId: null,
    },
    publish,
  );
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
