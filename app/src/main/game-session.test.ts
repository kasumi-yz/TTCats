import { mkdtempSync, readFileSync, readdirSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadContent } from './content';
import { createGameSession } from './game-session';
import { SaveStore } from './save';
import { CURRENT_SAVE_VERSION, defaultGameState, GameStateSchema } from '../shared/schemas';
import type { StateSnapshot } from '../shared/ipc';
import { CommandSchema, FactSchema } from './messages';

const directories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function setup() {
  vi.useFakeTimers();
  const directory = mkdtempSync(join(import.meta.dirname, '../../../test-results-session-'));
  directories.push(directory);
  const content = loadContent(join(import.meta.dirname, '../../..', 'test-content'));
  const state = defaultGameState(Object.keys(content.cats));
  const save = new SaveStore({
    directory,
    currentVersion: CURRENT_SAVE_VERSION,
    schema: GameStateSchema,
    defaultState: () => state,
    now: () => Date.now(),
    log: vi.fn(),
  });
  const publish = vi.fn<(snapshot: StateSnapshot) => void>();
  const session = createGameSession({
    content,
    state,
    save,
    now: () => Date.now(),
    publish,
    log: vi.fn(),
  });
  const disk = () =>
    GameStateSchema.parse(
      (JSON.parse(readFileSync(save.file, 'utf8')) as { state: unknown }).state,
    );
  return { content, state, save, session, publish, disk };
}

describe('主进程游戏会话', () => {
  it('无变化退出不轮换备份，保留上一份正常存档供安全模式回退', () => {
    const { session, save, disk } = setup();
    session.command({ type: 'settings/update', patch: { scale: 1.2 } });
    session.flush();
    session.command({ type: 'settings/update', patch: { scale: 1.5 } });
    vi.advanceTimersByTime(1500);
    const original = readFileSync(save.file, 'utf8');
    const modified = statSync(save.file).mtimeMs;
    const files = readdirSync(dirname(save.file));
    for (let count = 0; count < 5; count++) {
      session.command({ type: 'cat/summon' });
      session.command({ type: 'settings/update', patch: { scale: 1.5 } });
      session.flush();
    }
    expect(readFileSync(save.file, 'utf8')).toBe(original);
    expect(statSync(save.file).mtimeMs).toBe(modified);
    expect(readdirSync(dirname(save.file))).toEqual(files);
    expect(save.loadLatestBackup()?.state.settings.scale).toBe(1.2);
    expect(disk().settings.scale).toBe(1.5);
  });

  it('窗口通知抛错也不能丢掉已经发生的设置变化', () => {
    const { session, publish, disk } = setup();
    publish.mockImplementation(() => {
      throw new Error('窗口已关闭');
    });
    expect(() => session.command({ type: 'settings/update', patch: { scale: 1.5 } })).toThrow();
    vi.advanceTimersByTime(1500);
    expect(disk().settings.scale).toBe(1.5);
  });
  it('只在设置变化后推送与合并写盘，退出立即保存最后一次修改', () => {
    const { session, publish, disk } = setup();
    session.command({ type: 'cat/summon' });
    expect(publish).not.toHaveBeenCalled();
    session.command({ type: 'settings/update', patch: { scale: 1.5 } });
    session.command({ type: 'settings/update', patch: { floorDepth: 0.8 } });
    expect(publish).toHaveBeenCalledTimes(2);
    session.flush();
    expect(disk().settings).toMatchObject({ scale: 1.5, floorDepth: 0.8 });
  });

  it('安全模式回退只替换内存，先前排队的正常写入与退出不覆盖回退或用户偏好', () => {
    const { session, content, state, save, disk, publish } = setup();
    save.requestSave(state);
    session.flush();
    session.command({ type: 'settings/update', patch: { scale: 1.5 } });
    session.flush();
    const backup = save.loadLatestBackup();
    expect(backup).not.toBeNull();
    session.command({ type: 'settings/update', patch: { scale: 1.8 } });
    const previous = session.snapshot();
    const disabledCats = [...state.settings.visibleCats];
    session.suspendSaving();
    session.applySafeMode({ state: backup?.state ?? state, disabledCats, source: 'backup' });
    expect(session.safeMode).toBe(true);
    expect(session.snapshot().revision).toBeGreaterThan(previous.revision);
    expect(session.snapshot().settings).toEqual(state.settings);
    expect(content.cats).toEqual({});
    expect(content.disabled.map((pack) => pack.cat)).toEqual(disabledCats);
    expect(disk().settings.scale).toBe(1.8);
    session.command({ type: 'settings/update', patch: { scale: 0.7 } });
    expect(publish.mock.lastCall?.[0].settings.scale).toBe(0.7);
    vi.advanceTimersByTime(5000);
    session.flush();
    expect(disk().settings.scale).toBe(1.8);
    expect(disk().settings.visibleCats).toEqual(disabledCats);
  });

  it('恢复失败时停止提交正常存档，原队列仍可在退出时完成', () => {
    const { session, disk } = setup();
    session.command({ type: 'settings/update', patch: { scale: 1.4 } });
    session.suspendSaving();
    session.command({ type: 'settings/update', patch: { scale: 1.9 } });
    session.flush();
    expect(disk().settings.scale).toBe(1.4);
  });

  it('新版存档只供查看，退出不改写原件', () => {
    const { session, save } = setup();
    const original = JSON.stringify({ saveVersion: 999, savedAt: 123, state: {} });
    writeFileSync(save.file, original);
    save.load();
    session.command({ type: 'settings/update', patch: { scale: 1.4 } });
    session.flush();
    expect(readFileSync(save.file, 'utf8')).toBe(original);
  });
});

describe('窗口消息校验', () => {
  it('拒绝坏设置、伪造类型和无效坐标，避免 IPC 破坏主进程', () => {
    for (const payload of [
      null,
      { type: 'settings/update', patch: { scale: 10 } },
      { type: 'unknown' },
      { type: 'cat/summon', to: { x: Infinity, y: 0 } },
    ]) {
      expect(CommandSchema.safeParse(payload).success).toBe(false);
    }
    expect(CommandSchema.safeParse({ type: 'debug/crashOverlay' }).success).toBe(true);
    expect(
      FactSchema.safeParse({ type: 'cat/petted', cat: 'test-a', at: 1, durationMs: -1 }).success,
    ).toBe(false);
  });

  it('M2 的命令：合法的能通过，坏快捷键、超范围的快进、不认识的时长和声音被拒绝', () => {
    for (const payload of [
      { type: 'settings/update', patch: { hideAllShortcut: 'Ctrl+Alt+K', meowVolume: 0.5 } },
      { type: 'doNotDisturb/start', duration: '2h' },
      { type: 'doNotDisturb/end' },
      { type: 'hideAll/toggle' },
      { type: 'debug/advanceClock', minutes: 30 },
      { type: 'debug/sound', cat: 'test-a', sound: 'purr' },
      { type: 'debug/simulate', cat: 'test-a', interaction: 'nearbyClicks' },
      { type: 'debug/simulateFullscreen', active: true },
      { type: 'photo/take' },
    ]) {
      expect(CommandSchema.safeParse(payload).success).toBe(true);
    }
    for (const payload of [
      ...['Ctrl+__proto__', 'Ctrl+constructor', 'Ctrl+__proto__+H', 'Ctrl+constructor+H'].map(
        (hideAllShortcut) => ({ type: 'settings/update', patch: { hideAllShortcut } }),
      ),
      { type: 'settings/update', patch: { hideAllShortcut: 'Ctrl+Shift+F10' } },
      { type: 'doNotDisturb/start', duration: '45m' },
      { type: 'debug/advanceClock', minutes: 0 },
      { type: 'debug/advanceClock', minutes: 7 * 24 * 60 + 1 },
      { type: 'debug/advanceClock', minutes: 1.5 },
      { type: 'debug/sound', cat: 'test-a', sound: 'hiss' },
      { type: 'photo/take', path: 'C:/x.png' },
    ]) {
      expect(CommandSchema.safeParse(payload).success).toBe(false);
    }
  });
});
