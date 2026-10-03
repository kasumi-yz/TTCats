// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContentCatalog } from '../../shared/core-api';
import type { DisplayInfo } from '../../shared/display';
import type { AppStatus, PanelsBridge, StageDebugReport, StateSnapshot } from '../../shared/ipc';
import { CatSchema, ClipSchema } from '../../shared/schemas';
import { DEFAULT_HIDE_ALL_SHORTCUT, defaultSettings } from '../../shared/schemas/settings';
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
    doNotDisturb: { mode: 'off' },
    hideAll: false,
    silencedBy: [],
    clockOffsetMs: 0,
  };
}
function appStatus(revision = 1, patch: Partial<AppStatus> = {}): AppStatus {
  return {
    revision,
    version: '0.2.0',
    update: { state: 'idle', checkedAt: null },
    hideAllShortcut: { accelerator: DEFAULT_HIDE_ALL_SHORTCUT, registered: true },
    displays: [display(1, 'DELL U2720Q', true)],
    overlayDisplayId: 1,
    ...patch,
  };
}
function display(id: number, label: string, primary: boolean): DisplayInfo {
  return { id, label, width: 2560, height: 1440, scaleFactor: 1.5, primary };
}
function fakeBridge(
  content = catalog(),
  status: Promise<AppStatus> = Promise.resolve(appStatus()),
) {
  const snapshots = new Set<(value: StateSnapshot) => void>();
  const reports = new Set<(value: StageDebugReport) => void>();
  const statuses = new Set<(value: AppStatus) => void>();
  const sendCommand = vi.fn<PanelsBridge['sendCommand']>();
  const bridge: PanelsBridge = {
    sendCommand,
    getSnapshot: vi.fn(() => Promise.resolve(snapshot())),
    getContent: vi.fn(() => Promise.resolve(content)),
    getAppStatus: vi.fn(() => status),
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
    onAppStatus: vi.fn((listener: (value: AppStatus) => void) => {
      statuses.add(listener);
      return () => {
        statuses.delete(listener);
      };
    }),
  };
  return {
    bridge,
    sendCommand,
    snapshots,
    reports,
    statuses,
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
    pushStatus: (value: AppStatus) => {
      act(() => {
        statuses.forEach((listener) => {
          listener(value);
        });
      });
    },
  };
}
afterEach(cleanup);

describe('面板通过主进程管理猫和设置', () => {
  it('滑块在等待后台确认时跟手，只有更新版本的快照才能取代草稿', async () => {
    const fake = fakeBridge();
    render(<App bridge={fake.bridge} search="?panel=settings" />);
    const scale = await screen.findByRole<HTMLInputElement>('slider', { name: text.scale });
    const depth = screen.getByRole<HTMLInputElement>('slider', { name: text.floorDepth });
    fireEvent.change(scale, { target: { value: '150' } });
    fireEvent.change(scale, { target: { value: '175' } });
    fireEvent.change(depth, { target: { value: '25' } });
    expect(scale.value).toBe('175');
    expect(depth.value).toBe('25');
    expect(fake.sendCommand.mock.calls.map(([command]) => command)).toEqual([
      { type: 'settings/update', patch: { scale: 1.5 } },
      { type: 'settings/update', patch: { scale: 1.75 } },
      { type: 'settings/update', patch: { floorDepth: 0.25 } },
    ]);
    fake.pushSnapshot(snapshot(0));
    fake.pushSnapshot(snapshot(1));
    expect(scale.value).toBe('175');
    expect(depth.value).toBe('25');
    const confirmed = snapshot(2);
    confirmed.settings.scale = 1.6;
    confirmed.settings.floorDepth = 0.3;
    fake.pushSnapshot(confirmed);
    expect(scale.value).toBe('160');
    expect(depth.value).toBe('30');
  });
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
    fake.pushSnapshot(snapshot(1));
    fake.pushSnapshot(snapshot(2));
    expect((activity as HTMLSelectElement).value).toBe('rowdy');
    await user.click(screen.getByRole('tab', { name: text.tabs.display }));
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: text.capture }).checked).toBe(
      true,
    );
    expect(screen.getByText(text.captureHelp)).toBeTruthy();
    await user.click(screen.getByRole('checkbox', { name: text.capture }));
    expect(fake.sendCommand).toHaveBeenLastCalledWith({
      type: 'settings/update',
      patch: { showInScreenCapture: false },
    });
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
    expect(fake.statuses.size).toBe(0);
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
      ...(['poke', 'pet', 'pickUp', 'drop', 'nearbyClicks'] as const).map(
        (interaction) =>
          [
            text.simulations[interaction],
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
          x: 100.123456,
          y: 200.654321,
        },
      ],
    });
    expect(screen.getByText(zh.poses.sit)).toBeTruthy();
    expect(screen.getByText('idle-sit')).toBeTruthy();
    expect(screen.getByText('等待召唤')).toBeTruthy();
    expect(screen.getByText('100, 201')).toBeTruthy();
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

describe('M2 的设置项', () => {
  async function openTab(name: string) {
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name }));
    return user;
  }

  it('声音：开关、音量、安静时段都发出对应的设置命令', async () => {
    const fake = fakeBridge();
    render(<App bridge={fake.bridge} />);
    const user = await openTab(text.tabs.sound);
    for (const [label, patch] of [
      [text.purrEnabled, { purrEnabled: false }],
      [text.meowEnabled, { meowEnabled: false }],
    ] as const) {
      await user.click(screen.getByRole('checkbox', { name: label }));
      expect(fake.sendCommand).toHaveBeenLastCalledWith({ type: 'settings/update', patch });
    }
    for (const [label, value, patch] of [
      [text.purrVolume, '80', { purrVolume: 0.8 }],
      [text.meowVolume, '10', { meowVolume: 0.1 }],
    ] as const) {
      fireEvent.change(screen.getByRole('slider', { name: label }), { target: { value } });
      expect(fake.sendCommand).toHaveBeenLastCalledWith({ type: 'settings/update', patch });
    }
    const start = screen.getByLabelText<HTMLInputElement>(text.quietHoursStart);
    const end = screen.getByLabelText<HTMLInputElement>(text.quietHoursEnd);
    expect([start.value, end.value]).toEqual(['23:00', '08:00']);
    fireEvent.change(start, { target: { value: '22:30' } });
    expect(fake.sendCommand).toHaveBeenLastCalledWith({
      type: 'settings/update',
      patch: { quietHoursStart: '22:30' },
    });
    expect(start.value).toBe('22:30');
    fireEvent.change(end, { target: { value: '07:15' } });
    expect(fake.sendCommand).toHaveBeenLastCalledWith({
      type: 'settings/update',
      patch: { quietHoursEnd: '07:15' },
    });
    const calls = fake.sendCommand.mock.calls.length;
    fireEvent.change(end, { target: { value: '' } });
    expect(fake.sendCommand).toHaveBeenCalledTimes(calls);
    // 以主进程推来的新快照为准；声音关掉后音量滑块不能拖。
    const next = snapshot(2);
    next.settings = { ...next.settings, purrEnabled: false, quietHoursStart: '21:00' };
    fake.pushSnapshot(next);
    expect(start.value).toBe('21:00');
    expect(screen.getByRole<HTMLInputElement>('slider', { name: text.purrVolume }).disabled).toBe(
      true,
    );
    expect(screen.getByText(text.quietHoursHelp)).toBeTruthy();
  });

  it('程序：开机启动、自动更新开关和导出诊断信息', async () => {
    const fake = fakeBridge();
    render(<App bridge={fake.bridge} />);
    const user = await openTab(text.tabs.app);
    await user.click(screen.getByRole('checkbox', { name: text.launchAtLogin }));
    expect(fake.sendCommand).toHaveBeenLastCalledWith({
      type: 'settings/update',
      patch: { launchAtLogin: false },
    });
    await user.click(screen.getByRole('checkbox', { name: text.autoUpdate }));
    expect(fake.sendCommand).toHaveBeenLastCalledWith({
      type: 'settings/update',
      patch: { autoUpdate: false },
    });
    await user.click(screen.getByRole('button', { name: text.exportDiagnostics }));
    expect(fake.sendCommand).toHaveBeenLastCalledWith({ type: 'diagnostics/export' });
    expect(screen.getByText(text.exportDiagnosticsHelp)).toBeTruthy();
  });

  it('勿扰：按时长开始、显示什么时候结束、可以结束', async () => {
    const fake = fakeBridge();
    render(<App bridge={fake.bridge} />);
    const user = await openTab(text.tabs.quiet);
    expect(screen.getByText(text.doNotDisturbOff)).toBeTruthy();
    expect(screen.queryByRole('button', { name: text.doNotDisturbEnd })).toBeNull();
    for (const duration of ['30m', '1h', '2h', 'untilOff'] as const) {
      await user.click(screen.getByRole('button', { name: text.doNotDisturbDurations[duration] }));
      expect(fake.sendCommand).toHaveBeenLastCalledWith({ type: 'doNotDisturb/start', duration });
    }
    const timed = snapshot(2);
    timed.doNotDisturb = { mode: 'timed', until: timed.at + 90 * 60_000 };
    fake.pushSnapshot(timed);
    expect(screen.getByText(text.doNotDisturbUntil('13:30'))).toBeTruthy();
    expect(screen.getByText(text.doNotDisturbRestart)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: text.doNotDisturbEnd }));
    expect(fake.sendCommand).toHaveBeenLastCalledWith({ type: 'doNotDisturb/end' });
    const overnight = snapshot(3);
    overnight.at = new Date('2026-10-01T23:30:00').getTime();
    overnight.doNotDisturb = { mode: 'timed', until: overnight.at + 60 * 60_000 };
    fake.pushSnapshot(overnight);
    expect(screen.getByText(text.doNotDisturbUntil(text.tomorrow('00:30')))).toBeTruthy();
    const untilOff = snapshot(4);
    untilOff.doNotDisturb = { mode: 'untilOff' };
    fake.pushSnapshot(untilOff);
    expect(screen.getByText(text.doNotDisturbUntilOff)).toBeTruthy();
    fake.pushSnapshot(snapshot(5));
    expect(screen.getByText(text.doNotDisturbOff)).toBeTruthy();
  });

  it('快捷键：按下组合键录入，格式不对时用中文提示且不发命令', async () => {
    const fake = fakeBridge();
    render(<App bridge={fake.bridge} />);
    const user = await openTab(text.tabs.quiet);
    expect(screen.getByLabelText(text.hideAllShortcut).textContent).toBe('Ctrl+Alt+Shift+H');
    expect(screen.getByText(text.hideAllHelp)).toBeTruthy();
    expect(screen.getByText(text.shortcutRegistered)).toBeTruthy();
    const record = async (keys: string) => {
      await user.click(screen.getByRole('button', { name: text.recordShortcut }));
      await user.keyboard(keys);
    };

    await user.click(screen.getByRole('button', { name: text.recordShortcut }));
    await user.keyboard('{Control>}{Alt>}');
    expect(screen.getByRole('button', { name: text.recordingPartial('Ctrl+Alt') })).toBeTruthy();
    await user.keyboard('k{/Alt}{/Control}');
    expect(fake.sendCommand).toHaveBeenLastCalledWith({
      type: 'settings/update',
      patch: { hideAllShortcut: 'CommandOrControl+Alt+K' },
    });
    expect(fake.sendCommand).toHaveBeenCalledTimes(1);

    await record('{Shift>}K{/Shift}');
    expect(screen.getByRole('alert').textContent).toBe(zh.validation.acceleratorNeedsModifier);
    await record('{Control>}{Shift>}{F10}{/Shift}{/Control}');
    expect(screen.getByRole('alert').textContent).toBe(zh.validation.acceleratorReserved);
    await record('{Control>}{CapsLock}{/Control}');
    expect(screen.getByRole('alert').textContent).toBe(zh.validation.acceleratorFormat);
    await record('{Escape}');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: text.recordShortcut })).toBeTruthy();
    // 和现在的快捷键一样时不用再发。
    await record('{Control>}{Alt>}{Shift>}h{/Shift}{/Alt}{/Control}');
    expect(fake.sendCommand).toHaveBeenCalledTimes(1);

    const changed = snapshot(2);
    changed.settings.hideAllShortcut = 'CommandOrControl+Alt+K';
    fake.pushSnapshot(changed);
    expect(screen.getByText(text.shortcutPending)).toBeTruthy();
    fake.pushStatus(
      appStatus(2, {
        hideAllShortcut: { accelerator: 'CommandOrControl+Alt+K', registered: false },
      }),
    );
    expect(screen.getByRole('alert').textContent).toBe(text.shortcutFailed('Ctrl+Alt+K'));
    fake.pushStatus(
      appStatus(3, {
        hideAllShortcut: { accelerator: 'CommandOrControl+Alt+K', registered: true },
      }),
    );
    expect(screen.getByText(text.shortcutRegistered)).toBeTruthy();
  });

  it('自动更新：每种状态的说明和按钮', async () => {
    const fake = fakeBridge();
    render(<App bridge={fake.bridge} />);
    const user = await openTab(text.tabs.app);
    const states = text.updateStates;
    const check = () => screen.getByRole<HTMLButtonElement>('button', { name: text.checkUpdate });
    const install = () => screen.queryByRole('button', { name: text.installUpdate });
    expect(screen.getByText('0.2.0')).toBeTruthy();
    expect(screen.getByText(states.neverChecked)).toBeTruthy();
    await user.click(check());
    expect(fake.sendCommand).toHaveBeenLastCalledWith({ type: 'update/check' });

    const at = snapshot().at;
    const cases: [AppStatus['update'], string, boolean][] = [
      [{ state: 'unsupported' }, states.unsupported, false],
      [{ state: 'off' }, states.off, true],
      [{ state: 'idle', checkedAt: at - 3_600_000 }, states.upToDate('11:00'), true],
      [{ state: 'checking' }, states.checking, false],
      [
        { state: 'downloading', version: '0.3.0', percent: 42.4 },
        states.downloading('0.3.0', 42.4),
        false,
      ],
      [
        { state: 'error', message: '网络连不上', at: at - 60_000 },
        states.error('网络连不上', '11:59'),
        true,
      ],
    ];
    let revision = 2;
    for (const [update, message, checkable] of cases) {
      fake.pushStatus(appStatus(revision++, { update }));
      expect(screen.getByText(message)).toBeTruthy();
      expect(check().disabled).toBe(!checkable);
      expect(install()).toBeNull();
    }
    fake.pushStatus(appStatus(revision, { update: { state: 'downloaded', version: '0.3.0' } }));
    expect(screen.getByText(states.downloaded('0.3.0'))).toBeTruthy();
    expect(check().disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: text.installUpdate }));
    expect(fake.sendCommand).toHaveBeenLastCalledWith({ type: 'update/install' });
    // 过期的程序状态被丢掉。
    fake.pushStatus(appStatus(1, { update: { state: 'checking' } }));
    expect(screen.getByText(states.downloaded('0.3.0'))).toBeTruthy();
  });

  it('显示器：一块时只显示说明，多块时可以选，选的那块没接上时说明猫在主显示器', async () => {
    const fake = fakeBridge();
    render(<App bridge={fake.bridge} />);
    const user = await openTab(text.tabs.display);
    expect(screen.getByText(text.singleDisplay)).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: text.display })).toBeNull();
    fake.pushStatus(
      appStatus(2, { displays: [display(1, 'DELL U2720Q', true), display(2, '', false)] }),
    );
    const select = screen.getByRole<HTMLSelectElement>('combobox', { name: text.display });
    expect(select.value).toBe('primary');
    expect(
      screen.getByRole('option', {
        name: `${text.displayName(2, '')}（${text.displayDetail(2560, 1440, 1.5)}）`,
      }),
    ).toBeTruthy();
    await user.selectOptions(select, '2');
    expect(fake.sendCommand).toHaveBeenLastCalledWith({
      type: 'settings/update',
      patch: { display: { id: 2, label: '', width: 2560, height: 1440 } },
    });
    const chosen = snapshot(2);
    chosen.settings.display = { id: 2, label: '', width: 2560, height: 1440 };
    fake.pushSnapshot(chosen);
    expect(select.value).toBe('2');
    await user.selectOptions(select, 'primary');
    expect(fake.sendCommand).toHaveBeenLastCalledWith({
      type: 'settings/update',
      patch: { display: null },
    });
    const missing = snapshot(3);
    missing.settings.display = { id: 9, label: 'LG 27UL850', width: 3840, height: 2160 };
    fake.pushSnapshot(missing);
    expect(select.value).toBe('missing');
    expect(screen.getByText(text.displayMissingHelp)).toBeTruthy();
  });

  it('拿不到程序状态时其他设置照常可用，相关位置显示中文说明', async () => {
    const fake = fakeBridge(catalog(), Promise.reject(new Error('没有处理函数')));
    render(<App bridge={fake.bridge} />);
    expect(await screen.findByRole('combobox', { name: text.activityLevel })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    const user = await openTab(text.tabs.display);
    expect(screen.getByText(text.statusUnavailable)).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: text.tabs.app }));
    expect(screen.getByText(text.statusUnavailable)).toBeTruthy();
    // 之后推来的程序状态照样显示。
    fake.pushStatus(appStatus(1));
    expect(screen.getByText(text.updateStates.neverChecked)).toBeTruthy();
  });
});

describe('M2 的调试台', () => {
  it('每个新调试按钮都发出对应的命令', async () => {
    const fake = fakeBridge();
    const user = userEvent.setup();
    render(<App bridge={fake.bridge} search="?panel=debug" />);
    await screen.findByRole('combobox', { name: text.cat });
    const cases = [
      [text.sounds.meow, { type: 'debug/sound', cat: cat.id, sound: 'meow' }],
      [text.sounds.purr, { type: 'debug/sound', cat: cat.id, sound: 'purr' }],
      [text.hideAllToggle, { type: 'hideAll/toggle' }],
      [text.entranceAll, { type: 'debug/entrance' }],
      [text.fullscreenStart, { type: 'debug/simulateFullscreen', active: true }],
      [text.fullscreenEnd, { type: 'debug/simulateFullscreen', active: false }],
      [text.startupQuiet, { type: 'debug/startupQuiet' }],
      [text.doNotDisturbDurations['30m'], { type: 'doNotDisturb/start', duration: '30m' }],
      [text.doNotDisturbDurations.untilOff, { type: 'doNotDisturb/start', duration: 'untilOff' }],
      [text.takePhoto, { type: 'photo/take' }],
      [text.exportDiagnostics, { type: 'diagnostics/export' }],
      [text.checkUpdate, { type: 'update/check' }],
      [text.installUpdate, { type: 'update/install' }],
    ] as const;
    for (const [name, command] of cases) {
      await user.click(screen.getByRole('button', { name }));
      expect(fake.sendCommand).toHaveBeenLastCalledWith(command);
    }
    const on = snapshot(2);
    on.doNotDisturb = { mode: 'untilOff' };
    fake.pushSnapshot(on);
    await user.click(screen.getByRole('button', { name: text.doNotDisturbEnd }));
    expect(fake.sendCommand).toHaveBeenLastCalledWith({ type: 'doNotDisturb/end' });

    const minutes = screen.getByLabelText<HTMLInputElement>(text.advanceMinutes);
    const advance = async (value: string) => {
      await user.clear(minutes);
      await user.type(minutes, value);
      await user.click(screen.getByRole('button', { name: text.advanceClock }));
    };
    await advance('480');
    expect(fake.sendCommand).toHaveBeenLastCalledWith({ type: 'debug/advanceClock', minutes: 480 });
    const calls = fake.sendCommand.mock.calls.length;
    for (const bad of ['0', '10081', '1.5']) {
      await advance(bad);
      expect(screen.getByRole('alert').textContent).toBe(text.advanceInvalid);
    }
    expect(fake.sendCommand).toHaveBeenCalledTimes(calls);
    await advance('10080');
    expect(fake.sendCommand).toHaveBeenLastCalledWith({
      type: 'debug/advanceClock',
      minutes: 10080,
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('显示勿扰、一键隐藏、该不该出声、时钟偏移和程序状态，过期的快照被丢掉', async () => {
    const fake = fakeBridge();
    render(<App bridge={fake.bridge} search="?panel=debug" />);
    await screen.findByText(text.quietState);
    expect(screen.getByText(text.doNotDisturbOff)).toBeTruthy();
    expect(screen.getByText(text.hideAllOff)).toBeTruthy();
    expect(screen.getByText(text.soundAllowed)).toBeTruthy();
    expect(screen.getByText(text.noClockOffset)).toBeTruthy();
    expect(await screen.findByText(text.shortcutOk('Ctrl+Alt+Shift+H'))).toBeTruthy();
    expect(screen.getByText(text.updateStates.neverChecked)).toBeTruthy();

    const busy = snapshot(3);
    busy.doNotDisturb = { mode: 'timed', until: busy.at + 30 * 60_000 };
    busy.hideAll = true;
    busy.silencedBy = ['doNotDisturb', 'quietHours', 'startupQuiet'];
    busy.clockOffsetMs = (1440 + 125) * 60_000;
    fake.pushSnapshot(busy);
    expect(screen.getByText(text.doNotDisturbUntil('12:30'))).toBeTruthy();
    expect(screen.getByText(text.hideAllOn)).toBeTruthy();
    expect(screen.getByText(text.soundSilenced('勿扰模式、安静时段、开机静默'))).toBeTruthy();
    expect(screen.getByText(text.clockOffsetValue(1, 2, 5))).toBeTruthy();
    fake.pushSnapshot(snapshot(2));
    expect(screen.getByText(text.hideAllOn)).toBeTruthy();

    fake.pushStatus(
      appStatus(2, {
        update: { state: 'downloading', version: '0.3.0', percent: 10 },
        hideAllShortcut: { accelerator: 'CommandOrControl+Alt+K', registered: false },
      }),
    );
    expect(screen.getByText(text.updateStates.downloading('0.3.0', 10))).toBeTruthy();
    expect(screen.getByText(text.shortcutBad('Ctrl+Alt+K'))).toBeTruthy();
    fake.pushStatus(appStatus(1));
    expect(screen.getByText(text.shortcutBad('Ctrl+Alt+K'))).toBeTruthy();

    fake.pushReport({
      at: 30,
      cats: [],
      audio: { playing: [{ cat: cat.id, sound: 'purr' }], suspended: false },
    });
    expect(screen.getByText(`${text.audio}：${cat.name} ${text.sounds.purr}`)).toBeTruthy();
  });
});
