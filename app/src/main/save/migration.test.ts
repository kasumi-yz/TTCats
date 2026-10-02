// 正式存档的迁移（#52）：SaveStore 加上 shared 里的 SAVE_MIGRATIONS，能读 M1 写出的版本 1 存档。
import * as fs from 'node:fs';
// eslint-disable-next-line no-restricted-imports -- 系统临时目录仅用于测试，不是应用的平台实现。
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CURRENT_SAVE_VERSION,
  defaultGameState,
  defaultSettings,
  GameStateSchema,
  SAVE_MIGRATIONS,
  type GameState,
} from '../../shared/schemas';
import { zh } from '../../shared/strings.zh-CN';
import { SaveStore } from './index';

let directory: string;
let logs: string[];
let stores: SaveStore<GameState>[];

function store(): SaveStore<GameState> {
  const result = new SaveStore({
    directory,
    currentVersion: CURRENT_SAVE_VERSION,
    schema: GameStateSchema,
    defaultState: () => defaultGameState([]),
    migrations: SAVE_MIGRATIONS,
    now: () => 2000,
    log: (message) => logs.push(message),
    writeIntervalMs: 0,
  });
  stores.push(result);
  return result;
}

const v1Settings = {
  visibleCats: ['doudou'],
  activityLevel: 'lazy',
  scale: 1.2,
  floorDepth: 0.4,
  showInScreenCapture: true,
};

beforeEach(() => {
  directory = fs.mkdtempSync(join(tmpdir(), 'ttcats-test-migration-'));
  logs = [];
  stores = [];
});

afterEach(() => {
  for (const target of stores) {
    try {
      target.flush();
    } catch {
      // 测试结束时的待写状态不重要
    }
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('M1 存档升级到当前版本', () => {
  it('读到版本 1 的主存档：迁移后用上，原文件不动，下次写入是当前版本并备份原文件', () => {
    const file = join(directory, 'save.json');
    const original = JSON.stringify({
      saveVersion: 1,
      savedAt: 1000,
      state: { settings: v1Settings },
    });
    fs.writeFileSync(file, original);
    const save = store();
    const loaded = save.load();
    expect(loaded.source).toBe('main');
    expect(loaded.state).toEqual({
      settings: { ...defaultSettings(['doudou']), ...v1Settings },
      doNotDisturb: { mode: 'off' },
    });
    expect(logs).toContain(zh.save.migrated(file, 1, CURRENT_SAVE_VERSION));
    expect(fs.readFileSync(file, 'utf8')).toBe(original);

    save.requestSave(loaded.state);
    save.flush();
    const written = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      saveVersion: number;
      state: unknown;
    };
    expect(written.saveVersion).toBe(CURRENT_SAVE_VERSION);
    expect(GameStateSchema.parse(written.state)).toEqual(loaded.state);
    const backups = fs.readdirSync(directory).filter((name) => name.startsWith('save.backup.'));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(join(directory, backups[0] ?? ''), 'utf8')).toBe(original);
  });

  it('版本 1 的状态格式不对时迁移失败，改读备份', () => {
    fs.writeFileSync(
      join(directory, 'save.json'),
      JSON.stringify({ saveVersion: 1, savedAt: 1000, state: { settings: null } }),
    );
    fs.writeFileSync(
      join(directory, 'save.backup.0000000000000001.json'),
      JSON.stringify({ saveVersion: 1, savedAt: 900, state: { settings: v1Settings } }),
    );
    const loaded = store().load();
    expect(loaded.source).toBe('backup');
    expect(loaded.state.settings.scale).toBe(1.2);
    expect(logs).toContain(zh.save.migrationFailed(join(directory, 'save.json'), 1, 2));
  });
});
