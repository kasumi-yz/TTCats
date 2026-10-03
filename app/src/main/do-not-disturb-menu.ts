import { DoNotDisturbDurationSchema } from '../shared/schemas';
import type { StateSnapshot } from '../shared/ipc';
import { zh } from '../shared/strings.zh-CN';
import type { TrayMenuSection } from './tray-menu';

export function createDoNotDisturbMenu(snapshot: () => StateSnapshot): TrayMenuSection {
  return ({ safeMode, command }) => {
    const state = snapshot().doNotDisturb;
    const text = zh.m2Wiring;
    return [
      {
        id: 'doNotDisturb',
        label: text.doNotDisturb,
        submenu: [
          ...DoNotDisturbDurationSchema.options.map((duration) => ({
            id: `doNotDisturb:${duration}`,
            label: text.durations[duration],
            enabled: !safeMode,
            click: () => {
              command({ type: 'doNotDisturb/start', duration });
            },
          })),
          ...(state.mode === 'off'
            ? []
            : [
                { type: 'separator' as const },
                {
                  label:
                    state.mode === 'timed'
                      ? text.until(
                          new Date(state.until).toLocaleTimeString('zh-CN', {
                            hour: '2-digit',
                            minute: '2-digit',
                          }),
                        )
                      : text.untilOff,
                  enabled: false,
                },
                {
                  id: 'doNotDisturb:end',
                  label: text.end,
                  enabled: !safeMode,
                  click: () => {
                    command({ type: 'doNotDisturb/end' });
                  },
                },
              ]),
        ],
      },
    ];
  };
}
