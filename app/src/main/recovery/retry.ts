import { zh } from '../../shared/strings.zh-CN';

export const RETRY_WINDOW_MS = 5 * 60 * 1000;

export interface RetryState {
  failures: readonly number[];
  safeMode: boolean;
}

/** 回拨时不清空额度：平移时间戳，保留已经发生的故障之间的间隔。 */
export function recordFailure(state: RetryState, now: number): RetryState {
  if (!Number.isFinite(now) || now < 0) throw new RangeError(zh.recovery.invalidTime);
  if (state.safeMode) return state;
  const last = state.failures.at(-1);
  const shift = last !== undefined && now < last ? now - last : 0;
  const failures = state.failures
    .map((time) => time + shift)
    .filter((time) => now - time < RETRY_WINDOW_MS);
  failures.push(now);
  return { failures, safeMode: failures.length > 3 };
}
