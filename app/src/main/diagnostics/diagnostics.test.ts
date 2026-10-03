import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
// eslint-disable-next-line no-restricted-imports -- 临时目录仅用于测试。
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { catalog, testCat } from '../../core/stage/test-fixtures';
import { zh } from '../../shared/strings.zh-CN';
import type { SystemInfo } from '../platform';
import {
  createDiagnosticsExport,
  DIAGNOSTICS_FILES,
  redact,
  timestamp,
  writeFileReplacing,
} from '.';

const home = 'C:\\Users\\Zhang San';
const username = 'zhangsan';
const placeholder = zh.diagnostics.userPlaceholder;
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
      getPath: () => 'C:\\Users\\Zhang San\\Desktop',
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

const system: SystemInfo = {
  home,
  username,
  os: { version: 'Windows 11 Home', release: '10.0.26200', arch: 'x64' },
  cpu: { model: 'Test CPU', cores: 8 },
  memory: { totalBytes: 16_000_000_000, freeBytes: 8_000_000_000 },
};
let directory: string;
beforeEach(() => {
  vi.clearAllMocks();
  directory = mkdtempSync(join(tmpdir(), 'ttcats-diagnostics-'));
  native.getGPUInfo.mockResolvedValue({ gpuDevice: [{ vendorId: 4318 }] });
  native.showMessageBox.mockResolvedValue({ response: 0 });
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function setup(overrides: { save?: boolean; stopping?: boolean } = {}) {
  const logs = join(directory, 'logs');
  mkdirSync(logs);
  // 日志每行是 JSON 字符串，反斜杠会被转义成两个。
  writeFileSync(
    join(logs, 'main.log'),
    `1 ${JSON.stringify(`无法加载 ${home}\\AppData\\Roaming\\TTCats\\cats\\a.webm`)}\n` +
      `2 ${JSON.stringify(`file:///C:/Users/Zhang%20San/x.png，用户 ZhangSan 和 ${username} 登录`)}\n` +
      `3 ${JSON.stringify(`打开 "${home}" 失败，句末 ${home}`)}\n`,
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
    system: () => system,
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
    const info = JSON.parse(zip[DIAGNOSTICS_FILES.system] ?? '') as {
      displays: { id: number; scaleFactor: number; primary: boolean }[];
      gpu: unknown;
      locale: { system: string };
    };
    expect(info.displays).toEqual([expect.objectContaining({ id: 7, scaleFactor: 1.5 })]);
    expect(info.gpu).toEqual({ gpuDevice: [{ vendorId: 4318 }] });
    expect(info.locale.system).toBe('zh-CN');
    expect(info).toMatchObject({
      os: { release: '10.0.26200' },
      cpu: { model: 'Test CPU', cores: 8 },
    });
    expect(info).not.toHaveProperty('home');
    expect(info).not.toHaveProperty('username');
    expect(zip[DIAGNOSTICS_FILES.readme]).toContain(DIAGNOSTICS_FILES.system);
    expect(native.showItemInFolder).toHaveBeenCalledWith(target);
    expect(readdirSync(join(directory, 'out'))).toEqual(['diag.zip']);
  });

  it('所有文件里的用户目录和用户名都被替换，包括日志里转义过的路径', async () => {
    const { run, files } = setup();
    await run();
    const zip = files();
    for (const [name, body] of Object.entries(zip)) {
      expect(body, name).not.toMatch(/zhang|ZHANGS~1|San\b/i);
    }
    expect(zip['logs/main.log']).toContain('%USERPROFILE%\\\\AppData');
    expect(zip['logs/main.log']).toContain('file:///%USERPROFILE%/x.png');
    expect(zip['logs/main.log']).toContain('打开 \\"%USERPROFILE%\\" 失败');
    expect(zip['logs/main.log.1']).toContain(placeholder);
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
  it('不同写法的当前用户目录都替换', () => {
    expect(redact('C:\\Users\\A.B\\x c:/users/a.b/y C:\\\\Users\\\\a.b\\\\z', privacy)).toBe(
      '%USERPROFILE%\\x %USERPROFILE%/y %USERPROFILE%\\\\z',
    );
    expect(redact('"C:\\Users\\a.b"', privacy)).toBe('"%USERPROFILE%"');
    expect(redact('C:\\Users\\a.b', privacy)).toBe('%USERPROFILE%');
    // 后面紧跟普通文字时分不清名字在哪结束，整段按兜底换掉。
    expect(redact('打开 C:\\Users\\a.b。', { ...privacy, username: '' })).toBe(
      `打开 C:\\Users\\${placeholder}`,
    );
  });
  it('当前用户目录只按完整路径组件匹配，不抢先替换前缀相同的其他账户', () => {
    const ann = { home: 'C:\\Users\\Ann', username: '' };
    expect(redact('C:\\Users\\Anna\\x C:\\Users\\Ann\\y', ann)).toBe(
      `C:\\Users\\${placeholder}\\x %USERPROFILE%\\y`,
    );
  });
  it('其他账户：带空格、句末、引号包围、JSON 转义、中文名都整段换掉', () => {
    const other = { home: 'C:\\Users\\me', username: 'me' };
    const cases: [string, string][] = [
      ['C:\\Users\\wang wu', `C:\\Users\\${placeholder}`],
      ['日志：C:\\Users\\wang wu 登录失败', `日志：C:\\Users\\${placeholder}`],
      ['"D:\\Users\\Li Si"', `"D:\\Users\\${placeholder}"`],
      ['D:/Users/Li Si/x', `D:/Users/${placeholder}/x`],
      [JSON.stringify('C:\\Users\\Li Si'), JSON.stringify(`C:\\Users\\${placeholder}`)],
      [JSON.stringify('"C:\\Users\\Li Si"'), JSON.stringify(`"C:\\Users\\${placeholder}"`)],
      [JSON.stringify('C:\\Users\\Li Si\\a'), JSON.stringify(`C:\\Users\\${placeholder}\\a`)],
      ['C:\\Users\\张 三\\桌面', `C:\\Users\\${placeholder}\\桌面`],
      ['C:\\Users\\ZHANGS~1\\temp', `C:\\Users\\${placeholder}\\temp`],
      ['C:\\Users\\Public\\x', 'C:\\Users\\Public\\x'],
    ];
    for (const [source, expected] of cases) expect(redact(source, other), source).toBe(expected);
  });
  it('用户名按完整的词替换；中文用户名紧挨汉字也换掉', () => {
    expect(redact('a.b 登录，axb 和 a.bc 不是', privacy)).toBe(
      `${placeholder} 登录，axb 和 a.bc 不是`,
    );
    expect(redact('用户张三登录', { home: 'C:\\Users\\张三', username: '张三' })).toBe(
      `用户${placeholder}登录`,
    );
  });
});

describe('写入压缩包', () => {
  it('目录里原有的同名临时文件保持不变，成功后只多出目标文件', () => {
    const target = join(directory, 'report.zip');
    writeFileSync(`${target}.tmp`, 'user data');
    writeFileReplacing(target, new Uint8Array([1, 2, 3]));
    expect(readFileSync(`${target}.tmp`, 'utf8')).toBe('user data');
    expect([...readFileSync(target)]).toEqual([1, 2, 3]);
    expect(readdirSync(directory).sort()).toEqual(['report.zip', 'report.zip.tmp']);
  });
  it('改名失败时只删除本次创建的临时文件', () => {
    const target = join(directory, 'report.zip');
    // 目标是非空目录，改名一定失败。
    mkdirSync(target);
    writeFileSync(join(target, 'inside'), 'x');
    writeFileSync(`${target}.tmp`, 'user data');
    expect(() => {
      writeFileReplacing(target, new Uint8Array([1]));
    }).toThrow();
    expect(readdirSync(directory).sort()).toEqual(['report.zip', 'report.zip.tmp']);
    expect(readFileSync(`${target}.tmp`, 'utf8')).toBe('user data');
  });
  it('目录不存在时创建临时文件就失败，不留下任何文件', () => {
    expect(() => {
      writeFileReplacing(join(directory, 'missing', 'report.zip'), new Uint8Array([1]));
    }).toThrow();
    expect(readdirSync(directory)).toEqual([]);
  });
});

describe('文件名时间', () => {
  it('用本地时间，补零', () => {
    expect(timestamp(new Date(2026, 0, 2, 3, 4, 5).getTime())).toBe('20260102-030405');
  });
});
