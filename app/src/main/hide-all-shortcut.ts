import { globalShortcut } from 'electron';
import { normalizeAccelerator } from '../shared/accelerator';
import type { AppStatus, StateSnapshot } from '../shared/ipc';
import { zh } from '../shared/strings.zh-CN';
import type { MainFeature } from './features';

export function createHideAllShortcut(options: {
  toggle: () => void;
  publish: (result: AppStatus['hideAllShortcut']) => void;
  report: (error: unknown) => void;
}) {
  let accelerator: string | undefined;
  let registered = false;
  return {
    update(next: string): void {
      if (accelerator === next) return;
      if (
        registered &&
        accelerator !== undefined &&
        normalizeAccelerator(next) === normalizeAccelerator(accelerator)
      ) {
        accelerator = next;
        options.publish({ accelerator: next, registered });
        return;
      }
      if (accelerator !== undefined && registered) globalShortcut.unregister(accelerator);
      accelerator = next;
      registered = false;
      try {
        registered = globalShortcut.register(next, options.toggle);
      } catch (error) {
        options.report(error);
      }
      if (!registered) options.report(zh.m2Wiring.shortcutFailed(next));
      options.publish({ accelerator: next, registered });
    },
    dispose(): void {
      if (accelerator !== undefined && registered) globalShortcut.unregister(accelerator);
    },
  };
}

/** 一键隐藏快捷键的接线：启动时注册设置里的键，设置改键时换键，退出时释放。 */
export function createHideAllShortcutFeature(options: {
  accelerator: () => string;
  toggle: () => void;
  publish: (result: AppStatus['hideAllShortcut']) => void;
  report: (error: unknown) => void;
}) {
  const shortcut = createHideAllShortcut(options);
  return {
    start(): void {
      shortcut.update(options.accelerator());
    },
    onSnapshot(snapshot: StateSnapshot): void {
      shortcut.update(snapshot.settings.hideAllShortcut);
    },
    dispose(): void {
      shortcut.dispose();
    },
  } satisfies MainFeature;
}
