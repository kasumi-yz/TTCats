import * as fs from 'node:fs';
import { EventEmitter } from 'node:events';
// eslint-disable-next-line no-restricted-imports -- 临时目录仅用于测试。
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { FileLog, attachMainLog, attachRendererLog } from './index';

vi.mock('electron', () => ({}));
const directories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true });
});

function logger(backups = 2): FileLog {
  const directory = fs.mkdtempSync(join(tmpdir(), 'ttcats-log-test-'));
  directories.push(directory);
  return new FileLog({ directory, maxBytes: 256, backups, now: () => 1000 });
}

describe('日志为排查故障留下有限大小的记录', () => {
  it('页面错误刷屏时每秒最多写十条，省略数量和崩溃记录仍会留下', async () => {
    vi.useFakeTimers();
    const log = logger();
    const report = vi.spyOn(log, 'report').mockImplementation(() => {});
    const contents = new EventEmitter();
    const detach = attachRendererLog(contents as unknown as WebContents, 'overlay', log);
    try {
      for (let index = 0; index < 60; index++)
        contents.emit('console-message', {
          level: 'error',
          message: `fault-${index}`,
          sourceId: 'test',
          lineNumber: 1,
        });
      expect(report).toHaveBeenCalledTimes(10);
      await vi.advanceTimersByTimeAsync(1000);
      expect(report).toHaveBeenCalledWith(expect.stringContaining('已省略 50 条'));
      for (let index = 0; index < 30; index++)
        contents.emit('console-message', {
          level: 'warning',
          message: 'repeated',
          sourceId: 'test',
          lineNumber: 1,
        });
      contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
      expect(report).toHaveBeenCalledWith('overlay: crashed (1)');
      expect(report).toHaveBeenCalledWith(expect.stringContaining('已省略 20 条'));
    } finally {
      detach();
      report.mockRestore();
    }
  });
  it('大量中文错误和超长单条日志也不会无限增长，保留最新记录', () => {
    const log = logger();
    for (let index = 0; index < 30; index++) log.write(`故障${index}：${'猫'.repeat(10000)}`);
    expect(fs.readdirSync(log.directory).sort()).toEqual(['main.log', 'main.log.1', 'main.log.2']);
    for (const file of fs.readdirSync(log.directory)) {
      const content = fs.readFileSync(join(log.directory, file), 'utf8');
      expect(Buffer.byteLength(content)).toBeLessThanOrEqual(256);
      expect(content).not.toContain('\uFFFD');
    }
    expect(fs.readFileSync(log.file, 'utf8')).toContain('故障29');
    expect(fs.readFileSync(`${log.file}.1`, 'utf8')).toContain('故障27');
  });

  it('错误里的换行不能伪造另一条日志', () => {
    const log = logger(0);
    log.write('first\nsecond');
    expect(fs.readFileSync(log.file, 'utf8').trim().split('\n')).toHaveLength(1);
    for (let index = 0; index < 10; index++) log.write('x'.repeat(200));
    expect(fs.readdirSync(log.directory)).toEqual(['main.log']);
  });

  it('写入失败明确报错，不能报告日志已保存', () => {
    const log = logger();
    fs.mkdirSync(log.file);
    expect(() => {
      log.write('error');
    }).toThrow('无法写入日志');
  });

  it('主进程异常监听不吞掉默认退出行为，解除后不继续监听', () => {
    const log = logger();
    const before = process.listenerCount('uncaughtException');
    const detach = attachMainLog(log);
    try {
      EventEmitter.prototype.emit.call(
        process,
        'uncaughtExceptionMonitor',
        new Error('main-fault'),
        'uncaughtException',
      );
      expect(fs.readFileSync(log.file, 'utf8')).toContain('main-fault');
      EventEmitter.prototype.emit.call(process, 'warning', new Error('main-warning'));
      expect(fs.readFileSync(log.file, 'utf8')).toContain('main-warning');
      expect(process.listenerCount('uncaughtException')).toBe(before);
    } finally {
      detach();
    }
  });
});
