import { screen, type BrowserWindow } from 'electron';
import type { GameCommand, StageCommand } from '../shared/ipc';
import { IPC_CHANNELS } from '../shared/ipc';
import type { createGameSession } from './game-session';

export function createGameCommands(options: {
  session: ReturnType<typeof createGameSession>;
  stopping: () => boolean;
  overlayWindow: () => BrowserWindow | undefined;
  overlaySend: (channel: string, payload: StageCommand) => void;
  updateTray: () => void;
  report: (error: unknown) => void;
}) {
  const { session, updateTray } = options;
  const command = (message: GameCommand): void => {
    if (options.stopping()) {
      updateTray();
      return;
    }
    try {
      const result = session.command(message);
      for (const stage of result.stageCommands)
        options.overlaySend(IPC_CHANNELS.stageCommand, stage);
    } catch (error) {
      options.report(error);
    } finally {
      updateTray();
    }
  };
  const summon = (cat: string): void => {
    const window = options.overlayWindow();
    if (session.safeMode || !window) return;
    const cursor = screen.getCursorScreenPoint();
    const bounds = window.getBounds();
    command({
      type: 'cat/summon',
      cat,
      to: { x: cursor.x - bounds.x, y: cursor.y - bounds.y },
    });
  };
  return { command, summon };
}
