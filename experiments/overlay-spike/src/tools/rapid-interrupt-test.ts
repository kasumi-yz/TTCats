// npm run rapid-interrupt-test：快速连续打断（站 → 坐 → 立刻站回去）。
//
// 用"按需加载片段 + 交叉淡化"启动桌面层：在第一次打断的淡化还没结束时就打断回去，
// 检查有没有拿已经释放的片段来播放（渲染进程会发出 error 事件），以及之后画面是否还在正常播放。
// 不动鼠标和键盘，大约 20 秒。
//
// 参数：--rounds=5

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LogEvent, OverlayState } from '../shared/protocol';
import { launch, RESULTS, sleep, waitFor } from './common';

const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

async function main(): Promise<void> {
  const rounds = Number(arg('rounds') ?? 5);
  const ov = await launch('main.js', ['--preload=lazy'], '桌面层');
  try {
    await waitFor(async () => (await ov.get<OverlayState>('/state')).cats.length > 0, 15000, 100);
    await sleep(2000);
    await ov.cmd({ type: 'mode', mode: 'crossfade' });
    const id = (await ov.get<OverlayState>('/state')).cats[0].id;
    const catOf = async () => (await ov.get<OverlayState>('/state')).cats.find((c) => c.id === id)!;
    const results = [];
    for (let round = 1; round <= rounds; round++) {
      const from = (await catOf()).clip.includes('sit') ? 'sit' : 'stand';
      const to = from === 'sit' ? 'stand' : 'sit';
      const { seq } = (await ov.cmd({ type: 'noop' })) as { seq: number };
      const events = () => ov.get<LogEvent[]>(`/events?since=${seq}`);
      await ov.cmd({ type: 'interrupt', id, target: to });
      // 等目标片段开始淡入（150ms 的淡化刚开始），立刻打断回去
      await waitFor(async () => (await events()).some((e) => e.type === 'clip' && e.id === id && e.clip === `loop_${to}`), 3000);
      await ov.cmd({ type: 'interrupt', id, target: from });
      await sleep(1500);
      const a = await catOf();
      await sleep(500);
      const b = await catOf();
      const errors = (await events()).filter((e) => e.type === 'error').map((e) => String(e.message));
      const playing = b.clip === `loop_${from}` && (a.clip !== b.clip || a.frame !== b.frame);
      results.push({ round, path: `${from}→${to}→${from}`, pass: errors.length === 0 && playing, errors, clip: b.clip, playing });
      console.log(`第 ${round} 轮 ${from}→${to}→${from}：${errors.length === 0 && playing ? '通过' : '不通过'}  片段=${b.clip} 仍在播放=${playing} ${errors.join('；')}`);
    }
    const file = join(RESULTS, `rapid-interrupt-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify({ time: new Date().toISOString(), results }, null, 2));
    console.log(`结果：${file}`);
    process.exitCode = results.every((r) => r.pass) ? 0 : 1;
  } finally {
    await ov.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
