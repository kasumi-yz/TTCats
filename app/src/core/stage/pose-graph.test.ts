import { describe, expect, it } from 'vitest';
import { ClipSchema, validateWith } from '../../shared/schemas';
import { ClipLibrary, PoseGraph } from './pose-graph';
import { testClip, testClips } from './test-fixtures';

function graphWithout(...omit: string[]): PoseGraph {
  return new PoseGraph(new ClipLibrary(testClips(omit)));
}

describe('测试猫咪包的元数据', () => {
  it('每个片段都能通过 ClipSchema', () => {
    for (const clip of testClips()) {
      expect(validateWith(ClipSchema, clip), clip.name).toMatchObject({ ok: true });
    }
  });
});

describe('姿势网络', () => {
  const graph = graphWithout();

  it('按过渡片段找出从一个姿势到另一个姿势要播的片段', () => {
    expect(graph.path('stand', 'sleep')).toEqual(['stand-to-sit', 'sit-to-sleep']);
    expect(graph.path('sleep', 'stand')).toEqual(['sleep-to-sit', 'sit-to-stand']);
    expect(graph.path('dangle', 'sit')).toEqual(['land', 'stand-to-sit']);
    expect(graph.path('sit', 'sit')).toEqual([]);
  });

  it('没有片段能进入的姿势走不通', () => {
    expect(graph.path('stand', 'dangle')).toBeUndefined();
    expect(graph.path('stand', 'airborne')).toBeUndefined();
  });

  it('有两条路时选用时最短的', () => {
    const slow = testClip('pounce', { frameCount: 240 });
    const g = new PoseGraph(new ClipLibrary([...testClips(['pounce']), slow]));
    expect(g.path('stand', 'stand')).toEqual([]);
    expect(g.path('crouch', 'sit')).toEqual(['pounce', 'stand-to-sit']);
  });

  it('只用猫咪包里实际有的片段建网络：缺了落地，悬空就回不到站姿', () => {
    expect(graphWithout('land').path('dangle', 'stand')).toBeUndefined();
  });

  it('找离当前姿势最近、能长时间待着的姿势', () => {
    expect(graph.nearestRestPose('sleep')).toBe('sleep');
    expect(graph.nearestRestPose('crouch')).toBe('stand');
    expect(graph.nearestRestPose('dangle')).toBe('stand');
    expect(graphWithout('pounce').nearestRestPose('crouch')).toBeUndefined();
  });
});

describe('片段库', () => {
  it('同名片段的多个版本按版本号排好', () => {
    const lib = new ClipLibrary([testClip('groom', { variant: 2 }), testClip('groom')]);
    expect(lib.variants('groom').map((c) => c.variant)).toEqual([1, 2]);
    expect(lib.first('groom')?.variant).toBe(1);
  });

  it('只有基础姿势有"待着"用的循环片段', () => {
    const lib = new ClipLibrary(testClips());
    expect(lib.restLoop('stand')).toBe('idle-stand');
    expect(lib.restLoop('sleep')).toBe('sleep');
    expect(lib.restLoop('dangle')).toBeUndefined();
  });
});
