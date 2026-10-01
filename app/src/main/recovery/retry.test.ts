import { describe, expect, it } from 'vitest';
import { recordFailure, RETRY_WINDOW_MS, type RetryState } from './retry';

const initial: RetryState = { failures: [], safeMode: false };

describe('桌面层重试额度保护用户免受连续故障影响', () => {
  it('5 分钟内只允许三次自动重载，第四次锁定安全模式', () => {
    let state = initial;
    for (const now of [1000, 2000, 3000]) {
      state = recordFailure(state, now);
      expect(state.safeMode).toBe(false);
    }
    state = recordFailure(state, 4000);
    expect(state.safeMode).toBe(true);
    expect(recordFailure(state, 1000000)).toBe(state);
    expect(initial.failures).toEqual([]);
  });

  it('按滚动窗口释放过期额度，不因一次旧故障惩罚稳定运行', () => {
    const state = [1000, 2000, 3000].reduce(recordFailure, initial);
    const next = recordFailure(state, 1000 + RETRY_WINDOW_MS);
    expect(next.failures).toEqual([2000, 3000, 301000]);
    expect(next.safeMode).toBe(false);
    expect(recordFailure(state, 3001 + RETRY_WINDOW_MS).failures).toEqual([303001]);
  });

  it('睡眠或时间前跳后按真实经过时间重新计算', () => {
    const state = [1000, 2000, 3000].reduce(recordFailure, initial);
    expect(recordFailure(state, 24 * 60 * 60 * 1000)).toEqual({
      failures: [86400000],
      safeMode: false,
    });
  });

  it('时钟回拨不能让重复崩溃绕过重试上限', () => {
    const state = [1000000, 1001000, 1002000].reduce(recordFailure, initial);
    expect(recordFailure(state, 10).safeMode).toBe(true);
  });

  it.each([NaN, Infinity, -1])('拒绝无效时间 %s，不悄悄清空额度', (now) => {
    expect(() => recordFailure(initial, now)).toThrow();
  });
});
