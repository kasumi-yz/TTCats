import { describe, expect, it } from 'vitest';
import { FIRST_LUNAR_YEAR, LAST_LUNAR_YEAR, lunarDate, lunarYearTable } from './lunar-calendar';

function on(date: string) {
  const [year = 0, month = 0, day = 0] = date.split('-').map(Number);
  return lunarDate(year, month, day);
}

const DAY_MS = 86_400_000;

describe('农历', () => {
  // 日期都对照过香港天文台的公历与农历日期对照表
  it.each([
    ['2024-02-10', 1, 1],
    ['2025-01-29', 1, 1],
    ['2026-02-17', 1, 1],
    // ICU（Intl 的中国历法）把这两年的春节各算错一天，所以不用它
    ['2027-02-06', 1, 1],
    ['2030-02-03', 1, 1],
    ['2026-03-03', 1, 15],
    ['2027-02-20', 1, 15],
    ['2024-06-10', 5, 5],
    ['2025-05-31', 5, 5],
    ['2026-06-19', 5, 5],
    ['2025-08-29', 7, 7],
    ['2026-08-19', 7, 7],
    ['2024-09-17', 8, 15],
    ['2025-10-06', 8, 15],
    ['2026-09-25', 8, 15],
  ])('%s 是农历 %i 月 %i 日', (date, month, day) => {
    expect(on(date)).toEqual({ month, day, leap: false });
  });

  it('春节前一天是腊月的最后一天，腊月可能只有 29 天', () => {
    expect(on('2027-02-05')).toEqual({ month: 12, day: 29, leap: false });
    expect(on('2030-02-02')).toEqual({ month: 12, day: 30, leap: false });
  });

  it('闰月单独标出来，闰月之后才是下一个月', () => {
    expect(on('2025-07-25')).toEqual({ month: 6, day: 1, leap: true });
    expect(on('2025-08-22')).toEqual({ month: 6, day: 29, leap: true });
    expect(on('2025-08-23')).toEqual({ month: 7, day: 1, leap: false });
    expect(on('2023-03-22')).toEqual({ month: 2, day: 1, leap: true });
    expect(on('2033-12-22')).toEqual({ month: 11, day: 1, leap: true });
  });

  it('闰月和节日同号时，节日在前面那个不闰的月里：2020 年闰四月之后的端午是 6 月 25 日', () => {
    expect(on('2020-05-23')).toEqual({ month: 4, day: 1, leap: true });
    expect(on('2020-06-25')).toEqual({ month: 5, day: 5, leap: false });
    // 2028 年闰五月：闰五月初五不是端午
    expect(on('2028-05-28')).toEqual({ month: 5, day: 5, leap: false });
    expect(on('2028-06-27')).toEqual({ month: 5, day: 5, leap: true });
  });

  it('超出月份表范围时返回 undefined', () => {
    expect(on('2000-02-04')).toBeUndefined();
    expect(on('2000-02-05')).toEqual({ month: 1, day: 1, leap: false });
    expect(on('2100-02-08')).toEqual({ month: 12, day: 30, leap: false });
    expect(on('2100-02-09')).toBeUndefined();
    expect(on('1999-12-31')).toBeUndefined();
  });

  it('月份表首尾相接：每年 12 或 13 个月、每月 29 或 30 天，加起来正好到下一年春节', () => {
    const table = lunarYearTable();
    expect(table).toHaveLength(LAST_LUNAR_YEAR - FIRST_LUNAR_YEAR + 1);
    table.forEach((year, index) => {
      expect([12, 13]).toContain(year.lengths.length);
      for (const length of year.lengths) expect([29, 30]).toContain(length);
      const total = year.lengths.reduce((sum, length) => sum + length, 0);
      expect(total).toBeGreaterThanOrEqual(year.lengths.length === 12 ? 353 : 383);
      expect(total).toBeLessThanOrEqual(year.lengths.length === 12 ? 355 : 385);
      const next = table[index + 1];
      if (next) expect(year.startDay + total).toBe(next.startDay);
      // 春节都在公历 1 月 21 日～2 月 20 日之间
      const start = new Date(year.startDay * DAY_MS);
      expect(start.getUTCFullYear()).toBe(FIRST_LUNAR_YEAR + index);
      const monthDay = (start.getUTCMonth() + 1) * 100 + start.getUTCDate();
      expect(monthDay).toBeGreaterThanOrEqual(121);
      expect(monthDay).toBeLessThanOrEqual(220);
    });
  });

  it('范围内每一天都能换算，日子连续：初一的前一天是 29 或 30', () => {
    const table = lunarYearTable();
    const first = table[0]?.startDay ?? 0;
    let previous = on('2000-02-05');
    for (let day = first + 1; day < first + 365 * 30; day++) {
      const date = new Date(day * DAY_MS);
      const current = lunarDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
      expect(current).toBeDefined();
      if (current && previous) {
        if (current.day === 1) expect([29, 30]).toContain(previous.day);
        else expect(current.day).toBe(previous.day + 1);
      }
      previous = current;
    }
  });
});
