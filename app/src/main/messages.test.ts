import { describe, expect, it } from 'vitest';
import { isMainCommand, MAIN_COMMAND_TYPES, type ToMainCommand } from '../shared/ipc';
import { CommandSchema } from './messages';

describe('闲置模拟命令接口', () => {
  it('模拟的是系统闲置，归主进程处理，不进入游戏规则或存档', () => {
    const command = { type: 'debug/simulateIdle' } satisfies ToMainCommand;
    expect(CommandSchema.parse(command)).toEqual(command);
    expect(isMainCommand(command)).toBe(true);
    expect(MAIN_COMMAND_TYPES).toContain(command.type);
  });

  it.each(['force', 'active', 'minutes'])('不接受 %s 字段，避免扩展成强制安装命令', (field) => {
    expect(CommandSchema.safeParse({ type: 'debug/simulateIdle', [field]: true }).success).toBe(
      false,
    );
  });
});
