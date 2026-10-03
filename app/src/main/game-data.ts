import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { app } from 'electron';
import {
  CURRENT_SAVE_VERSION,
  defaultGameState,
  GameStateSchema,
  SAVE_MIGRATIONS,
} from '../shared/schemas';
import { contentDirectory, loadContent } from './content';
import { SaveStore } from './save';

/** 隔离自动测试数据，正式安装包不接受此开发选项。必须在 app ready 之前调用。 */
export function isolateTestAppData(): void {
  if (!app.isPackaged && process.env['TTCATS_TEST_APP_DATA']) {
    const directory = resolve(process.env['TTCATS_TEST_APP_DATA']);
    mkdirSync(directory, { recursive: true });
    app.setPath('appData', directory);
    app.setPath('userData', join(directory, 'TTCats'));
  }
}

/** 读存档和内容目录；没有存档时，按已加载的猫生成初始状态。 */
export function loadGameData(report: (error: unknown) => void) {
  const save = new SaveStore({
    directory: join(app.getPath('appData'), 'TTCats'),
    currentVersion: CURRENT_SAVE_VERSION,
    schema: GameStateSchema,
    defaultState: () => defaultGameState([]),
    migrations: SAVE_MIGRATIONS,
    now: Date.now,
    log: report,
  });
  const loaded = save.load();
  const directory =
    !app.isPackaged && process.argv.includes('--test-content')
      ? join(app.getAppPath(), 'test-content')
      : contentDirectory({
          isPackaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          appPath: app.getAppPath(),
        });
  const content = loadContent(directory, report);
  const initialState =
    loaded.source === 'default' ? defaultGameState(Object.keys(content.cats)) : loaded.state;
  return { save, directory, content, initialState };
}
