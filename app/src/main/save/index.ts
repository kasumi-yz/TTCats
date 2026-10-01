import * as fs from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { zh } from '../../shared/strings.zh-CN';

// #18 尚未合并：字段与其 SaveEnvelopeSchema 一致，不依赖具体 GameState。
const envelopeSchema = z.strictObject({
  saveVersion: z.int().min(1),
  savedAt: z.number().nonnegative(),
  state: z.unknown(),
});

export interface SaveOptions<T> {
  /** 由主进程传入数据目录，正式应用使用 %APPDATA%\\TTCats。 */
  directory: string;
  currentVersion: number;
  schema: z.ZodType<T>;
  defaultState: () => T;
  /** 键是来源版本，每一步只能升级一个版本。 */
  migrations?: Readonly<Record<number, (state: unknown) => unknown>>;
  now: () => number;
  log: (message: string) => void;
  writeIntervalMs?: number;
}

export interface LoadedSave<T> {
  state: T;
  source: 'main' | 'backup' | 'default';
  file: string | null;
  savedAt: number | null;
  /** 一旦发现新版本存档，本实例永久禁止写入。 */
  readOnly: boolean;
}

type ReadResult<T> =
  | { kind: 'valid'; state: T; savedAt: number }
  | { kind: 'missing' | 'invalid' | 'unreadable' | 'newer' };

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** 每个目录只能有一个主进程实例；同步写入避免退出时尚有写盘任务未完成。 */
export class SaveStore<T> {
  readonly file: string;
  private readonly interval: number;
  private protected = false;
  private pending: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: SaveOptions<T>) {
    this.file = join(options.directory, 'save.json');
    this.interval = options.writeIntervalMs ?? 1000;
    if (
      !Number.isSafeInteger(options.currentVersion) ||
      options.currentVersion < 1 ||
      !Number.isFinite(this.interval) ||
      this.interval < 0
    ) {
      throw new Error(zh.save.invalidOptions);
    }
  }

  get readOnly(): boolean {
    return this.protected;
  }

  /** 主文件优先，临时文件永远不参与恢复。 */
  load(): LoadedSave<T> {
    const main = this.read(this.file);
    if (main.kind === 'valid') return this.loaded(main, this.file, 'main');
    const backup = this.loadLatestBackup();
    if (backup !== null) return backup;
    const state = this.validate(this.options.defaultState(), this.file);
    this.options.log(zh.save.usingDefault);
    return { state, source: 'default', file: null, savedAt: null, readOnly: this.protected };
  }

  /** 安全模式使用上一份正常存档，不把当前主文件当作备份。 */
  loadLatestBackup(): LoadedSave<T> | null {
    for (const file of this.backups()) {
      const result = this.read(file);
      if (result.kind === 'valid') return this.loaded(result, file, 'backup');
    }
    return null;
  }

  /** 捕获状态快照；同一窗口内的多次变化只写最后一次，不推迟原定写入时刻。 */
  requestSave(state: T): void {
    if (this.protected) throw new Error(zh.save.writeProtected);
    try {
      const serialized = JSON.stringify(this.validate(state, this.file));
      // 存档必须能通过 JSON 往返；避免 Date、undefined 等写出后才发现不可读。
      this.validate(JSON.parse(serialized) as unknown, this.file);
      this.pending = serialized;
    } catch (cause) {
      throw new Error(zh.save.writeFailed(this.file), { cause });
    }
    if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        try {
          this.flush();
        } catch (error) {
          // 保留待写快照，退出前 flush 或下一次 requestSave 可以重试。
          this.options.log(error instanceof Error ? error.message : zh.save.writeFailed(this.file));
        }
      }, this.interval);
    }
  }

  /** 退出前调用；返回时写入已完成，失败时抛中文错误并保留待写快照。 */
  flush(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pending === undefined) return;
    if (this.protected) throw new Error(zh.save.writeProtected);
    const savedAt = this.options.now();
    if (!Number.isFinite(savedAt) || savedAt < 0) throw new Error(zh.save.invalidTime);

    try {
      fs.mkdirSync(this.options.directory, { recursive: true });
      // 即使调用方未先 load，也必须检查磁盘上的新版本存档。
      const previous = this.read(this.file);
      if (previous.kind === 'newer') throw new Error(zh.save.writeProtected);
      if (previous.kind === 'unreadable') throw new Error(zh.save.readFailed(this.file));
      // 新版数据也可能只在备份里；不能通过轮换备份逐步删除它。
      for (const file of this.backups()) {
        const backup = this.read(file);
        if (backup.kind === 'newer') throw new Error(zh.save.writeProtected);
        if (backup.kind === 'unreadable') throw new Error(zh.save.readFailed(file));
      }
      const temporary = `${this.file}.tmp`;
      this.writeSynced(
        temporary,
        `{"saveVersion":${this.options.currentVersion},"savedAt":${savedAt},"state":${this.pending}}\n`,
      );
      if (previous.kind === 'valid') this.backupMain();
      this.pruneBackups();
      // 同目录 rename：替换失败时不删除主文件，保留原件和已刷盘的临时文件。
      fs.renameSync(temporary, this.file);
      this.pending = undefined;
    } catch (cause) {
      if (this.readOnly) throw new Error(zh.save.writeProtected, { cause });
      throw new Error(zh.save.writeFailed(this.file), { cause });
    }
    this.options.log(zh.save.written(this.file));
  }

  private validate(state: unknown, file: string): T {
    const result = this.options.schema.safeParse(state);
    if (!result.success) {
      const fields = result.error.issues.map((issue) =>
        issue.path.length === 0 ? zh.save.wholeState : issue.path.map(String).join('.'),
      );
      throw new Error(zh.save.invalidState(file, fields));
    }
    return result.data;
  }

  private read(file: string): ReadResult<T> {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (isMissing(error)) {
        this.options.log(zh.save.fileMissing(file));
        return { kind: 'missing' };
      }
      this.options.log(zh.save.readFailed(file));
      return { kind: 'unreadable' };
    }
    let json: unknown;
    try {
      json = JSON.parse(raw) as unknown;
    } catch {
      this.options.log(zh.save.invalidJson(file));
      return { kind: 'invalid' };
    }
    // 新版可能改变外层格式，先检查版本，不能因旧 schema 不认识字段就覆盖它。
    if (typeof json === 'object' && json !== null && 'saveVersion' in json) {
      const version = json.saveVersion;
      if (typeof version === 'number' && version > this.options.currentVersion) {
        this.protected = true;
        this.options.log(zh.save.newerVersion(file, version, this.options.currentVersion));
        return { kind: 'newer' };
      }
    }
    const envelope = envelopeSchema.safeParse(json);
    if (!envelope.success) {
      this.options.log(zh.save.invalidEnvelope(file));
      return { kind: 'invalid' };
    }
    let state: unknown = envelope.data.state;
    for (
      let version = envelope.data.saveVersion;
      version < this.options.currentVersion;
      version++
    ) {
      const migrate = this.options.migrations?.[version];
      if (migrate === undefined) {
        this.options.log(zh.save.migrationMissing(file, version, version + 1));
        return { kind: 'invalid' };
      }
      try {
        state = migrate(state);
      } catch {
        this.options.log(zh.save.migrationFailed(file, version, version + 1));
        return { kind: 'invalid' };
      }
    }
    try {
      const validated = this.validate(state, file);
      if (envelope.data.saveVersion < this.options.currentVersion) {
        this.options.log(
          zh.save.migrated(file, envelope.data.saveVersion, this.options.currentVersion),
        );
      }
      return { kind: 'valid', state: validated, savedAt: envelope.data.savedAt };
    } catch (error) {
      this.options.log(error instanceof Error ? error.message : zh.save.invalidEnvelope(file));
      return { kind: 'invalid' };
    }
  }

  private loaded(
    result: Extract<ReadResult<T>, { kind: 'valid' }>,
    file: string,
    source: 'main' | 'backup',
  ): LoadedSave<T> {
    this.options.log(source === 'main' ? zh.save.loadedMain(file) : zh.save.loadedBackup(file));
    return { state: result.state, savedAt: result.savedAt, file, source, readOnly: this.protected };
  }

  private backups(): string[] {
    try {
      return fs
        .readdirSync(this.options.directory)
        .filter((name) => /^save\.backup\.[0-9]{16}\.json$/.test(name))
        .sort()
        .reverse()
        .map((name) => join(this.options.directory, name));
    } catch (cause) {
      if (isMissing(cause)) return [];
      throw new Error(zh.save.readFailed(this.options.directory), { cause });
    }
  }

  private writeSynced(file: string, data: string): void {
    const descriptor = fs.openSync(file, 'w');
    try {
      fs.writeFileSync(descriptor, data, 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  }

  private backupMain(): void {
    const latest = this.backups()[0];
    const sequence = latest === undefined ? 1 : Number(latest.slice(-21, -5)) + 1;
    const file = join(
      this.options.directory,
      `save.backup.${String(sequence).padStart(16, '0')}.json`,
    );
    try {
      this.writeSynced(`${file}.tmp`, fs.readFileSync(this.file, 'utf8'));
      fs.renameSync(`${file}.tmp`, file);
    } catch (cause) {
      throw new Error(zh.save.backupFailed(this.file), { cause });
    }
  }

  private pruneBackups(): void {
    try {
      for (const file of this.backups().slice(5)) fs.unlinkSync(file);
    } catch (cause) {
      throw new Error(zh.save.backupFailed(this.file), { cause });
    }
  }
}
