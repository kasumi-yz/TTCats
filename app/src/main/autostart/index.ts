import type { App } from 'electron';
import { zh } from '../../shared/strings.zh-CN';

export const LOGIN_ARGUMENT = '--autostart';
export const LOGIN_ITEM_NAME = 'top.ttcats.desktop';

/** 注册名与 NSIS 卸载脚本保持一致；安装版固定路径，更新后无需更换启动器。 */
export function createAutostart(options: {
  app: Pick<
    App,
    'isPackaged' | 'setAppUserModelId' | 'getLoginItemSettings' | 'setLoginItemSettings'
  >;
  executable: string;
  log: (message: string) => void;
}) {
  let previous: boolean | undefined;
  let disabledLogged = false;
  const { app, executable: path, log } = options;
  return {
    sync(enabled: boolean): void {
      if (previous === enabled) return;
      previous = enabled;
      if (!app.isPackaged) {
        log(zh.autostart.development);
        return;
      }
      try {
        // 与 electron-builder 的 appId 一致；openAtLogin 只查询此默认名称。
        app.setAppUserModelId(LOGIN_ITEM_NAME);
        const args = [LOGIN_ARGUMENT];
        const current = app.getLoginItemSettings({ path, args });
        const item = current.launchItems.find(
          (item) => item.name === LOGIN_ITEM_NAME && item.scope === 'user',
        );
        // Windows 的禁用优先于应用偏好；setLoginItemSettings 默认会重新启用它。
        if (enabled && item && !item.enabled) {
          if (!disabledLogged) log(zh.autostart.disabledByWindows);
          disabledLogged = true;
          return;
        }
        if (enabled ? !current.openAtLogin : item !== undefined)
          app.setLoginItemSettings({ name: LOGIN_ITEM_NAME, path, args, openAtLogin: enabled });
      } catch (error) {
        previous = undefined;
        log(zh.autostart.failed(String(error)));
      }
    },
  };
}

/** 自动启动即使同时带 --settings 也不能弹面板；第二实例同样遵守。 */
export function startupOptions(args: readonly string[]) {
  const startupQuiet = args.includes(LOGIN_ARGUMENT);
  return { startupQuiet, openSettings: !startupQuiet && args.includes('--settings') };
}
