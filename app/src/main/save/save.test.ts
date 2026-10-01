import * as fs from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { zh } from '../../shared/strings.zh-CN';
import { SaveStore, type SaveOptions } from './index';

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
}));

const stateSchema = z.strictObject({ visibleCats: z.array(z.string()) });
type State = z.infer<typeof stateSchema>;
let directory: string;
let now: number;
let logs: string[];
let stores: SaveStore<State>[];

function store(extra: Partial<SaveOptions<State>> = {}): SaveStore<State> {
  const result = new SaveStore({
    directory,
    currentVersion: 1,
    schema: stateSchema,
    defaultState: () => ({ visibleCats: [] }),
    now: () => now,
    log: (message) => logs.push(message),
    ...extra,
  });
  stores.push(result);
  return result;
}

function save(target: SaveStore<State>, cat: string): void {
  target.requestSave({ visibleCats: [cat] });
  target.flush();
}

function write(file: string, state: unknown, version = 1): void {
  fs.writeFileSync(file, JSON.stringify({ saveVersion: version, savedAt: now, state }));
}

function backupFiles(): string[] {
  return fs.readdirSync(directory).filter((name) => /^save\.backup\.[0-9]+\.json$/.test(name));
}

beforeEach(() => {
  // 临时目录在测试文件下面创建；清理目标始终是这个 mkdtemp 返回的绝对路径。
  directory = fs.mkdtempSync(join(import.meta.dirname, 'test-save-'));
  now = 1000;
  logs = [];
  stores = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  // 每个实例都取消计时器；保护/故障测试的待写状态可能仍不能写入。
  for (const target of stores) {
    try {
      target.flush();
    } catch {
      // 测试断言已经验证故障；这里仅释放计时器。
    }
  }
  vi.useRealTimers();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('存档：重启后的状态和崩溃恢复', () => {
  it('首次使用默认状态，写入后新实例按 schema 读回并说明来源', () => {
    const first = store();
    expect(first.load()).toMatchObject({ source: 'default', state: { visibleCats: [] } });
    save(first, 'doudou');
    expect(store().load()).toEqual({
      state: { visibleCats: ['doudou'] },
      source: 'main',
      file: first.file,
      savedAt: 1000,
      readOnly: false,
    });
    expect(logs).toContain(zh.save.usingDefault);
    expect(logs).toContain(zh.save.loadedMain(first.file));
  });

  it('数据目录尚不存在时，首次写入创建目录', () => {
    const target = store({ directory: join(directory, 'TTCats') });
    save(target, 'doudou');
    expect(target.load().state.visibleCats).toEqual(['doudou']);
  });

  it('写到一半只留下临时文件时，重启仍读旧主文件', () => {
    const target = store();
    save(target, 'doudou');
    fs.writeFileSync(`${target.file}.tmp`, '{"saveVersion":');
    expect(store().load().state.visibleCats).toEqual(['doudou']);
    save(target, 'kubo');
    expect(store().load().state.visibleCats).toEqual(['kubo']);
    expect(fs.existsSync(`${target.file}.tmp`)).toBe(false);
  });

  it('孤立临时文件即使完整也不是成功提交的存档', () => {
    const target = store();
    write(`${target.file}.tmp`, { visibleCats: ['doudou'] });
    expect(target.load().source).toBe('default');
  });

  it('只保留最近五份旧存档，排序不受系统时间倒退影响', () => {
    const target = store();
    for (let index = 0; index < 8; index++) {
      now = 8000 - index * 100;
      save(target, `cat-${index}`);
    }
    expect(backupFiles()).toHaveLength(5);
    const cats = backupFiles()
      .sort()
      .map((name) => {
        const raw: unknown = JSON.parse(fs.readFileSync(join(directory, name), 'utf8'));
        return z.object({ state: stateSchema }).parse(raw).state.visibleCats[0];
      });
    expect(cats).toEqual(['cat-2', 'cat-3', 'cat-4', 'cat-5', 'cat-6']);
    expect(target.load().state.visibleCats).toEqual(['cat-7']);
  });

  it.each(['broken-json', 'invalid-state', 'invalid-envelope'])(
    '%s 的主文件回退到正常备份',
    (kind) => {
      const target = store();
      save(target, 'doudou');
      save(target, 'kubo');
      if (kind === 'broken-json') fs.writeFileSync(target.file, '{');
      if (kind === 'invalid-state') write(target.file, { visibleCats: 3 });
      if (kind === 'invalid-envelope') fs.writeFileSync(target.file, '{"state":{}}');
      const loaded = store().load();
      expect(loaded).toMatchObject({ source: 'backup', state: { visibleCats: ['doudou'] } });
      expect(logs).toContain(zh.save.loadedBackup(loaded.file ?? ''));
    },
  );

  it('最新备份坏了就继续找更早的备份，全部损坏才用默认状态', () => {
    const target = store();
    save(target, 'doudou');
    save(target, 'kubo');
    save(target, 'mahjong');
    fs.writeFileSync(target.file, '{');
    const files = backupFiles().sort();
    fs.writeFileSync(join(directory, files[1] ?? ''), '{');
    expect(store().load().state.visibleCats).toEqual(['doudou']);
    fs.writeFileSync(join(directory, files[0] ?? ''), '{');
    expect(store().load()).toMatchObject({ source: 'default', state: { visibleCats: [] } });
  });

  it('恢复后再次保存，不用损坏的主文件污染正常备份', () => {
    const target = store();
    save(target, 'doudou');
    save(target, 'kubo');
    fs.writeFileSync(target.file, '{');
    const recovered = store();
    save(recovered, recovered.load().state.visibleCats[0] ?? '');
    expect(backupFiles()).toHaveLength(1);
    expect(recovered.loadLatestBackup()?.state.visibleCats).toEqual(['doudou']);
  });

  it('安全模式拿到上一份正常存档，不返回当前主存档', () => {
    const target = store();
    expect(target.loadLatestBackup()).toBeNull();
    save(target, 'doudou');
    expect(target.loadLatestBackup()).toBeNull();
    save(target, 'kubo');
    expect(target.loadLatestBackup()).toMatchObject({
      source: 'backup',
      state: { visibleCats: ['doudou'] },
    });
  });
});

describe('存档：迁移和降级保护', () => {
  it('逐版本迁移再校验当前状态，原件在显式保存前不变', () => {
    const target = store({
      currentVersion: 3,
      migrations: {
        1: (state) => ({ cats: [z.object({ cat: z.string() }).parse(state).cat] }),
        2: (state) => ({ visibleCats: z.object({ cats: z.array(z.string()) }).parse(state).cats }),
      },
    });
    write(target.file, { cat: 'doudou' });
    const original = fs.readFileSync(target.file, 'utf8');
    const loaded = target.load();
    expect(loaded.state.visibleCats).toEqual(['doudou']);
    expect(fs.readFileSync(target.file, 'utf8')).toBe(original);
    expect(logs).toContain(zh.save.migrated(target.file, 1, 3));
    save(target, 'doudou');
    expect(JSON.parse(fs.readFileSync(target.file, 'utf8'))).toMatchObject({ saveVersion: 3 });
  });

  it.each(['missing', 'throws', 'invalid-result'])(
    '迁移 %s 时不能误报成功，而是尝试备份',
    (kind) => {
      const target = store({
        currentVersion: 2,
        migrations:
          kind === 'missing'
            ? {}
            : {
                1: () => {
                  if (kind === 'throws') throw new Error('migration failed');
                  return { visibleCats: 4 };
                },
              },
      });
      write(target.file, { old: true });
      write(join(directory, 'save.backup.0000000000000001.json'), { visibleCats: ['doudou'] }, 2);
      expect(target.load()).toMatchObject({ source: 'backup', state: { visibleCats: ['doudou'] } });
      expect(logs).not.toContain(zh.save.migrated(target.file, 1, 2));
    },
  );

  it('新版主存档即使改变外层字段也必须保留，旧备份只能只读恢复', () => {
    const target = store();
    fs.writeFileSync(target.file, '{"saveVersion":2,"newFormat":true}');
    write(join(directory, 'save.backup.0000000000000001.json'), { visibleCats: ['doudou'] });
    const original = fs.readFileSync(target.file, 'utf8');
    expect(target.load()).toMatchObject({ source: 'backup', readOnly: true });
    expect(() => {
      target.requestSave({ visibleCats: [] });
    }).toThrow(zh.save.writeProtected);
    expect(fs.readFileSync(target.file, 'utf8')).toBe(original);
    expect(logs).toContain(zh.save.newerVersion(target.file, 2, 1));
  });

  it('未先读取也不能用旧程序覆盖新版文件', () => {
    const target = store();
    write(target.file, { visibleCats: ['doudou'] }, 2);
    const original = fs.readFileSync(target.file, 'utf8');
    target.requestSave({ visibleCats: [] });
    expect(() => {
      target.flush();
    }).toThrow(zh.save.writeProtected);
    expect(fs.readFileSync(target.file, 'utf8')).toBe(original);
    expect(backupFiles()).toHaveLength(0);
  });

  it('发现新版备份也禁止覆盖，避免旧程序逐步轮换掉新数据', () => {
    const target = store();
    write(join(directory, 'save.backup.0000000000000001.json'), { visibleCats: ['doudou'] }, 2);
    expect(target.load()).toMatchObject({ source: 'default', readOnly: true });
    expect(() => {
      target.requestSave({ visibleCats: [] });
    }).toThrow(zh.save.writeProtected);
  });

  it('旧主存档正常时，保存仍检查备份中的新版本，避免轮换丢失新版数据', () => {
    const target = store();
    write(target.file, { visibleCats: ['doudou'] });
    const backup = join(directory, 'save.backup.0000000000000001.json');
    write(backup, { visibleCats: ['kubo'] }, 2);
    const original = fs.readFileSync(backup, 'utf8');
    target.requestSave({ visibleCats: [] });
    expect(() => {
      target.flush();
    }).toThrow(zh.save.writeProtected);
    expect(fs.readFileSync(backup, 'utf8')).toBe(original);
    expect(fs.readFileSync(target.file, 'utf8')).toContain('doudou');
  });
});

describe('存档：合并写入和安全替换', () => {
  it('频繁变化只写最后一份快照，而且后续修改对象不能偷偷改变待写状态', () => {
    const target = store();
    const state = { visibleCats: ['doudou'] };
    target.requestSave(state);
    vi.advanceTimersByTime(500);
    state.visibleCats = ['kubo'];
    target.requestSave(state);
    state.visibleCats = ['mahjong'];
    expect(fs.existsSync(target.file)).toBe(false);
    now = 2000;
    vi.advanceTimersByTime(500);
    expect(target.load()).toMatchObject({ state: { visibleCats: ['kubo'] }, savedAt: 2000 });
    expect(backupFiles()).toHaveLength(0);
  });

  it('退出前强制写完，取消延迟任务，不重复写入产生备份', () => {
    const target = store();
    target.requestSave({ visibleCats: ['doudou'] });
    target.flush();
    vi.advanceTimersByTime(2000);
    expect(backupFiles()).toHaveLength(0);
    expect(target.load().state.visibleCats).toEqual(['doudou']);
  });

  it('主文件替换前临时文件与备份都已刷盘；替换失败不能先删主文件', () => {
    const target = store();
    save(target, 'doudou');
    const original = fs.readFileSync(target.file, 'utf8');
    const sync = vi.spyOn(fs, 'fsyncSync');
    let syncsAtReplacement = 0;
    const originalRename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (to === target.file) {
        // 意图是先刷盘，再替换；只数最终调用次数无法验证这个顺序。
        syncsAtReplacement = sync.mock.calls.length;
        throw new Error('rename failed');
      }
      originalRename(from, to);
    });
    target.requestSave({ visibleCats: ['kubo'] });
    expect(() => {
      target.flush();
    }).toThrow(zh.save.writeFailed(target.file));
    expect(sync).toHaveBeenCalledTimes(2);
    expect(syncsAtReplacement).toBe(2);
    expect(fs.readFileSync(target.file, 'utf8')).toBe(original);
    expect(fs.existsSync(`${target.file}.tmp`)).toBe(true);
    expect(store().load().state.visibleCats).toEqual(['doudou']);
    vi.restoreAllMocks();
    target.flush();
    expect(target.load().state.visibleCats).toEqual(['kubo']);
  });

  it('刷盘失败时不能替换主文件，待写状态仍可重试', () => {
    const target = store();
    save(target, 'doudou');
    const sync = vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => {
      throw new Error('disk failed');
    });
    target.requestSave({ visibleCats: ['kubo'] });
    expect(() => {
      target.flush();
    }).toThrow(zh.save.writeFailed(target.file));
    expect(target.load().state.visibleCats).toEqual(['doudou']);
    sync.mockRestore();
    target.flush();
    expect(target.load().state.visibleCats).toEqual(['kubo']);
  });

  it('备份写入失败不能替换旧主文件，之后仍能重试待写状态', () => {
    const target = store();
    save(target, 'doudou');
    const originalOpen = fs.openSync;
    const open = vi.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
      if (String(file).includes('save.backup.')) throw new Error('backup failed');
      return originalOpen(file, flags, mode);
    });
    target.requestSave({ visibleCats: ['kubo'] });
    expect(() => {
      target.flush();
    }).toThrow(zh.save.writeFailed(target.file));
    expect(target.load().state.visibleCats).toEqual(['doudou']);
    open.mockRestore();
    target.flush();
    expect(target.loadLatestBackup()?.state.visibleCats).toEqual(['doudou']);
    expect(target.load().state.visibleCats).toEqual(['kubo']);
  });

  it('旧主文件读权限异常时，不能当成损坏文件覆盖', () => {
    const target = store();
    save(target, 'doudou');
    const originalRead = fs.readFileSync;
    const read = vi.spyOn(fs, 'readFileSync').mockImplementation((file, options) => {
      if (file === target.file) throw new Error('permission denied');
      return originalRead(file, options);
    });
    target.requestSave({ visibleCats: ['kubo'] });
    expect(() => {
      target.flush();
    }).toThrow(zh.save.writeFailed(target.file));
    expect(logs).toContain(zh.save.readFailed(target.file));
    read.mockRestore();
    expect(target.load().state.visibleCats).toEqual(['doudou']);
  });

  it('自动写入失败记中文日志，下一次请求能重试而不是丢失状态', () => {
    const target = store();
    const sync = vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => {
      throw new Error('disk failed');
    });
    target.requestSave({ visibleCats: ['doudou'] });
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    expect(logs).toContain(zh.save.writeFailed(target.file));
    sync.mockRestore();
    target.requestSave({ visibleCats: ['kubo'] });
    vi.advanceTimersByTime(1000);
    expect(target.load().state.visibleCats).toEqual(['kubo']);
  });

  it('不合 schema 的数据、不能往返的 JSON、非法保存时间都不能替换好存档', () => {
    const target = store();
    save(target, 'doudou');
    expect(() => {
      target.requestSave({ visibleCats: [3] } as unknown as State);
    }).toThrow();
    target.requestSave({ visibleCats: ['kubo'] });
    now = Number.NaN;
    expect(() => {
      target.flush();
    }).toThrow(zh.save.invalidTime);
    expect(target.load().state.visibleCats).toEqual(['doudou']);
    const dates = new SaveStore({
      directory,
      currentVersion: 1,
      schema: z.date(),
      defaultState: () => new Date(0),
      now: () => 1000,
      log: (message) => logs.push(message),
    });
    expect(() => {
      dates.requestSave(new Date(0));
    }).toThrow(zh.save.writeFailed(dates.file));
  });
});
