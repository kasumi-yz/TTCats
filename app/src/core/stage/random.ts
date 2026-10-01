// 随机数工具。随机数来源由调用方传入（CreateStageCore 的 random），测试时可以用固定序列。

/** 返回 [0, 1) 的随机数。 */
export type Random = () => number;

/** 防止随机数来源偶尔返回 1 或越界，让下面的计算都落在合法范围里。 */
function unit(random: Random): number {
  const r = random();
  return r >= 0 && r < 1 ? r : 0;
}

/** [min, max) 之间均匀取一个数。 */
export function uniform(random: Random, min: number, max: number): number {
  return min + (max - min) * unit(random);
}

/** 从数组里随机取一个；数组为空时返回 undefined。 */
export function pick<T>(random: Random, items: readonly T[]): T | undefined {
  return items[Math.floor(unit(random) * items.length)];
}

/** 按权重随机取一个。权重小于等于 0 的不会被选中；全部不能选时返回 undefined。 */
export function pickWeighted<T>(
  random: Random,
  items: readonly T[],
  weightOf: (item: T) => number,
): T | undefined {
  const weights = items.map((item) => Math.max(0, weightOf(item)));
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (!(total > 0)) return undefined;
  let r = unit(random) * total;
  let last: T | undefined;
  for (const [i, item] of items.entries()) {
    const w = weights[i] ?? 0;
    if (w <= 0) continue;
    if (r < w) return item;
    r -= w;
    last = item;
  }
  // 浮点误差落到最后时，取最后一个能选的
  return last;
}
