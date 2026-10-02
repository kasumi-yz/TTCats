import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
// eslint-disable-next-line no-restricted-imports -- 仅用于测试临时目录。
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { createPhoto, photoPath } from './index';
import { zh } from '../../shared/strings.zh-CN';

const mock = vi.hoisted(() => ({
  pictures: '',
  displayCount: 1,
  sources: vi.fn(),
  clipboard: vi.fn(),
  send: vi.fn(),
  notice: vi.fn(),
  display: {
    id: 23,
    size: { width: 1920, height: 1200 },
    scaleFactor: 1.5,
    bounds: { x: -1920, y: 0, width: 1920, height: 1200 },
  },
}));
vi.mock('./compose', () => ({ composePhoto: (image: unknown) => image }));
vi.mock('node:timers/promises', () => ({ setTimeout: () => Promise.resolve() }));
vi.mock('electron', () => ({
  app: { getPath: () => mock.pictures },
  screen: {
    getDisplayMatching: () => mock.display,
    getAllDisplays: () => Array.from({ length: mock.displayCount }, () => mock.display),
  },
  desktopCapturer: { getSources: mock.sources },
  clipboard: { write: mock.clipboard },
  ClipboardItem: class {
    constructor(readonly items: unknown) {}
  },
  Notification: class {
    constructor(readonly options: unknown) {}
    show = mock.notice;
  },
}));

function setup() {
  const window = {
    isDestroyed: () => false,
    isVisible: vi.fn(() => true),
    getBounds: () => ({ x: -1920, y: 0, width: 1920, height: 1152 }),
    webContents: {
      isCrashed: () => false,
      isLoadingMainFrame: () => false,
      send: mock.send,
      capturePage: () => Promise.resolve({ getSize: () => ({ width: 2880, height: 1728 }) }),
    },
  };
  const report = vi.fn();
  const allowed = vi.fn(() => true);
  const capture = <T>(callback: () => Promise<T>): Promise<T> => callback();
  const service = createPhoto({
    overlay: () => ({ window: window as unknown as BrowserWindow, withCaptureProtection: capture }),
    allowed,
    report,
    updateTray: vi.fn(),
  });
  const image = {
    isEmpty: () => false,
    getSize: () => ({ width: 2880, height: 1800 }),
    toPNG: () => Buffer.from('photo-png'),
    resize: vi.fn(() => ({ toDataURL: () => 'data:image/png;base64,photo' })),
  };
  mock.sources.mockResolvedValue([{ display_id: 'other' }, { display_id: '23', thumbnail: image }]);
  return { ...service, window, allowed, report, capture, image };
}

describe('拍照', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mock.displayCount = 1;
    mock.clipboard.mockResolvedValue(undefined);
    mock.pictures = await mkdtemp(join(tmpdir(), 'ttcats-photo-'));
  });
  afterEach(async () => {
    await rm(mock.pictures, { recursive: true, force: true });
  });

  it('图片目录、可读的本地日期时间和唯一文件名，连续同一时刻不会覆盖', () => {
    const date = new Date(2026, 9, 2, 3, 4, 5);
    const path = photoPath(mock.pictures, date);
    expect(path).toMatch(/2026-10-02_03-04-05_[\w-]+\.png$/);
    expect(path).not.toBe(photoPath(mock.pictures, date));
    expect(path.startsWith(join(mock.pictures, 'TTCats'))).toBe(true);
  });

  it('新建目录，只拍桌面层所在显示器的物理全屏，存好并复制后才播放缩略图', async () => {
    const { take, report, image } = setup();
    mock.send.mockImplementation(() => {
      expect(mock.clipboard).toHaveBeenCalledOnce();
    });
    await take();
    expect(report).not.toHaveBeenCalled();
    expect(mock.sources).toHaveBeenCalledWith({
      types: ['screen'],
      thumbnailSize: { width: 2880, height: 1800 },
    });
    const files = await readdir(join(mock.pictures, 'TTCats'));
    expect(files).toHaveLength(1);
    expect(await readFile(join(mock.pictures, 'TTCats', files[0] ?? ''), 'utf8')).toBe('photo-png');
    expect(image.resize).toHaveBeenCalledWith({ width: 480, height: 300 });
    expect(mock.send).toHaveBeenCalledWith(expect.any(String), {
      type: 'photo',
      thumbnail: 'data:image/png;base64,photo',
      area: { x: 0, y: 0, width: 1920, height: 1200 },
    });
  });

  it('安全模式、全猫隐藏或桌面层隐藏时菜单禁用，调试命令也不能偷偷拍照', async () => {
    const { menuSection, take, allowed, window } = setup();
    expect(menuSection()[0]?.enabled).toBe(true);
    allowed.mockReturnValue(false);
    expect(menuSection()[0]?.enabled).toBe(false);
    await take();
    allowed.mockReturnValue(true);
    window.isVisible.mockReturnValue(false);
    expect(menuSection()[0]?.enabled).toBe(false);
    await take();
    expect(mock.sources).not.toHaveBeenCalled();
  });

  it('一次拍照尚未结束时拒绝第二次，不把快门动画拍进下一张', async () => {
    const { take, menuSection } = setup();
    const first = take();
    expect(menuSection()[0]?.enabled).toBe(false);
    await take();
    await first;
    expect(mock.sources).toHaveBeenCalledOnce();
    expect(menuSection()[0]?.enabled).toBe(true);
  });

  it.each(['capture', 'size', 'disk', 'clipboard'])(
    '失败（%s）有中文日志、静音通知，不发成功动画',
    async (failure) => {
      const { take, report, image, menuSection } = setup();
      if (failure === 'capture') mock.sources.mockRejectedValueOnce(new Error('capture'));
      if (failure === 'size') image.getSize = () => ({ width: 150, height: 150 });
      if (failure === 'disk') await writeFile(join(mock.pictures, 'TTCats'), 'blocked');
      if (failure === 'clipboard') mock.clipboard.mockRejectedValueOnce(new Error('clipboard'));
      await take();
      expect(report).toHaveBeenCalledWith(expect.stringContaining('拍照未完成'));
      expect(mock.notice).toHaveBeenCalledOnce();
      expect(mock.send).not.toHaveBeenCalled();
      expect(menuSection()[0]?.enabled).toBe(true);
      if (failure === 'clipboard')
        expect(report).toHaveBeenCalledWith(expect.stringContaining('照片已保存到'));
    },
  );

  it.each([1, 2])(
    '来源没有显示器编号时只允许唯一显示器，不能猜测多屏对应（%s 块）',
    async (count) => {
      const { take, image, report } = setup();
      mock.displayCount = count;
      mock.sources.mockResolvedValueOnce([{ display_id: '', thumbnail: image }]);
      await take();
      expect(mock.clipboard).toHaveBeenCalledTimes(count === 1 ? 1 : 0);
      expect(report).toHaveBeenCalledTimes(count === 1 ? 0 : 1);
    },
  );

  it('截图期间隐藏或移动桌面层时丢弃照片，不误报成功', async () => {
    const { take, window, report, image } = setup();
    mock.sources.mockImplementationOnce(() => {
      window.isVisible.mockReturnValue(false);
      return [{ display_id: '23', thumbnail: image }];
    });
    await take();
    expect(report).toHaveBeenCalledWith(zh.photo.failed(`Error: ${zh.photo.desktopChanged}`));
    expect(mock.clipboard).not.toHaveBeenCalled();
  });
});
