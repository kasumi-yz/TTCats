import { describe, expect, it, vi } from 'vitest';
import type { MainCommandHandlers } from './ipc-router';
import type { StateSnapshot } from '../shared/ipc';
import { combineFeatures, type MainFeature } from './features';

vi.mock('electron', () => ({}));

const otherCommands = {
  'diagnostics/export': vi.fn(),
  'update/check': vi.fn(),
  'update/install': vi.fn(),
  'debug/simulateIdle': vi.fn(),
  'debug/crashOverlay': vi.fn(),
  'debug/simulateFullscreen': vi.fn(),
} satisfies Partial<MainCommandHandlers>;

describe('主进程功能登记', () => {
  it('快照通知、菜单段、启动和退出清理都按登记顺序；命令合并成一张表', () => {
    const calls: string[] = [];
    const take = vi.fn();
    const first = {
      onSnapshot: () => calls.push('snapshot:first'),
      start: () => calls.push('start:first'),
      dispose: () => calls.push('dispose:first'),
      menuSection: () => [{ id: 'first' }],
    } satisfies MainFeature;
    const second = {
      onSnapshot: () => calls.push('snapshot:second'),
      mainCommands: { 'photo/take': take },
      menuSection: () => [{ id: 'second' }],
    } satisfies MainFeature;
    const third = {
      start: () => calls.push('start:third'),
      dispose: () => calls.push('dispose:third'),
      mainCommands: otherCommands,
    } satisfies MainFeature;
    const features = combineFeatures([first, second, third]);

    features.onSnapshot({} as StateSnapshot);
    features.start();
    for (const step of features.disposeSteps) step();
    expect(calls).toEqual([
      'snapshot:first',
      'snapshot:second',
      'start:first',
      'start:third',
      'dispose:first',
      'dispose:third',
    ]);
    expect(features.menuSections).toEqual([first.menuSection, second.menuSection]);
    expect(features.mainCommands['photo/take']).toBe(take);
    expect(Object.keys(features.mainCommands).sort()).toEqual(
      ['photo/take', ...Object.keys(otherCommands)].sort(),
    );
  });

  it('清理步骤按调用时的方法执行，异常原样抛给退出流程', () => {
    const error = new Error('boom');
    const feature = {
      dispose(): void {
        throw error;
      },
    };
    const { disposeSteps } = combineFeatures([
      feature,
      { mainCommands: { 'photo/take': vi.fn(), ...otherCommands } },
    ]);
    expect(() => {
      disposeSteps[0]?.();
    }).toThrow(error);
  });
});
