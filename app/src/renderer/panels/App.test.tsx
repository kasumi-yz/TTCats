// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContentCatalog } from '../../shared/core-api';
import type { PanelsBridge, StageDebugReport, StateSnapshot } from '../../shared/ipc';
import { CatSchema, ClipSchema } from '../../shared/schemas';
import { defaultSettings } from '../../shared/schemas/settings';
import { zh } from '../../shared/strings.zh-CN';
import { App } from './App';

const text = zh.panels;
const cat = CatSchema.parse({
  schemaVersion: 1,
  id: 'test-cat',
  name: '测试猫',
  birthday: '2020-10-02',
  homeDate: '2021-01-03',
  relativeSize: 1,
  personality: { activity: 0.2, clinginess: 0.4, initiative: 0.6, dominance: 0.8, patience: 1 },
  relationships: [],
  sounds: { meow: [], purr: [] },
});
const clip = ClipSchema.parse({
  schemaVersion: 1,
  name: 'idle-stand',
  variant: 1,
  kind: 'loop',
  fromPose: 'stand',
  toPose: 'stand',
  optional: false,
  video: 'clips/idle.webm',
  hitMask: 'clips/idle.bin',
  hitMaskScale: 1,
  fps: 1,
  frameCount: 1,
  width: 1,
  height: 1,
  footAnchors: [{ x: 0, y: 0 }],
  mirrorable: true,
  facing: 'right',
  speed: 0,
  keypoints: {},
});
function catalog(): ContentCatalog {
  return {
    cats: {
      [cat.id]: { cat, clips: [clip, { ...clip, variant: 2 }] },
      'other-cat': {
        cat: {
          ...cat,
          id: 'other-cat',
          name: '另一只猫',
          birthday: undefined,
          homeDate: undefined,
        },
        clips: [],
      },
    },
    disabled: [{ cat: 'broken-cat', problems: ['猫咪包「broken-cat」缺少站姿片段'] }],
  };
}
function snapshot(revision = 1): StateSnapshot {
  return {
    revision,
    at: new Date('2026-10-01T12:00:00').getTime(),
    settings: defaultSettings([cat.id]),
  };
}
function fakeBridge(content = catalog()) {
  const snapshots = new Set<(value: StateSnapshot) => void>();
  const reports = new Set<(value: StageDebugReport) => void>();
  const sendCommand = vi.fn<PanelsBridge['sendCommand']>();
  const bridge: PanelsBridge = {
    sendCommand,
    getSnapshot: vi.fn(() => Promise.resolve(snapshot())),
    getContent: vi.fn(() => Promise.resolve(content)),
    onSnapshot: vi.fn((listener: (value: StateSnapshot) => void) => {
      snapshots.add(listener);
      return () => {
        snapshots.delete(listener);
      };
    }),
    onStageDebug: vi.fn((listener: (value: StageDebugReport) => void) => {
      reports.add(listener);
      return () => {
        reports.delete(listener);
      };
    }),
  };
  return {
    bridge,
    sendCommand,
    snapshots,
    reports,
    pushSnapshot: (value: StateSnapshot) => {
      act(() => {
        snapshots.forEach((listener) => {
          listener(value);
        });
      });
    },
    pushReport: (value: StageDebugReport) => {
      act(() => {
        reports.forEach((listener) => {
          listener(value);
        });
      });
    },
  };
}
afterEach(cleanup);

describe('面板通过主进程管理猫和设置', () => {
  it('设置只发送命令，不抢先修改显示值；以主进程的新快照为准', async () => {
    const fake = fakeBridge();
    const user = userEvent.setup();
    render(<App bridge={fake.bridge} search="?panel=settings" />);
    const activity = await screen.findByRole('combobox', { name: text.activityLevel });
    await user.selectOptions(activity, 'rowdy');
    expect(fake.sendCommand).toHaveBeenLastCalledWith({
      type: 'settings/update',
      patch: { activityLevel: 'rowdy' },
    });
    expect((activity as HTMLSelectElement).value).toBe('natural');
    for (const [label, input, patch] of [
      [text.scale, '150', { scale: 1.5 }],
      [text.floorDepth, '25', { floorDepth: 0.25 }],
    ] as const) {
      fireEvent.change(screen.getByRole('slider', { name: label }), { target: { value: input } });
      expect(fake.sendCommand).toHaveBeenLastCalledWith({ type: 'settings/update', patch });
    }
    await user.click(screen.getByRole('checkbox', { name: text.capture }));
    expect(fake.sendCommand).toHaveBeenLastCalledWith({
      type: 'settings/update',
      patch: { showInScreenCapture: true },
    });
    await user.click(screen.getByRole('checkbox', { name: cat.name }));
    expect(fake.sendCommand).toHaveBeenLastCalledWith({
      type: 'cat/setVisible',
      cat: cat.id,
      visible: false,
    });
    const next = snapshot(2);
    next.settings = {
      ...next.settings,
      visibleCats: [],
      activityLevel: 'rowdy',
      scale: 1.5,
      floorDepth: 0.25,
      showInScreenCapture: true,
    };
    fake.pushSnapshot(next);
    expect((activity as HTMLSelectElement).value).toBe('rowdy');
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: cat.name }).checked).toBe(false);
    expect(screen.getByRole<HTMLInputElement>('slider', { name: text.scale }).value).toBe('150');
    expect(screen.getByRole<HTMLInputElement>('slider', { name: text.floorDepth }).value).toBe(
      '25',
    );
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: text.capture }).checked).toBe(
      true,
    );
    fake.pushSnapshot(snapshot(1));
    fake.pushSnapshot(snapshot(2));
    expect((activity as HTMLSelectElement).value).toBe('rowdy');
    expect(screen.getByText(text.captureHelp)).toBeTruthy();
  });

  it('迟到的初始快照不能覆盖已收到的新快照，关闭页面后清理订阅', async () => {
    const fake = fakeBridge();
    let resolveInitial: ((value: StateSnapshot) => void) | undefined;
    fake.bridge.getSnapshot = () =>
      new Promise((resolve) => {
        resolveInitial = resolve;
      });
    const view = render(<App bridge={fake.bridge} />);
    const next = snapshot(5);
    next.settings.activityLevel = 'quiet';
    fake.pushSnapshot(next);
    await act(async () => {
      resolveInitial?.(snapshot());
      await Promise.resolve();
    });
    expect(
      (await screen.findByRole<HTMLSelectElement>('combobox', { name: text.activityLevel })).value,
    ).toBe('quiet');
    view.unmount();
    expect(fake.snapshots.size).toBe(0);
    expect(fake.reports.size).toBe(0);
  });

  it('调试台每个按钮发送对应命令，并能选择猫和片段版本', async () => {
    const fake = fakeBridge();
    const user = userEvent.setup();
    render(<App bridge={fake.bridge} search="?panel=debug" />);
    await screen.findByRole('combobox', { name: text.cat });
    const cases = [
      [text.summonAll, { type: 'cat/summon' }],
      [text.summon, { type: 'cat/summon', cat: cat.id }],
      [text.sleep, { type: 'cat/sleep', cat: cat.id }],
      [text.show, { type: 'cat/setVisible', cat: cat.id, visible: true }],
      [text.hide, { type: 'cat/setVisible', cat: cat.id, visible: false }],
      [text.playClip, { type: 'debug/playClip', cat: cat.id, clip: clip.name, variant: 1 }],
      ...(['poke', 'pet', 'pickUp', 'drop'] as const).map(
        (interaction) =>
          [
            text.interactions[interaction],
            { type: 'debug/simulate', cat: cat.id, interaction },
          ] as const,
      ),
      [text.crash, { type: 'debug/crashOverlay' }],
    ] as const;
    for (const [name, command] of cases) {
      await user.click(screen.getByRole('button', { name }));
      expect(fake.sendCommand).toHaveBeenLastCalledWith(command);
    }
    await user.selectOptions(screen.getByRole('combobox', { name: text.clip }), 'idle-stand:2');
    await user.click(screen.getByRole('button', { name: text.playClip }));
    expect(fake.sendCommand).toHaveBeenLastCalledWith({
      type: 'debug/playClip',
      cat: cat.id,
      clip: clip.name,
      variant: 2,
    });
    await user.selectOptions(screen.getByRole('combobox', { name: text.cat }), 'other-cat');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: text.playClip }).disabled).toBe(
      true,
    );
    await user.click(screen.getByRole('button', { name: text.sleep }));
    expect(fake.sendCommand).toHaveBeenLastCalledWith({
      type: 'cat/sleep',
      cat: 'other-cat',
    });
  });

  it('调试台显示存档设置和桌面层画面状态，不把画面状态写回存档', async () => {
    const fake = fakeBridge();
    const view = render(
      <StrictMode>
        <App bridge={fake.bridge} search="?panel=debug" />
      </StrictMode>,
    );
    await screen.findByText(text.savedState);
    expect(fake.snapshots.size).toBe(1);
    expect(fake.reports.size).toBe(1);
    expect(screen.getByText(`${cat.name} · ${text.visible}`)).toBeTruthy();
    expect(screen.getByText(text.waitingReport)).toBeTruthy();
    fake.pushReport({
      at: 20,
      cats: [
        {
          cat: cat.id,
          pose: 'sit',
          clip: 'idle-sit',
          variant: 2,
          behavior: '等待召唤',
          x: 100,
          y: 200,
        },
      ],
    });
    expect(screen.getByText(zh.poses.sit)).toBeTruthy();
    expect(screen.getByText('idle-sit')).toBeTruthy();
    expect(screen.getByText('等待召唤')).toBeTruthy();
    fake.pushReport({ at: 10, cats: [] });
    expect(screen.getByText('idle-sit')).toBeTruthy();
    expect(screen.getByText('猫咪包「broken-cat」缺少站姿片段')).toBeTruthy();
    expect(fake.sendCommand).not.toHaveBeenCalled();
    view.unmount();
    expect(fake.snapshots.size).toBe(0);
    expect(fake.reports.size).toBe(0);
  });

  it('资料卡来自猫咪包，按快照日期计算足岁，缺失日期不编造', async () => {
    const fake = fakeBridge();
    const view = render(<App bridge={fake.bridge} search={`?panel=profile&cat=${cat.id}`} />);
    await screen.findByRole('heading', { name: cat.name });
    expect(screen.getByText(cat.birthday ?? '')).toBeTruthy();
    expect(screen.getByText(text.ageYears(5))).toBeTruthy();
    expect(screen.getAllByRole('meter').map((meter) => meter.getAttribute('value'))).toEqual([
      '0.2',
      '0.4',
      '0.6',
      '0.8',
      '1',
    ]);
    const birthday = snapshot(2);
    birthday.at = new Date('2026-10-02T12:00:00').getTime();
    fake.pushSnapshot(birthday);
    expect(screen.getByText(text.ageYears(6))).toBeTruthy();
    view.rerender(<App bridge={fake.bridge} search="?panel=profile&cat=other-cat" />);
    expect(screen.getAllByText(text.unknown)).toHaveLength(3);
    view.rerender(<App bridge={fake.bridge} search="?panel=profile&cat=missing" />);
    expect(screen.getByText(text.catMissing)).toBeTruthy();
  });

  it('无猫咪包时禁止单猫命令，读取失败时显示中文原因', async () => {
    const fake = fakeBridge({ cats: {}, disabled: [] });
    const view = render(<App bridge={fake.bridge} search="?panel=debug" />);
    await screen.findByText(text.noCats);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: text.sleep }).disabled).toBe(true);
    view.unmount();
    fake.bridge.getContent = () => Promise.reject(new Error('IPC unavailable'));
    render(<App bridge={fake.bridge} />);
    expect((await screen.findByRole('alert')).textContent).toBe(text.loadFailed);
  });
});
