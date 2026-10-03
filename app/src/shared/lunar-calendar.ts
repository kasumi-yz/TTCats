// 农历（M3，#106）：把公历日期换算成农历的月和日，给农历节日的触发条件（event.ts 的 lunarHoliday）用。
//
// 为什么不用 Intl.DateTimeFormat 的中国历法（zh-u-ca-chinese）：它靠天文公式现算，新月正好落在半夜前后时会差一天。
// 2026-10 用 Node 24.15（ICU 78.2）逐日对照香港天文台的历表，农历 2000～2099 年里有 6 个月不一样，
// 其中 2027 年春节（天文台：2 月 6 日，ICU：2 月 7 日）和 2030 年春节（天文台：2 月 3 日，ICU：2 月 2 日）都错了一天。
// 所以改用下面这张从天文台历表整理出来的月份表，Node 和 Electron 算出来都一样，也不受 ICU 版本影响。
//
// 数据来源：香港天文台《公历与农历日期对照表》文字版（https://www.hko.gov.hk/en/gts/time/calendar/text/files/T<年>e.txt），
// 2026-10-03 下载 1999～2100 年，逐日检查农历日期连续后整理。天文台 2069 年的文件漏了 12 月 30 日这一行，前后日期能对上，不影响月份表。

/**
 * 农历 2000～2099 年，每年一项，写成 "MMDD 闰月 大小月"：
 * - MMDD：这一年正月初一是公历（同一年）的几月几日；
 * - 闰月：闰几月，0 表示这一年没有闰月；
 * - 大小月：每个月是大月（1，30 天）还是小月（0，29 天），按顺序写，闰月紧跟在同号的月份后面，所以有闰月的年份是 13 位。
 * 每一年的天数加起来必须正好接上下一年的正月初一，单元测试会检查。
 */
// prettier-ignore
const LUNAR_YEARS = [
  '0205 0 110010010110', '0124 4 1101010010101', '0212 0 110101001010', '0201 0 110110100101',
  '0122 2 0101101010101', '0209 0 010101101010', '0129 7 1010101011011', '0218 0 001001011101',
  '0207 0 100100101101', '0126 5 1100100101011', '0214 0 101010010101', '0203 0 101101001010',
  '0123 4 1011010101010', '0210 0 101011010101', '0131 9 0101010110101', '0219 0 010010111010',
  '0208 0 101001011011', '0128 6 0101001010111', '0216 0 010100101011', '0205 0 101010010011',
  '0125 4 0111010010101', '0212 0 011010101010', '0201 0 101011010101', '0122 2 0100110110101',
  '0210 0 010010110110', '0129 6 1010010101110', '0217 0 101001001110', '0206 0 110100100110',
  '0126 5 1110100100110', '0213 0 110101010011', '0203 0 010110101010', '0123 3 0110101101010',
  '0211 0 100101101101', '0131 11 0100101011101', '0219 0 010010101101', '0208 0 101001001101',
  '0128 6 1101001001011', '0215 0 110100100101', '0204 0 110101010010', '0124 5 1101101010100',
  '0212 0 101101011010', '0201 0 010101101101', '0122 2 0100101011011', '0210 0 010010011011',
  '0130 7 1010010010111', '0217 0 101001001011', '0206 0 101010100101', '0126 5 1011010100101',
  '0214 0 011011010010', '0202 0 101011011010', '0123 3 0101010110110', '0211 0 100100110111',
  '0201 8 0100100101111', '0219 0 010010010111', '0208 0 011001001011', '0128 6 0110101001010',
  '0215 0 111010100101', '0204 0 011010101010', '0124 4 1010101101100', '0212 0 101010101110',
  '0202 0 100100101110', '0121 3 1100100101110', '0209 0 110010010110', '0129 7 1101010010101',
  '0217 0 110101001010', '0205 0 110110100101', '0126 5 0101101010101', '0214 0 010101101010',
  '0203 0 101001101101', '0123 4 0101001011101', '0211 0 010100101101', '0131 8 1010100101011',
  '0219 0 101010010101', '0207 0 101101001010', '0127 6 1011010101010', '0215 0 101011010101',
  '0205 0 010101011010', '0124 4 1010010111010', '0212 0 101001011011', '0202 0 010100101011',
  '0122 3 1010100100111', '0209 0 011010010011', '0129 7 0111001010011', '0217 0 011010101010',
  '0206 0 101011010101', '0126 5 0100110110101', '0214 0 010010110110', '0203 0 101001010111',
  '0124 4 0101001001110', '0210 0 110100010110', '0130 8 1110100100110', '0218 0 110101010010',
  '0207 0 110110101010', '0127 6 0110101101010', '0215 0 010101101101', '0205 0 010010101110',
  '0125 4 1010010011101', '0212 0 101000101101', '0201 0 110100010101', '0121 2 1101100100101',
];

/** 月份表的第一年（农历年，正月初一在这一年的公历里）。 */
export const FIRST_LUNAR_YEAR = 2000;
/** 月份表的最后一年。再往后（公历 2100 年春节起）lunarDate 返回 undefined。 */
export const LAST_LUNAR_YEAR = FIRST_LUNAR_YEAR + LUNAR_YEARS.length - 1;

/** 农历日期。leap 为 true 表示闰月，比如 2025 年闰六月的初一是 { month: 6, day: 1, leap: true }。 */
export interface LunarDate {
  month: number;
  day: number;
  leap: boolean;
}

interface LunarYear {
  /** 正月初一是 1970-01-01 之后的第几天（公历）。 */
  startDay: number;
  /** 每个月的天数和月号，按顺序，闰月紧跟在同号的月份后面。 */
  months: LunarDate[];
  lengths: number[];
}

const DAY_MS = 86_400_000;

function epochDay(year: number, month: number, day: number): number {
  return Math.round(Date.UTC(year, month - 1, day) / DAY_MS);
}

let parsed: LunarYear[] | undefined;

function lunarYears(): LunarYear[] {
  parsed ??= LUNAR_YEARS.map((entry, index) => {
    const [mmdd = '', leapText = '', bits = ''] = entry.split(' ');
    const leapMonth = Number(leapText);
    const months: LunarDate[] = [];
    for (let month = 1; month <= 12; month++) {
      months.push({ month, day: 1, leap: false });
      if (month === leapMonth) months.push({ month, day: 1, leap: true });
    }
    return {
      startDay: epochDay(FIRST_LUNAR_YEAR + index, Number(mmdd.slice(0, 2)), Number(mmdd.slice(2))),
      months,
      lengths: Array.from({ length: bits.length }, (_, i) => (bits[i] === '1' ? 30 : 29)),
    };
  });
  return parsed;
}

/**
 * 公历的某一天是农历的几月几日。year、month、day 是公历的年、月（1～12）、日，按用户的本地日期传入。
 * 不在月份表范围里（公历 2000-02-05 之前、2100-02-09 及以后）返回 undefined。
 */
export function lunarDate(year: number, month: number, day: number): LunarDate | undefined {
  const target = epochDay(year, month, day);
  const years = lunarYears();
  for (let index = years.length - 1; index >= 0; index--) {
    const entry = years[index];
    if (entry === undefined || target < entry.startDay) continue;
    let offset = target - entry.startDay;
    for (const [i, length] of entry.lengths.entries()) {
      const current = entry.months[i];
      if (current === undefined) break;
      if (offset < length) return { month: current.month, day: offset + 1, leap: current.leap };
      offset -= length;
    }
    return undefined;
  }
  return undefined;
}

/** 测试用：每个农历年正月初一的公历日子（1970-01-01 之后的第几天）和每个月的天数。 */
export function lunarYearTable(): readonly { startDay: number; lengths: readonly number[] }[] {
  return lunarYears().map(({ startDay, lengths }) => ({ startDay, lengths }));
}
