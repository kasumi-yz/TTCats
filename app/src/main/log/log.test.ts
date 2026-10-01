import * as fs from 'node:fs';
import { EventEmitter } from 'node:events';
// eslint-disable-next-line no-restricted-imports -- 临时目录仅用于测试。
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileLog, attachMainLog } from './index';

vi.mock('electron', () => ({}));
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true });
});

function logger(backups = 2): FileLog {
  const directory = fs.mkdtempSync(join(tmpdir(), 'ttcats-log-test-'));
  directories.push(directory);
  return new FileLog({ directory, maxBytes: 256, backups, now: () => 1000 });
}

describe('日志为排查故障留下有限大小的记录', () => {
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
