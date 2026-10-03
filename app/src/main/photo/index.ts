import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { app, clipboard, ClipboardItem, desktopCapturer, Notification, screen } from 'electron';
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron';
import type { ContentCatalog } from '../../shared/core-api';
import { IPC_CHANNELS, type StateSnapshot } from '../../shared/ipc';
import { zh } from '../../shared/strings.zh-CN';
import type { MainFeature } from '../features';
import { composePhoto } from './compose';

interface PhotoOverlay {
  window: BrowserWindow | undefined;
  withCaptureProtection: <T>(capture: () => Promise<T>) => Promise<T>;
}

export function photoPath(pictures: string, date: Date, id = randomUUID()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  return join(pictures, 'TTCats', `${stamp}_${id}.png`);
}

export function createPhoto(options: {
  overlay: () => PhotoOverlay | undefined;
  allowed: () => boolean;
  updateTray: () => void;
  report: (error: unknown) => void;
}) {
  let busy = false;
  const available = (): boolean => {
    const window = options.overlay()?.window;
    return (
      !busy &&
      options.allowed() &&
      window !== undefined &&
      !window.isDestroyed() &&
      window.isVisible() &&
      !window.webContents.isCrashed() &&
      !window.webContents.isLoadingMainFrame()
    );
  };
  const take = async (): Promise<void> => {
    if (!available()) return;
    const overlay = options.overlay();
    const window = overlay?.window;
    if (!overlay || !window) return;
    busy = true;
    options.updateTray();
    try {
      const bounds = window.getBounds();
      const display = screen.getDisplayMatching(bounds);
      const size = {
        width: Math.round(display.size.width * display.scaleFactor),
        height: Math.round(display.size.height * display.scaleFactor),
      };
      const photo = await overlay.withCaptureProtection(async () => {
        // 临时保护桌面层，只采集下面的桌面，避免合成后出现两份猫。
        await delay(350);
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: size,
        });
        // 部分 Windows 采集后端不提供 display_id；只有唯一显示器/来源时才可无歧义对应。
        const source =
          sources.find((source) => source.display_id === String(display.id)) ??
          (screen.getAllDisplays().length === 1 &&
          sources.length === 1 &&
          sources[0]?.display_id === ''
            ? sources[0]
            : undefined);
        const image = source?.thumbnail;
        if (!image || image.isEmpty()) throw new Error(zh.photo.captureFailed);
        const actual = image.getSize();
        // DIP 已经取整，乘回缩放可能差一个物理像素；保留实际图像，不拉伸补齐。
        if (
          actual.width <= 0 ||
          actual.height <= 0 ||
          Math.abs(actual.width - size.width) > 1 ||
          Math.abs(actual.height - size.height) > 1
        )
          throw new Error(
            zh.photo.sizeMismatch(size.width, size.height, actual.width, actual.height),
          );
        if (
          window.isDestroyed() ||
          !window.isVisible() ||
          JSON.stringify(window.getBounds()) !== JSON.stringify(bounds)
        )
          throw new Error(zh.photo.desktopChanged);
        const layer = await window.webContents.capturePage();
        const layerSize = layer.getSize();
        if (
          window.isDestroyed() ||
          !window.isVisible() ||
          JSON.stringify(window.getBounds()) !== JSON.stringify(bounds) ||
          layerSize.width <= 0 ||
          layerSize.height <= 0 ||
          Math.abs(layerSize.width - Math.round(bounds.width * display.scaleFactor)) > 1 ||
          Math.abs(layerSize.height - Math.round(bounds.height * display.scaleFactor)) > 1
        )
          throw new Error(zh.photo.desktopChanged);
        return composePhoto(
          image,
          layer,
          Math.round(((bounds.x - display.bounds.x) * actual.width) / display.bounds.width),
          Math.round(((bounds.y - display.bounds.y) * actual.height) / display.bounds.height),
        );
      });
      const pictures = app.getPath('pictures');
      await mkdir(join(pictures, 'TTCats'), { recursive: true });
      const file = photoPath(pictures, new Date());
      const png = photo.toPNG();
      await writeFile(file, png, { flag: 'wx' });
      try {
        await clipboard.write([
          new ClipboardItem({
            'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }),
          }),
        ]);
      } catch (error) {
        throw new Error(zh.photo.clipboardFailed(file, String(error)), { cause: error });
      }
      const photoSize = photo.getSize();
      const ratio = Math.min(1, 480 / Math.max(photoSize.width, photoSize.height));
      if (!window.isDestroyed() && !window.webContents.isCrashed()) {
        window.webContents.send(IPC_CHANNELS.mainToOverlay, {
          type: 'photo',
          thumbnail: photo
            .resize({
              width: Math.round(photoSize.width * ratio),
              height: Math.round(photoSize.height * ratio),
            })
            .toDataURL(),
          area: {
            x: display.bounds.x - bounds.x,
            y: display.bounds.y - bounds.y,
            width: display.bounds.width,
            height: display.bounds.height,
          },
        });
        // 动画持续 1500ms，结束前拒绝重复拍照，避免把动画拍进下一张。
        await delay(2000);
      }
    } catch (error) {
      const message = zh.photo.failed(String(error));
      options.report(message);
      try {
        new Notification({ title: zh.photo.title, body: message, silent: true }).show();
      } catch (noticeError) {
        options.report(zh.photo.noticeFailed(String(noticeError)));
      }
    } finally {
      busy = false;
      options.updateTray();
    }
  };
  return {
    take,
    menuSection: (): MenuItemConstructorOptions[] => [
      {
        id: 'photo',
        label: zh.photo.title,
        enabled: available(),
        click: () => {
          void take();
        },
      },
    ],
  };
}

/** 拍照的接线：只在非安全模式、未在退出、且有猫显示时可拍；托盘和调试台共用同一个入口。 */
export function createPhotoFeature(options: {
  overlay: () => PhotoOverlay | undefined;
  session: { readonly safeMode: boolean; snapshot: () => StateSnapshot };
  content: ContentCatalog;
  stopping: () => boolean;
  updateTray: () => void;
  report: (error: unknown) => void;
}) {
  const { session, content } = options;
  const photo = createPhoto({
    overlay: options.overlay,
    allowed: () =>
      !session.safeMode &&
      !options.stopping() &&
      session.snapshot().settings.visibleCats.some((id) => Object.hasOwn(content.cats, id)),
    updateTray: options.updateTray,
    report: options.report,
  });
  return {
    menuSection: photo.menuSection,
    mainCommands: { 'photo/take': photo.take },
  } satisfies MainFeature;
}
