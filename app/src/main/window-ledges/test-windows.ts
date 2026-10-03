import type { WindowInfo } from '../platform/types';

/** 单元测试的窗口快照，不调用系统。 */
export function windowInfo(id = 'target', overrides: Partial<WindowInfo> = {}): WindowInfo {
  return {
    id,
    pid: 1,
    className: 'Notepad',
    bounds: { left: 100, top: 200, right: 1000, bottom: 600 },
    buttons: { left: 850, top: 200, right: 1000, bottom: 230 },
    buttonsSource: 'dwm',
    dpiAwareness: 'per-monitor',
    windowDpi: 96,
    visible: true,
    minimized: false,
    maximized: false,
    fullscreen: false,
    cloaked: false,
    occludes: true,
    eligible: true,
    reason: '',
    ...overrides,
  };
}
