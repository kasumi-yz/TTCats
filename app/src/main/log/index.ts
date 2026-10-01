import * as fs from 'node:fs';
import { join } from 'node:path';
import { app, type WebContents } from 'electron';
import { zh } from '../../shared/strings.zh-CN';

export interface LogOptions {
  /** 正式应用传入 join(app.getPath('userData'), 'logs')。 */
  directory: string;
  now?: () => number;
  maxBytes?: number;
  backups?: number;
}

/** 同步写入，崩溃前的最后一条错误也能留下；文件总量有固定上限。 */
export class FileLog {
  readonly directory: string;
  readonly file: string;
  private readonly maxBytes: number;
  private readonly backups: number;
  private readonly now: () => number;

  constructor(options: LogOptions) {
    this.directory = options.directory;
    this.file = join(this.directory, 'main.log');
    this.maxBytes = options.maxBytes ?? 1024 * 1024;
    this.backups = options.backups ?? 5;
    this.now = options.now ?? Date.now;
    if (
      !Number.isSafeInteger(this.maxBytes) ||
      this.maxBytes < 256 ||
      !Number.isSafeInteger(this.backups) ||
      this.backups < 0 ||
      this.backups > 20
    )
      throw new Error(zh.recovery.invalidLogOptions);
    fs.mkdirSync(this.directory, { recursive: true });
  }

  write(message: string): void {
    try {
      // JSON 编码避免换行伪造日志；限制单条长度，超长错误不能撑爆轮转上限。
      const prefix = `${this.now()} `;
      let body = JSON.stringify(message.slice(0, 16000));
      while (Buffer.byteLength(prefix + body + '\n', 'utf8') > this.maxBytes) {
        body = JSON.stringify(message.slice(0, Math.floor(body.length / 4)));
      }
      const line = prefix + body + '\n';
      const existing = fs.existsSync(this.file) ? fs.statSync(this.file) : undefined;
      if (existing !== undefined && !existing.isFile()) {
        throw new Error(zh.recovery.logWriteFailed(this.file));
      }
      const size = existing?.size ?? 0;
      if (size + Buffer.byteLength(line) > this.maxBytes) this.rotate();
      fs.appendFileSync(this.file, line, 'utf8');
    } catch (cause) {
      throw new Error(zh.recovery.logWriteFailed(this.file), { cause });
    }
  }

  /** 事件回调的日志失败不能阻止崩溃恢复；明确输出到主进程标准错误。 */
  report(message: string): void {
    try {
      this.write(message);
    } catch (error) {
      console.error(error);
    }
  }

  private rotate(): void {
    for (let index = this.backups; index >= 1; index--) {
      const target = `${this.file}.${index}`;
      const source = index === 1 ? this.file : `${this.file}.${index - 1}`;
      if (fs.existsSync(target)) fs.unlinkSync(target);
      if (fs.existsSync(source)) fs.renameSync(source, target);
    }
    if (this.backups === 0 && fs.existsSync(this.file)) fs.unlinkSync(this.file);
  }
}

/** 与 D13 的存档根目录一致，不受开发入口的应用名称影响。 */
export function createApplicationLog(): FileLog {
  return new FileLog({ directory: join(app.getPath('appData'), zh.app.name, 'logs') });
}

/** Electron 会把页面的未捕获异常、未处理 rejection 和 console.error 转成 console-message。 */
export function attachRendererLog(contents: WebContents, name: string, log: FileLog): () => void {
  const onConsole = (
    details: Electron.Event<Electron.WebContentsConsoleMessageEventParams>,
  ): void => {
    if (details.level === 'error' || details.level === 'warning') {
      log.report(`${name}: ${details.message} (${details.sourceId}:${details.lineNumber})`);
    }
  };
  const onGone = (_event: Electron.Event, details: Electron.RenderProcessGoneDetails): void => {
    log.report(`${name}: ${details.reason} (${details.exitCode})`);
  };
  contents.on('console-message', onConsole);
  contents.on('render-process-gone', onGone);
  return () => {
    contents.removeListener('console-message', onConsole);
    contents.removeListener('render-process-gone', onGone);
  };
}

/** 只记录主进程致命异常，不安装重启器，也不吞掉默认的退出行为。 */
export function attachMainLog(log: FileLog): () => void {
  const onError = (error: Error): void => {
    log.report(error.stack ?? error.message);
  };
  process.on('uncaughtExceptionMonitor', onError);
  // Electron 默认会把未处理的 rejection 报为 warning；记录但不改变 Node 的处理策略。
  process.on('warning', onError);
  return () => {
    process.removeListener('uncaughtExceptionMonitor', onError);
    process.removeListener('warning', onError);
  };
}
