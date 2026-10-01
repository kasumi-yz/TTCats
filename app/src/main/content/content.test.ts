import type { Protocol } from 'electron';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  symlinkSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadContent } from './catalog';
import { contentDirectory } from './index';
import { registerContentProtocol, registerContentScheme, resolveContentFile } from './protocol';
import { contentUrl } from '../../shared/content-url';
import { CLIP_SLOTS } from '../../shared/schemas';

const source = resolve(import.meta.dirname, '../../../test-content');
let root: string;
beforeEach(() => {
  root = mkdtempSync(resolve(import.meta.dirname, '.content-test-'));
  cpSync(source, join(root, 'content'), { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
const dir = () => join(root, 'content');
const file = (path: string) => join(dir(), 'cats/test-calm', path);

describe('运行时猫咪包加载', () => {
  it('三只猫全部可用，包含全部片段，性格与体型各不相同', () => {
    const log = vi.fn();
    const catalog = loadContent(dir(), log);
    expect(catalog.disabled).toEqual([]);
    expect(Object.keys(catalog.cats)).toHaveLength(3);
    expect(log).not.toHaveBeenCalled();
    for (const pack of Object.values(catalog.cats))
      expect(pack.clips.map((clip) => clip.name).sort()).toEqual(Object.keys(CLIP_SLOTS).sort());
    expect(new Set(Object.values(catalog.cats).map((pack) => pack.cat.relativeSize)).size).toBe(3);
    expect(
      new Set(Object.values(catalog.cats).map((pack) => JSON.stringify(pack.cat.personality))).size,
    ).toBe(3);
  });

  it('缺少必需片段时整只停用，并说清楚是哪只猫、缺了什么，其他猫仍能运行', () => {
    unlinkSync(file('clips/walk.json'));
    const log = vi.fn();
    const catalog = loadContent(dir(), log);
    expect(Object.keys(catalog.cats)).toEqual(['test-active', 'test-close']);
    expect(catalog.disabled).toEqual([
      { cat: 'test-calm', problems: ['猫咪包「test-calm」：缺少必需片段：walk'] },
    ]);
    expect(log).toHaveBeenCalledWith('猫咪包「test-calm」：缺少必需片段：walk');
  });

  it('JSON 损坏不影响其余猫咪包', () => {
    writeFileSync(file('cat.json'), '{');
    const catalog = loadContent(dir(), vi.fn());
    expect(Object.keys(catalog.cats)).toHaveLength(2);
    expect(catalog.disabled[0]?.problems[0]).toContain(
      '猫咪包「test-calm」 content/cats/test-calm/cat.json：不是合法的 JSON',
    );
  });

  it('点击遮罩长度错误时停用猫咪包，避免错帧命中鼠标', () => {
    writeFileSync(file('clips/walk.hitmask.bin'), Buffer.alloc(1));
    const catalog = loadContent(dir(), vi.fn());
    expect(catalog.cats['test-calm']).toBeUndefined();
    expect(catalog.disabled[0]?.problems[0]).toContain('点击遮罩 clips/walk.hitmask.bin 长度不对');
  });

  it('缺可选片段仍能运行，由桌面层降级', () => {
    unlinkSync(file('clips/run.json'));
    expect(loadContent(dir(), vi.fn()).disabled).toEqual([]);
  });

  it('clips 目录损坏也只停用这一只猫', () => {
    rmSync(file('clips'), { recursive: true });
    writeFileSync(file('clips'), 'not a directory');
    const catalog = loadContent(dir(), vi.fn());
    expect(Object.keys(catalog.cats)).toHaveLength(2);
    expect(catalog.disabled[0]?.problems[0]).toContain('无法读取猫咪包文件');
    expect(catalog.disabled[0]?.problems[0]).toContain('clips');
  });

  it('同名同版本片段重复时停用，避免随机播放错误素材', () => {
    cpSync(file('clips/walk.json'), file('clips/duplicate.json'));
    const catalog = loadContent(dir(), vi.fn());
    expect(catalog.cats['test-calm']).toBeUndefined();
    expect(catalog.disabled[0]?.problems[0]).toContain('片段「walk」的版本 1 重复');
  });
});

describe('猫咪包文件协议', () => {
  it('桌面层生成的地址可以读已加载的片段与点击遮罩', () => {
    const catalog = loadContent(dir(), vi.fn());
    expect(resolveContentFile(contentUrl('test-calm', 'clips/walk.webm'), dir(), catalog)).toBe(
      file('clips/walk.webm'),
    );
    writeFileSync(file('中文 空格.bin'), 'mask');
    expect(resolveContentFile(contentUrl('test-calm', '中文 空格.bin'), dir(), catalog)).toBe(
      file('中文 空格.bin'),
    );
  });

  it.each([
    '../test-close/cat.json',
    'clips/../../cat.json',
    '/cat.json',
    'C:/secret',
    'C:\\secret',
    '%2e%2e/cat.json',
    '%2e%2e%2fcat.json',
    '%252e%252e/cat.json',
    'clips/%2fcat.json',
    'clips/%5c..%5ccat.json',
    'clips/%00walk.webm',
    '%ZZ',
    'clips/walk.webm?x=1',
    'clips/walk.webm#x',
  ])('拒绝危险原始路径 %s', (path) => {
    expect(
      resolveContentFile(
        `ttcats-content://cats/test-calm/${path}`,
        dir(),
        loadContent(dir(), vi.fn()),
      ),
    ).toBeUndefined();
  });

  it('未加载与被停用的猫不能通过协议读取', () => {
    unlinkSync(file('clips/walk.json'));
    const catalog = loadContent(dir(), vi.fn());
    expect(resolveContentFile(contentUrl('test-calm', 'cat.json'), dir(), catalog)).toBeUndefined();
    expect(resolveContentFile(contentUrl('unknown', 'cat.json'), dir(), catalog)).toBeUndefined();
  });

  it('目录链接指向包外时拒绝访问', () => {
    mkdirSync(join(root, 'outside'));
    writeFileSync(join(root, 'outside/secret.bin'), 'secret');
    symlinkSync(join(root, 'outside'), file('linked'), 'junction');
    expect(
      resolveContentFile(
        contentUrl('test-calm', 'linked/secret.bin'),
        dir(),
        loadContent(dir(), vi.fn()),
      ),
    ).toBeUndefined();
  });

  it('注册可流式读取的安全协议，按 Range 只返回所需字节，危险路径返回 403', async () => {
    const privileged = vi.fn<Protocol['registerSchemesAsPrivileged']>();
    registerContentScheme({ registerSchemesAsPrivileged: privileged });
    expect(privileged.mock.calls[0]?.[0][0]?.privileges?.stream).toBe(true);
    expect(privileged.mock.calls[0]?.[0][0]?.privileges?.corsEnabled).toBe(true);
    const handle = vi.fn();
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response('clip', { headers: { 'Content-Type': 'video/webm' } }));
    registerContentProtocol({ handle }, { fetch }, dir(), loadContent(dir(), vi.fn()));
    const handler = handle.mock.calls[0]?.[1] as (request: Request) => Promise<Response> | Response;
    const headers = { Range: 'bytes=0-10' };
    const range = await handler(
      new Request(contentUrl('test-calm', 'clips/walk.webm'), { headers }),
    );
    expect(range.status).toBe(206);
    expect(range.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(Buffer.from(await range.arrayBuffer())).toEqual(
      readFileSync(file('clips/walk.webm')).subarray(0, 11),
    );
    const suffix = await handler(
      new Request(contentUrl('test-calm', 'clips/walk.webm'), { headers: { Range: 'bytes=-10' } }),
    );
    expect(Buffer.from(await suffix.arrayBuffer())).toEqual(
      readFileSync(file('clips/walk.webm')).subarray(-10),
    );
    const invalid = await handler(
      new Request(contentUrl('test-calm', 'clips/walk.webm'), {
        headers: { Range: 'bytes=999999999-' },
      }),
    );
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(fetch).not.toHaveBeenCalled();
    const denied = await handler(new Request(contentUrl('unknown', 'cat.json')));
    expect(denied.status).toBe(403);
    expect(denied.headers.get('Access-Control-Allow-Origin')).toBe('*');
    const post = await handler(
      new Request(contentUrl('test-calm', 'cat.json'), { method: 'POST' }),
    );
    expect(post.status).toBe(403);
    expect(post.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(fetch).not.toHaveBeenCalled();
    const full = await handler(new Request(contentUrl('test-calm', 'clips/walk.webm')));
    expect(full.status).toBe(200);
    expect(full.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(full.headers.get('Content-Type')).toBe('video/webm');
    expect(await full.text()).toBe('clip');
    expect(fetch).toHaveBeenCalledOnce();
  });
});

it('正式安装忽略测试目录开关，开发时才可切换', () => {
  const options = {
    resourcesPath: root,
    appPath: join(root, 'app'),
    env: { TTCATS_CONTENT_DIR: source },
  };
  expect(contentDirectory({ ...options, isPackaged: true })).toBe(join(root, 'content'));
  expect(contentDirectory({ ...options, isPackaged: false })).toBe(source);
  expect(contentDirectory({ ...options, env: {}, isPackaged: false })).toBe(join(root, 'content'));
  vi.stubEnv('TTCATS_CONTENT_DIR', source);
  try {
    expect(
      contentDirectory({ isPackaged: false, resourcesPath: root, appPath: join(root, 'app') }),
    ).toBe(source);
  } finally {
    vi.unstubAllEnvs();
  }
});

it('打包配置只包含 out 和正式 content，显式排除测试猫咪包', () => {
  const config = readFileSync(
    resolve(import.meta.dirname, '../../../electron-builder.yml'),
    'utf8',
  );
  expect(config).toContain("'!test-content/**/*'");
  expect(config).toContain('from: ../content');
});
