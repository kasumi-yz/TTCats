import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports -- 临时目录仅用于测试。
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { catalog, testCat } from '../../core/stage/test-fixtures';
import { zh } from '../../shared/strings.zh-CN';
import { createDiagnosticsExport, DIAGNOSTICS_FILES, redact, timestamp } from '.';

const home = 'C:\\Users\\Zhang San';
const username = 'zhangsan';
const native = vi.hoisted(() => ({
  showSaveDialog: vi.fn(),
  showMessageBox: vi.fn(),
  showItemInFolder: vi.fn(),
  getGPUInfo: vi.fn(),
}));
vi.mock('electron', () => {
  const display = {
    id: 7,
    label: '内置屏幕',
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    size: { width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    scaleFactor: 1.5,
    rotation: 0,
    internal: true,
  };
  return {
    app: {
      getPath: (name: string) =>
        name === 'home' ? 'C:\\Users\\Zhang San' : 'C:\\Users\\Zhang San\\Desktop',
      getVersion: () => '1.2.3',
      isPackaged: false,
      getGPUInfo: native.getGPUInfo,
      getLocale: () => 'zh-CN',
      getSystemLocale: () => 'zh-CN',
      getPreferredSystemLanguages: () => ['zh-Hans-CN'],
    },
    dialog: { showSaveDialog: native.showSaveDialog, showMessageBox: native.showMessageBox },
    shell: { showItemInFolder: native.showItemInFolder },
    screen: {
      getPrimaryDisplay: () => display,
      getAllDisplays: () => [display],
      getDisplayMatching: () => display,
    },
  };
});

let directory: string;
// Node 里没有 Electron 给 process 加的系统查询。
Object.assign(process, {
  getSystemVersion: () => '10.0.26200',
  getSystemMemoryInfo: () => ({ total: 16_000_000, free: 8_000_000 }),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('USERNAME', username);
  directory = mkdtempSync(join(tmpdir(), 'ttcats-diagnostics-'));
  native.getGPUInfo.mockResolvedValue({ gpuDevice: [{ vendorId: 4318 }] });
  native.showMessageBox.mockResolvedValue({ response: 0 });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

function setup(overrides: { save?: boolean; stopping?: boolean } = {}) {
  const logs = join(directory, 'logs');
  mkdirSync(logs);
  // 日志每行是 JSON 字符串，反斜杠会被转义成两个。
  writeFileSync(
    join(logs, 'main.log'),
    `1 ${JSON.stringify(`无法加载 ${home}\\AppData\\Roaming\\TTCats\\cats\\a.webm`)}\n` +
      `2 ${JSON.stringify(`file:///C:/Users/Zhang%20San/x.png，用户 ZhangSan 和 ${username} 登录`)}\n`,
  );
  writeFileSync(join(logs, 'main.log.1'), `0 "C:\\\\Users\\\\ZHANGS~1\\\\temp"\n`);
  const saveFile = join(directory, 'save.json');
  if (overrides.save !== false) writeFileSync(saveFile, '{"saveVersion":2,"state":{}}');
  const content = catalog([{ cat: testCat('doudou', { name: '豆豆' }) }]);
  content.disabled.push({ cat: 'kubo', problems: ['库啵：缺少片段 idle。'] });
  const report = vi.fn<(message: string) => void>();
  const target = join(directory, 'out', 'diag.zip');
  mkdirSync(join(directory, 'out'));
  native.showSaveDialog.mockResolvedValue({ canceled: false, filePath: target });
  const run = createDiagnosticsExport({
    logDirectory: logs,
    saveFile,
    contentDirectory: `${home}\\AppData\\Local\\Programs\\TTCats\\content`,
    content,
    safeMode: () => true,
    stopping: () => overrides.stopping === true,
    overlayWindow: () => undefined,
    report,
    now: () => new Date(2026, 9, 2, 15, 30, 45).getTime(),
  });
  const files = (): Record<string, string> =>
    Object.fromEntries(
      Object.entries(unzipSync(readFileSync(target))).map(([name, data]) => [
        name,
        strFromU8(data),
      ]),
    );
  return { run, report, target, files };
}

describe('诊断信息导出', () => {
  it('默认存到桌面，压缩包里文件齐全，完成后在文件夹里选中', async () => {
    const { run, target, files } = setup();
    await run();
    expect(native.showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: join('C:\\Users\\Zhang San\\Desktop', 'TTCats-诊断-20261002-153045.zip'),
      }),
    );
    expect(Object.keys(files()).sort()).toEqual(
      [
        DIAGNOSTICS_FILES.readme,
        DIAGNOSTICS_FILES.save,
        DIAGNOSTICS_FILES.version,
        DIAGNOSTICS_FILES.system,
        DIAGNOSTICS_FILES.content,
        'logs/main.log',
        'logs/main.log.1',
      ].sort(),
    );
    const zip = files();
    const version = JSON.parse(zip[DIAGNOSTICS_FILES.version] ?? '') as Record<string, unknown>;
    expect(version).toMatchObject({ app: '1.2.3', isPackaged: false });
    expect(version['electron']).toBe(process.versions.electron);
    const system = JSON.parse(zip[DIAGNOSTICS_FILES.system] ?? '') as {
      displays: { id: number; scaleFactor: number; primary: boolean }[];
      gpu: unknown;
      locale: { system: string };
      os: unknown;
    };
    expect(system.displays).toEqual([expect.objectContaining({ id: 7, scaleFactor: 1.5 })]);
    expect(system.gpu).toEqual({ gpuDevice: [{ vendorId: 4318 }] });
    expect(system.locale.system).toBe('zh-CN');
    expect(system.os).toMatchObject({ version: '10.0.26200' });
    expect(zip[DIAGNOSTICS_FILES.readme]).toContain(DIAGNOSTICS_FILES.system);
    expect(native.showItemInFolder).toHaveBeenCalledWith(target);
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });

  it('所有文件里的用户目录和用户名都被替换，包括日志里转义过的路径', async () => {
    const { run, files } = setup();
    await run();
    const zip = files();
    for (const [name, body] of Object.entries(zip)) {
      expect(body, name).not.toMatch(/zhang|ZHANGS~1/i);
    }
    expect(zip['logs/main.log']).toContain('%USERPROFILE%\\\\AppData');
    expect(zip['logs/main.log']).toContain('file:///%USERPROFILE%/x.png');
    expect(zip['logs/main.log.1']).toContain(zh.diagnostics.userPlaceholder);
    expect(zip[DIAGNOSTICS_FILES.content]).toContain('%USERPROFILE%');
  });

  it('写入加载的猫、片段数和被停用的猫咪包及中文原因', async () => {
    const { run, files } = setup();
    await run();
    const content = JSON.parse(files()[DIAGNOSTICS_FILES.content] ?? '') as unknown;
    expect(content).toMatchObject({
      safeMode: true,
      cats: [{ id: 'doudou', name: '豆豆', clips: expect.any(Number) as number }],
      disabled: [{ cat: 'kubo', problems: ['库啵：缺少片段 idle。'] }],
    });
  });

  it('没有存档时说明里写明，不放 save.json', async () => {
    const { run, files } = setup({ save: false });
    await run();
    const zip = files();
    expect(zip[DIAGNOSTICS_FILES.save]).toBeUndefined();
    expect(zip[DIAGNOSTICS_FILES.readme]).toContain(zh.diagnostics.noSave);
  });

  it('取消保存不写文件；退出过程中拒绝导出', async () => {
    const canceled = setup();
    native.showSaveDialog.mockResolvedValue({ canceled: true, filePath: '' });
    await canceled.run();
    expect(existsSync(canceled.target)).toBe(false);
    expect(canceled.report).toHaveBeenCalledWith(zh.diagnostics.canceled);
    rmSync(join(directory, 'logs'), { recursive: true });
    rmSync(join(directory, 'out'), { recursive: true });
    const stopping = setup({ stopping: true });
    native.showSaveDialog.mockClear();
    await stopping.run();
    expect(native.showSaveDialog).not.toHaveBeenCalled();
    expect(stopping.report).toHaveBeenCalledWith(zh.diagnostics.stopping);
  });

  it('写入失败时中文提示并写日志，导出中重复命令被忽略', async () => {
    const { run, report } = setup();
    native.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: join(directory, 'missing', 'diag.zip'),
    });
    let release: () => void = () => {};
    native.getGPUInfo.mockReturnValue(
      new Promise((resolve) => {
        release = () => {
          resolve({});
        };
      }),
    );
    const first = run();
    await vi.waitFor(() => {
      expect(native.getGPUInfo).toHaveBeenCalled();
    });
    await run();
    expect(report).toHaveBeenCalledWith(zh.diagnostics.busy);
    release();
    await first;
    expect(report).toHaveBeenCalledWith(expect.stringContaining('导出诊断信息失败'));
    expect(native.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', title: zh.diagnostics.failedTitle }),
    );
    expect(native.showItemInFolder).not.toHaveBeenCalled();
  });
});

describe('隐私替换', () => {
  const privacy = { home: 'C:\\Users\\a.b', username: 'a.b' };
  it('不同写法的用户目录都替换，公共目录保留', () => {
    expect(redact('C:\\Users\\A.B\\x c:/users/a.b/y C:\\\\Users\\\\a.b\\\\z', privacy)).toBe(
      '%USERPROFILE%\\x %USERPROFILE%/y %USERPROFILE%\\\\z',
    );
    expect(redact('C:\\Users\\Public\\x D:\\Users\\other\\y', privacy)).toBe(
      'C:\\Users\\Public\\x D:\\Users\\<用户名>\\y',
    );
    expect(redact('D:/Users/Li Si/x', privacy)).toBe('D:/Users/<用户名>/x');
  });
  it('用户名只替换完整的词，正则特殊字符按字面匹配', () => {
    expect(redact('a.b 登录，axb 和 a.bc 不是', privacy)).toBe('<用户名> 登录，axb 和 a.bc 不是');
  });
});

describe('文件名时间', () => {
  it('用本地时间，补零', () => {
    expect(timestamp(new Date(2026, 0, 2, 3, 4, 5).getTime())).toBe('20260102-030405');
  });
});
