import { app, dialog } from 'electron';
import { zh } from '../shared/strings.zh-CN';

export function attachShutdown(options: {
  flush: () => void;
  report: (error: unknown) => void;
  steps: readonly (() => void)[];
  disposeOverlay: () => Promise<void>;
  detachMainLog: () => void;
}) {
  const text = zh.integration;
  let closing = false;
  let quitting = false;
  const finishQuit = async (): Promise<void> => {
    for (;;) {
      try {
        options.flush();
        break;
      } catch (error) {
        options.report(error);
        const { response } = await dialog.showMessageBox({
          type: 'error',
          message: text.saveFailed,
          buttons: [text.retrySave, text.quitWithoutSaving],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        if (response === 1) {
          options.report(text.saveAbandoned);
          break;
        }
      }
    }
    closing = true;
    for (const step of options.steps) step();
    await options.disposeOverlay().finally(() => {
      options.detachMainLog();
      app.quit();
    });
  };
  app.on('before-quit', (event) => {
    if (closing) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void finishQuit().catch((error: unknown) => {
      quitting = false;
      options.report(error);
    });
  });
  return {
    get closing() {
      return closing;
    },
    get quitting() {
      return quitting;
    },
  };
}
