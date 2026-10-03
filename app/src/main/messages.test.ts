import { describe, expect, it } from 'vitest';
import { isMainCommand, MAIN_COMMAND_TYPES, type Fact, type ToMainCommand } from '../shared/ipc';
import { CommandSchema, FactSchema } from './messages';

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

describe('M3、M4 的命令和事实（#106）', () => {
  it.each([
    { type: 'debug/triggerEvent', event: 'parkour' },
    { type: 'debug/triggerEvent', event: 'parkour', cats: ['doudou'] },
    { type: 'debug/resetCooldowns' },
    { type: 'debug/userState', signal: { type: 'idle', idleMs: 600_000 } },
    { type: 'debug/userState', signal: { type: 'resumed' } },
    { type: 'debug/effect', cat: 'doudou', effect: 'bug' },
    { type: 'debug/ledgeLines', visible: true },
  ] satisfies ToMainCommand[])('接受 %j', (command) => {
    expect(CommandSchema.parse(command)).toEqual(command);
  });

  it.each([
    { type: 'debug/userState', signal: { type: 'idle' } },
    { type: 'debug/userState', signal: { type: 'idle', idleMs: -1 } },
    { type: 'debug/effect', cat: 'doudou', effect: 'cut' },
    { type: 'debug/triggerEvent', event: 'Bad Id' },
  ])('拒绝 %j', (command) => {
    expect(CommandSchema.safeParse(command).success).toBe(false);
  });

  it.each([
    { type: 'stage/created', at: 1 },
    { type: 'event/started', at: 1, run: 3, event: 'user-away', cats: ['doudou'] },
    {
      type: 'event/ended',
      at: 1,
      run: 3,
      event: 'user-away',
      cat: 'doudou',
      outcome: 'interrupted',
    },
  ] satisfies Fact[])('事实 %j 能通过校验', (fact) => {
    expect(FactSchema.parse(fact)).toEqual(fact);
  });

  it('不认识的结束原因会被拒绝', () => {
    expect(
      FactSchema.safeParse({
        type: 'event/ended',
        at: 1,
        run: 3,
        event: 'user-away',
        cat: 'doudou',
        outcome: 'timeout',
      }).success,
    ).toBe(false);
  });
});
