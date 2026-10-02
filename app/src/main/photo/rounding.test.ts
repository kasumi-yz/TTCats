import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
// eslint-disable-next-line no-restricted-imports -- 仅用于测试临时目录。
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPhoto } from './index';

const mock = vi.hoisted(() => ({
  pictures: '',
  display: {
    id: 23,
    size: { width: 1707, height: 960 },
    scaleFactor: 1.5,
    bounds: { x: -1707, y: 0, width: 1707, height: 960 },
  },
  sources: vi.fn(),
  compose: vi.fn(),
  clipboard: vi.fn(),
  notice: vi.fn(),
}));
vi.mock('./compose', () => ({ composePhoto: mock.compose }));
vi.mock('node:timers/promises', () => ({ setTimeout: () => Promise.resolve() }));
vi.mock('electron', () => ({
  app: { getPath: () => mock.pictures },
  screen: {
    getDisplayMatching: () => mock.display,
    getAllDisplays: () => [mock.display],
  },
  desktopCapturer: { getSources: mock.sources },
  clipboard: { write: mock.clipboard },
  ClipboardItem: class {
    constructor(readonly items: unknown) {}
  },
  Notification: class {
    show = mock.notice;
  },
}));

const displays = [
  { width: 2560, height: 1440, scale: 1.5, dipWidth: 1707, dipHeight: 960 },
  { width: 2880, height: 1800, scale: 1.75, dipWidth: 1646, dipHeight: 1029 },
  { width: 1920, height: 1080, scale: 1.25, dipWidth: 1536, dipHeight: 864 },
];

describe('拍照的非整数 DIP 取整（#82 审查回归）', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mock.clipboard.mockResolvedValue(undefined);
    mock.compose.mockImplementation((image: unknown) => image);
    mock.pictures = await mkdtemp(join(tmpdir(), 'ttcats-photo-rounding-'));
  });
  afterEach(async () => {
    await rm(mock.pictures, { recursive: true, force: true });
  });

  it.each(displays)(
    '$width × $height，缩放 $scale：保存实际尺寸并按实际比例放置桌面层',
    async ({ width, height, scale, dipWidth, dipHeight }) => {
      mock.display = {
        id: 23,
        size: { width: dipWidth, height: dipHeight },
        scaleFactor: scale,
        bounds: { x: -dipWidth, y: 0, width: dipWidth, height: dipHeight },
      };
      const offsetX = Math.round((101 * width) / dipWidth);
      const offsetY = Math.round((81 * height) / dipHeight);
      const bounds = { x: -dipWidth + 101, y: 81, width: dipWidth - 101, height: dipHeight - 81 };
      const layer = { getSize: () => ({ width: width - offsetX, height: height - offsetY }) };
      const image = {
        isEmpty: () => false,
        getSize: () => ({ width, height }),
        toPNG: () => Buffer.from(`${width}x${height}`),
        resize: vi.fn(() => ({ toDataURL: () => 'data:image/png;base64,photo' })),
      };
      mock.sources.mockResolvedValue([{ display_id: '23', thumbnail: image }]);
      const report = vi.fn();
      const send = vi.fn();
      const window = {
        isDestroyed: () => false,
        isVisible: () => true,
        getBounds: () => bounds,
        webContents: {
          isCrashed: () => false,
          isLoadingMainFrame: () => false,
          capturePage: () => Promise.resolve(layer),
          send,
        },
      };
      const service = createPhoto({
        overlay: () => ({
          window: window as unknown as BrowserWindow,
          withCaptureProtection: <T>(capture: () => Promise<T>) => capture(),
        }),
        allowed: () => true,
        updateTray: vi.fn(),
        report,
      });
      await service.take();
      expect(report).not.toHaveBeenCalled();
      expect(mock.notice).not.toHaveBeenCalled();
      expect(mock.compose).toHaveBeenCalledWith(image, layer, offsetX, offsetY);
      expect(mock.clipboard).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledOnce();
      const files = await readdir(join(mock.pictures, 'TTCats'));
      expect(files).toHaveLength(1);
      expect(await readFile(join(mock.pictures, 'TTCats', files[0] ?? ''), 'utf8')).toBe(
        `${width}x${height}`,
      );
      const ratio = Math.min(1, 480 / Math.max(width, height));
      expect(image.resize).toHaveBeenCalledWith({
        width: Math.round(width * ratio),
        height: Math.round(height * ratio),
      });
    },
  );
});
