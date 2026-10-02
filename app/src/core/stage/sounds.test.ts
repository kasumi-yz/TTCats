import { describe, expect, it } from 'vitest';
import { Stage } from './stage-core';
import { catalog, snapshot, testCat, testClips, SCREEN } from './test-fixtures';

function setup(omit: string[] = [], random = () => 0.5) {
  const clips = testClips(omit).map((clip) => ({ ...clip, soundStartFrame: 12 }));
  const cat = testCat('sound-cat', {
    sounds: { meow: ['sounds/a.wav', 'sounds/b.wav'], purr: ['sounds/p.wav'] },
  });
  const stage = new Stage({
    content: catalog([{ cat, clips }]),
    snapshot: snapshot([cat.id]),
    bounds: SCREEN,
    now: 0,
    random,
  });
  const command = (sound: 'meow' | 'purr', now: number) => {
    stage.handleCommand({ type: 'debug/sound', cat: cat.id, sound }, now);
  };
  return { stage, cat, command };
}
const meow = { cat: 'sound-cat', sound: 'meow', action: 'start', file: 'sounds/b.wav' };
const purr = { cat: 'sound-cat', sound: 'purr', action: 'start', file: 'sounds/p.wav' };
const stop = { cat: 'sound-cat', sound: 'purr', action: 'stop' };

describe('片段声音提示', () => {
  it('喵叫在对应帧才开始，帧率浮动按播放速度换算，下一帧不重复', () => {
    const { stage } = setup(['poked']);
    stage.handleCommand({ type: 'debug/simulate', cat: 'sound-cat', interaction: 'poke' }, 0);
    expect(stage.update(499).sounds).toEqual([]);
    expect(stage.update(500).sounds).toEqual([meow]);
    expect(stage.update(700).sounds).toEqual([]);
    const fast = setup(['poked'], () => 0.9).stage;
    fast.handleCommand({ type: 'debug/simulate', cat: 'sound-cat', interaction: 'poke' }, 0);
    expect(fast.update(462).sounds).toEqual([]);
    expect(fast.update(464).sounds).toEqual([meow]);
  });

  it('只有气泡的降级反应也发喵叫，有 poked 片段则不额外叫', () => {
    for (const [omit, expected] of [
      [['poked', 'meow'], [meow]],
      [[], []],
    ] as const) {
      const { stage } = setup([...omit]);
      stage.handleCommand({ type: 'debug/simulate', cat: 'sound-cat', interaction: 'poke' }, 0);
      const frame = stage.update(0);
      expect(frame.bubbles).toHaveLength(1);
      expect(frame.sounds).toEqual(expected);
    }
  });

  it('呼噜循环只启动一次，换片段才停止', () => {
    const { stage } = setup();
    stage.handleCommand({ type: 'debug/simulate', cat: 'sound-cat', interaction: 'pet' }, 0);
    expect(stage.update(499).sounds).toEqual([]);
    expect(stage.update(500).sounds).toEqual([purr]);
    for (let now = 1000; now <= 4000; now += 500) expect(stage.update(now).sounds).toEqual([]);
    stage.handleCommand({ type: 'debug/playClip', cat: 'sound-cat', clip: 'idle-sit' }, 4000);
    expect(stage.update(4000).sounds).toEqual([stop]);
  });

  it('起始帧前打断不出声；自然播完呼噜也有 stop', () => {
    const { stage } = setup(['poked']);
    stage.handleCommand({ type: 'debug/simulate', cat: 'sound-cat', interaction: 'poke' }, 0);
    stage.handleCommand({ type: 'debug/playClip', cat: 'sound-cat', clip: 'idle-sit' }, 200);
    expect(stage.update(700).sounds).toEqual([]);
    stage.handleCommand({ type: 'debug/playClip', cat: 'sound-cat', clip: 'purr' }, 700);
    expect(stage.update(1200).sounds).toEqual([purr]);
    expect(stage.update(6700).sounds).toContainEqual(stop);
  });

  it('隐藏移除猫和未消费提示，由桌面层停声，不给重新显示的猫补播', () => {
    const { stage, command } = setup();
    command('purr', 0);
    stage.applySnapshot(snapshot([], {}, 2), 0);
    expect(stage.update(0)).toMatchObject({ cats: [], sounds: [] });
    stage.applySnapshot(snapshot(['sound-cat'], {}, 3), 100);
    expect(stage.update(3000).sounds).toEqual([]);
  });

  it('随机挑选本猫的声音文件，空声音位不发提示', () => {
    let value = 0;
    const { stage, command, cat } = setup([], () => value);
    command('meow', 0);
    expect(stage.update(0).sounds).toEqual([{ ...meow, file: 'sounds/a.wav' }]);
    value = 0.99;
    command('meow', 0);
    expect(stage.update(0).sounds).toEqual([meow]);
    cat.sounds.meow = [];
    command('meow', 0);
    expect(stage.update(0).sounds).toEqual([]);
  });

  it('调试呼噜三秒后停止，过期 start 不补播但 stop 保留', () => {
    const { stage, command } = setup();
    command('purr', 0);
    expect(stage.update(0).sounds).toEqual([purr]);
    expect(stage.update(2999).sounds).toEqual([]);
    expect(stage.update(3000).sounds).toEqual([stop]);
    command('purr', 3000);
    expect(stage.update(9000).sounds).toEqual([stop]);
  });

  it('没有声音文件的呼噜片段开始和结束都不发提示', () => {
    const { stage, cat } = setup();
    cat.sounds.purr = [];
    stage.handleCommand({ type: 'debug/simulate', cat: cat.id, interaction: 'pet' }, 0);
    expect(stage.update(500).sounds).toEqual([]);
    stage.handleCommand({ type: 'debug/playClip', cat: cat.id, clip: 'idle-sit' }, 500);
    expect(stage.update(500).sounds).toEqual([]);
  });

  it('系统时钟倒退保留调试呼噜的剩余时长', () => {
    const { stage, command } = setup();
    command('purr', 1000);
    stage.update(1000);
    stage.update(0);
    expect(stage.update(2999).sounds).toEqual([]);
    expect(stage.update(3000).sounds).toEqual([stop]);
  });
});
