import { describe, expect, it } from 'vitest';
import type { ContentCatalog } from '../../shared/core-api';
import type { Fact, GameCommand, StageCommand } from '../../shared/ipc';
import {
  CatSchema,
  ClipSchema,
  defaultGameState,
  defaultSettings,
  GameStateSchema,
  SettingsSchema,
  type Settings,
} from '../../shared/schemas';
import { createGameCore } from './index';

const now = 1_800_000_000_000;
// 北京时间
const utcOffsetMinutes = () => 480;

function catalog(): ContentCatalog {
  return {
    cats: Object.fromEntries(
      ['test-a', 'test-b'].map((id) => [
        id,
        {
          cat: CatSchema.parse({
            schemaVersion: 1,
            id,
            name: id,
            relativeSize: 1,
            personality: {
              activity: 0.5,
              clinginess: 0.5,
              initiative: 0.5,
              dominance: 0.5,
              patience: 0.5,
            },
            relationships: [],
            sounds: { meow: [], purr: [] },
          }),
          clips: [1, 2].map((variant) =>
            ClipSchema.parse({
              schemaVersion: 1,
              name: 'idle-stand',
              variant,
              kind: 'loop',
              fromPose: 'stand',
              toPose: 'stand',
              optional: false,
              video: 'clips/idle-stand.webm',
              hitMask: 'clips/idle-stand.hitmask.bin',
              hitMaskScale: 4,
              fps: 24,
              frameCount: 1,
              width: 32,
              height: 32,
              footAnchors: [{ x: 16, y: 32 }],
              mirrorable: true,
              facing: 'right',
              speed: 0,
              keypoints: {},
            }),
          ),
        },
      ]),
    ),
    disabled: [{ cat: 'test-disabled', problems: ['缺少必需片段'] }],
  };
}

function core() {
  return createGameCore({ content: catalog(), now, utcOffsetMinutes });
}

describe('core/game 的 M1 存档状态规则', () => {
  it('第一次运行使用定稿默认设置，只显示已加载的猫', () => {
    const game = core();
    expect(game.exportState()).toEqual(defaultGameState(['test-a', 'test-b']));
    expect(GameStateSchema.safeParse(game.exportState()).success).toBe(true);
    expect(
      createGameCore({ content: { cats: {}, disabled: [] }, now, utcOffsetMinutes }).exportState(),
    ).toEqual(defaultGameState([]));
  });

  it('停用和缺失的猫仍保留在存档和快照中，召唤时不会发给桌面层', () => {
    const state = defaultGameState(['test-a', 'test-disabled', 'test-removed']);
    state.settings.scale = 1.5;
    const game = createGameCore({ content: catalog(), state, now, utcOffsetMinutes });
    expect(game.exportState()).toEqual(state);
    expect(game.snapshot(now).settings).toEqual(state.settings);
    expect(game.handleCommand({ type: 'cat/summon' }, now)).toEqual({
      stageCommands: [{ type: 'cat/summon', cats: ['test-a'] }],
      stateChanged: false,
      snapshotChanged: false,
      problems: [],
    });
  });

  // 每个设置都必须独立触发存档和快照推送；新增字段时必须补一个非默认测试值。
  const changedSettings = {
    visibleCats: ['test-b', 'test-a'],
    scale: 2,
    floorDepth: 0,
    activityLevel: 'quiet',
    showInScreenCapture: true,
    purrEnabled: false,
    purrVolume: 0.2,
    meowEnabled: false,
    meowVolume: 0.9,
    quietHoursStart: '22:00',
    quietHoursEnd: '07:30',
    hideAllShortcut: 'Ctrl+Alt+K',
    launchAtLogin: false,
    autoUpdate: false,
    display: { id: 7, label: 'TEST', width: 2560, height: 1440 },
  } satisfies Settings;

  it.each(Object.keys(SettingsSchema.shape) as (keyof Settings)[])(
    '只修改设置 %s 也必须触发存档，快照包含新值；重复相同值无需存档',
    (key) => {
      const game = core();
      const before = game.exportState().settings;
      const patch = { [key]: changedSettings[key] };
      expect(changedSettings[key]).not.toEqual(before[key]);
      expect(game.handleCommand({ type: 'settings/update', patch }, now)).toEqual({
        stageCommands: [],
        stateChanged: true,
        snapshotChanged: true,
        problems: [],
      });
      const expected = { ...before, ...patch };
      expect(game.exportState().settings).toEqual(expected);
      expect(game.snapshot(now).settings).toEqual(expected);
      // 使用值相同的新数组和新对象，防止把引用变化误当成需要存档的设置变化。
      expect(
        game.handleCommand(
          {
            type: 'settings/update',
            patch: JSON.parse(JSON.stringify(game.exportState().settings)) as Settings,
          },
          now,
        ),
      ).toEqual({ stageCommands: [], stateChanged: false, snapshotChanged: false, problems: [] });
    },
  );

  it('空设置补丁不触发存档和快照推送', () => {
    const game = core();
    const before = game.exportState();
    expect(game.handleCommand({ type: 'settings/update', patch: {} }, now)).toEqual({
      stageCommands: [],
      stateChanged: false,
      snapshotChanged: false,
      problems: [],
    });
    expect(game.exportState()).toEqual(before);
  });

  it.each([
    { scale: 0.49 },
    { scale: 2.01 },
    { scale: NaN },
    { scale: Infinity },
    { floorDepth: -0.1 },
    { floorDepth: 1.1 },
    { visibleCats: ['Invalid ID'] },
    { activityLevel: 'unknown' },
    { showInScreenCapture: 'true' },
    { unknown: true },
    { scale: undefined },
    { hideAllShortcut: 'H' },
    { hideAllShortcut: 'CommandOrControl+Shift+F10' },
    { quietHoursStart: '24:00' },
    { meowVolume: 1.5 },
    { display: { id: 1, label: 'x', width: 0, height: 1 } },
  ])('不合法设置拒绝整条命令，不能偷偷应用其中合法字段：%j', (invalid) => {
    const game = core();
    const before = game.exportState();
    // 模拟 IPC 收到的数据；TypeScript 类型不能代替运行时 schema 校验。
    const command = {
      type: 'settings/update',
      patch: { showInScreenCapture: true, ...invalid },
    } as GameCommand;
    const result = game.handleCommand(command, now);
    expect(result.stateChanged).toBe(false);
    expect(result.stageCommands).toEqual([]);
    expect(result.problems.length).toBeGreaterThan(0);
    expect(result.problems.every((problem) => /[\u4e00-\u9fff]/u.test(problem))).toBe(true);
    expect(game.exportState()).toEqual(before);
  });

  it('显示和隐藏只改 visibleCats，重复命令不改状态，也不增加时间字段', () => {
    const game = core();
    const hide = { type: 'cat/setVisible', cat: 'test-a', visible: false } as const;
    const show = { ...hide, visible: true };
    expect(game.handleCommand(hide, now).stateChanged).toBe(true);
    expect(game.exportState()).toEqual(defaultGameState(['test-b']));
    expect(game.handleCommand(hide, now).stateChanged).toBe(false);
    expect(game.handleCommand(show, now).stateChanged).toBe(true);
    expect(game.exportState().settings.visibleCats).toEqual(['test-b', 'test-a']);
    expect(game.handleCommand(show, now).stateChanged).toBe(false);
  });

  it('设置允许隐藏全部猫，召唤全部时没有可显示的猫就不发送命令', () => {
    const game = core();
    expect(
      game.handleCommand({ type: 'settings/update', patch: { visibleCats: [] } }, now).stateChanged,
    ).toBe(true);
    expect(game.handleCommand({ type: 'cat/summon' }, now).stageCommands).toEqual([]);
  });

  it('召唤全部只包含显示中的已加载猫，同一只猫不重复召唤', () => {
    const game = core();
    game.handleCommand(
      { type: 'settings/update', patch: { visibleCats: ['test-b', 'test-b', 'test-removed'] } },
      now,
    );
    expect(game.handleCommand({ type: 'cat/summon' }, now).stageCommands).toEqual([
      { type: 'cat/summon', cats: ['test-b'] },
    ]);
  });

  const forwards: { input: GameCommand; expected: StageCommand }[] = [
    {
      input: { type: 'cat/summon', cat: 'test-a' },
      expected: { type: 'cat/summon', cats: ['test-a'] },
    },
    {
      input: { type: 'cat/summon', cat: 'test-b', to: { x: 24, y: 56 } },
      expected: { type: 'cat/summon', cats: ['test-b'], to: { x: 24, y: 56 } },
    },
    { input: { type: 'cat/sleep', cat: 'test-b' }, expected: { type: 'cat/sleep', cat: 'test-b' } },
    ...[undefined, 2].map((variant) => {
      const command: GameCommand & StageCommand = {
        type: 'debug/playClip',
        cat: 'test-a',
        clip: 'idle-stand',
        ...(variant === undefined ? {} : { variant }),
      };
      return { input: command, expected: command };
    }),
    ...(['poke', 'pet', 'pickUp', 'drop', 'nearbyClicks'] as const).map((interaction) => {
      const command: GameCommand & StageCommand = {
        type: 'debug/simulate',
        cat: 'test-b',
        interaction,
      };
      return { input: command, expected: command };
    }),
    ...(['meow', 'purr'] as const).map((sound) => {
      const command: GameCommand & StageCommand = { type: 'debug/sound', cat: 'test-a', sound };
      return { input: command, expected: command };
    }),
    { input: { type: 'debug/entrance' }, expected: { type: 'cat/entrance' } },
  ];

  it.each(forwards)(
    '召唤、睡觉和调试由桌面层执行，不改存档：$input.type',
    ({ input, expected }) => {
      const game = core();
      const before = game.exportState();
      expect(game.handleCommand(input, now)).toEqual({
        stageCommands: [expected],
        stateChanged: false,
        snapshotChanged: false,
        problems: [],
      });
      expect(game.exportState()).toEqual(before);
    },
  );

  it.each(['test-disabled', 'test-removed', 'toString'])(
    '拒绝未加载猫的命令，并指出猫 id：%s',
    (cat) => {
      const game = core();
      const commands: GameCommand[] = [
        { type: 'cat/setVisible', cat, visible: true },
        { type: 'cat/setVisible', cat, visible: false },
        { type: 'cat/summon', cat },
        { type: 'cat/sleep', cat },
        { type: 'debug/playClip', cat, clip: 'idle-stand' },
        { type: 'debug/simulate', cat, interaction: 'pet' },
        { type: 'debug/sound', cat, sound: 'meow' },
      ];
      const before = game.exportState();
      for (const command of commands) {
        const result = game.handleCommand(command, now);
        expect(result.stageCommands).toEqual([]);
        expect(result.stateChanged).toBe(false);
        expect(result.problems[0]).toContain(`猫「${cat}」`);
      }
      expect(game.exportState()).toEqual(before);
    },
  );

  it('隐藏猫不接收召唤、睡觉和调试命令，先显示再执行', () => {
    const game = core();
    game.handleCommand({ type: 'cat/setVisible', cat: 'test-a', visible: false }, now);
    const commands: GameCommand[] = [
      { type: 'cat/summon', cat: 'test-a' },
      { type: 'cat/sleep', cat: 'test-a' },
      { type: 'debug/playClip', cat: 'test-a', clip: 'idle-stand' },
      { type: 'debug/simulate', cat: 'test-a', interaction: 'pet' },
      { type: 'debug/sound', cat: 'test-a', sound: 'purr' },
    ];
    for (const command of commands) {
      const result = game.handleCommand(command, now);
      expect(result.stageCommands).toEqual([]);
      expect(result.stateChanged).toBe(false);
      expect(result.problems[0]).toContain('已隐藏');
    }
  });

  it.each([{ clip: 'missing' }, { clip: 'idle-stand', variant: 3 }])(
    '缺少调试片段或版本时给出猫和片段的中文原因：%j',
    (selection) => {
      const result = core().handleCommand(
        { type: 'debug/playClip', cat: 'test-a', ...selection },
        now,
      );
      expect(result.stageCommands).toEqual([]);
      expect(result.stateChanged).toBe(false);
      expect(result.problems[0]).toContain('猫「test-a」');
      expect(result.problems[0]).toContain(`缺少片段「${selection.clip}」`);
    },
  );

  it('快照每次生成都递增 revision，时间倒退也能丢弃旧快照', () => {
    const game = core();
    expect(game.snapshot(now)).toEqual({
      revision: 1,
      at: now,
      settings: game.exportState().settings,
      doNotDisturb: { mode: 'off' },
      hideAll: false,
      silencedBy: [],
      clockOffsetMs: 0,
    });
    expect(game.snapshot(now).revision).toBe(2);
    game.handleCommand({ type: 'settings/update', patch: { scale: 1.5 } }, now);
    expect(game.snapshot(now - 1000)).toMatchObject({
      revision: 3,
      at: now - 1000,
      settings: game.exportState().settings,
    });
  });

  it.each([8 * 60 * 60 * 1000, -8 * 60 * 60 * 1000])(
    '时间跳变 %i 毫秒不会自动改变 M1 状态，命令仍能执行',
    (elapsed) => {
      const game = core();
      game.handleCommand({ type: 'cat/setVisible', cat: 'test-a', visible: false }, now);
      const before = game.exportState();
      const later = now + elapsed;
      expect(game.snapshot(later).settings).toEqual(before.settings);
      expect(game.handleCommand({ type: 'cat/summon' }, later).stageCommands).toEqual([
        { type: 'cat/summon', cats: ['test-b'] },
      ]);
      expect(game.exportState()).toEqual(before);
      expect(
        game.handleCommand({ type: 'cat/setVisible', cat: 'test-a', visible: true }, later)
          .stateChanged,
      ).toBe(true);
    },
  );

  it('M1 的互动事实不写入未来阶段的需求、亲密度或时间戳', () => {
    const game = core();
    const before = game.exportState();
    const facts: Fact[] = [
      { type: 'cat/petted', cat: 'test-a', durationMs: 3000, at: now },
      { type: 'cat/poked', cat: 'test-a', at: now },
      { type: 'cat/pickedUp', cat: 'test-b', at: now },
      { type: 'cat/dropped', cat: 'test-b', at: now },
    ];
    for (const fact of facts) {
      expect(game.handleFact(fact, now + 8 * 60 * 60 * 1000)).toEqual({
        stageCommands: [],
        stateChanged: false,
        snapshotChanged: false,
        problems: [],
      });
    }
    expect(game.exportState()).toEqual(before);
  });

  it('调用方不能通过初始存档、设置补丁、快照或导出状态偷偷修改核心状态', () => {
    const state = defaultGameState(['test-a']);
    const game = createGameCore({ content: catalog(), state, now, utcOffsetMinutes });
    state.settings.visibleCats.push('test-b');
    state.settings.scale = 2;
    expect(game.exportState().settings).toEqual(defaultSettings(['test-a']));
    const patch = { visibleCats: ['test-b'] };
    game.handleCommand({ type: 'settings/update', patch }, now);
    patch.visibleCats.length = 0;
    const snapshot = game.snapshot(now);
    snapshot.settings.visibleCats.length = 0;
    snapshot.settings.scale = 2;
    const exported = game.exportState();
    exported.settings.visibleCats.push('test-a');
    exported.settings.scale = 0.5;
    expect(game.exportState().settings).toEqual(defaultSettings(['test-b']));
  });

  it('桌面层命令和原始命令也不能修改核心的显示列表', () => {
    const game = core();
    const command = { type: 'cat/summon', to: { x: 1, y: 2 } } as const;
    const result = game.handleCommand(command, now);
    const forwarded = result.stageCommands[0];
    if (forwarded?.type !== 'cat/summon') throw new Error('召唤未转发');
    forwarded.cats.length = 0;
    if (forwarded.to) forwarded.to.x = 100;
    expect(command.to.x).toBe(1);
    expect(game.exportState().settings.visibleCats).toEqual(['test-a', 'test-b']);
  });
});

describe('core/game 的显示器设置', () => {
  it('显示器设置按内容比较，导出的是副本', () => {
    const game = core();
    const display = { id: 3, label: 'TEST', width: 1920, height: 1080 };
    expect(
      game.handleCommand({ type: 'settings/update', patch: { display } }, now).stateChanged,
    ).toBe(true);
    display.width = 1;
    expect(game.exportState().settings.display).toEqual({
      id: 3,
      label: 'TEST',
      width: 1920,
      height: 1080,
    });
    const exported = game.exportState();
    if (exported.settings.display) exported.settings.display.height = 1;
    expect(game.exportState().settings.display?.height).toBe(1080);
    expect(
      game.handleCommand({ type: 'settings/update', patch: { display: null } }, now).stateChanged,
    ).toBe(true);
  });
});

describe('一键隐藏 HideAll 与召唤 Summon', () => {
  it('切换只更新快照，恢复发送入场；不修改显示偏好，重启不隐藏', () => {
    const game = core();
    const state = game.exportState();
    expect(game.handleCommand({ type: 'hideAll/toggle' }, now)).toEqual({
      stageCommands: [],
      stateChanged: false,
      snapshotChanged: true,
      problems: [],
    });
    expect(game.snapshot(now).hideAll).toBe(true);
    expect(game.exportState()).toEqual(state);
    const restarted = createGameCore({
      content: catalog(),
      state: game.exportState(),
      now,
      utcOffsetMinutes,
    });
    expect(restarted.snapshot(now).hideAll).toBe(false);
    expect(game.handleCommand({ type: 'hideAll/toggle' }, now)).toEqual({
      stageCommands: [{ type: 'cat/entrance' }],
      stateChanged: false,
      snapshotChanged: true,
      problems: [],
    });
    expect(game.snapshot(now).hideAll).toBe(false);
  });

  it.each([undefined, 'test-b'])('隐藏时召唤 %s 先入场再召唤，勿扰保持有效', (cat) => {
    const game = core();
    game.handleCommand({ type: 'doNotDisturb/start', duration: 'untilOff' }, now);
    game.handleCommand({ type: 'hideAll/toggle' }, now);
    const before = game.exportState();
    const command: GameCommand = {
      type: 'cat/summon',
      ...(cat === undefined ? {} : { cat }),
      to: { x: 10, y: 20 },
    };
    expect(game.handleCommand(command, now)).toEqual({
      stageCommands: [
        { type: 'cat/entrance' },
        {
          type: 'cat/summon',
          cats: cat === undefined ? ['test-a', 'test-b'] : [cat],
          to: { x: 10, y: 20 },
        },
      ],
      stateChanged: false,
      snapshotChanged: true,
      problems: [],
    });
    expect(game.snapshot(now)).toMatchObject({
      hideAll: false,
      doNotDisturb: { mode: 'untilOff' },
      silencedBy: ['doNotDisturb'],
    });
    expect(game.exportState()).toEqual(before);
  });

  it('拒绝对未加载或单独隐藏猫的召唤，不能顺带取消一键隐藏', () => {
    const game = core();
    game.handleCommand({ type: 'cat/setVisible', cat: 'test-b', visible: false }, now);
    game.handleCommand({ type: 'hideAll/toggle' }, now);
    for (const cat of ['missing', 'test-b']) {
      expect(game.handleCommand({ type: 'cat/summon', cat }, now)).toMatchObject({
        stageCommands: [],
        stateChanged: false,
        snapshotChanged: false,
      });
      expect(game.snapshot(now).hideAll).toBe(true);
    }
  });

  it('没有可召唤的猫时也能结束一键隐藏，不改变单独隐藏的偏好', () => {
    const game = core();
    game.handleCommand({ type: 'settings/update', patch: { visibleCats: [] } }, now);
    game.handleCommand({ type: 'hideAll/toggle' }, now);
    expect(game.handleCommand({ type: 'cat/summon' }, now)).toEqual({
      stageCommands: [{ type: 'cat/entrance' }],
      stateChanged: false,
      snapshotChanged: true,
      problems: [],
    });
    expect(game.snapshot(now).hideAll).toBe(false);
    expect(game.exportState().settings.visibleCats).toEqual([]);
  });
});
