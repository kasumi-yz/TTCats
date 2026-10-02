import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { app, dialog, screen, shell, type BrowserWindow } from 'electron';
import type { ContentCatalog } from '../../shared/core-api';
import { zh } from '../../shared/strings.zh-CN';
import { buildDiagnosticsZip, type Privacy } from './bundle';

export { buildDiagnosticsZip, DIAGNOSTICS_FILES, redact, type DiagnosticsInput } from './bundle';

const text = zh.diagnostics;
const GPU_TIMEOUT_MS = 5000;

export interface DiagnosticsOptions {
  logDirectory: string;
  saveFile: string;
  contentDirectory: string;
  /** 安全模式会就地过滤这个目录，导出时读到的就是当时的停用结果。 */
  content: ContentCatalog;
  safeMode: () => boolean;
  stopping: () => boolean;
  overlayWindow: () => BrowserWindow | undefined;
  report: (message: string) => void;
  now?: () => number;
}

/** 本地时间，文件名用：20261002-153045。 */
export function timestamp(at: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

export function contentSummary(content: ContentCatalog, directory: string, safeMode: boolean) {
  return {
    directory,
    safeMode,
    cats: Object.entries(content.cats).map(([id, pack]) => ({
      id,
      name: pack.cat.name,
      clips: pack.clips.length,
    })),
    disabled: content.disabled.map((pack) => ({ cat: pack.cat, problems: pack.problems })),
  };
}

function privacy(): Privacy {
  const home = app.getPath('home');
  return { home, username: process.env['USERNAME'] ?? basename(home) };
}

async function gpuInfo(): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      app.getGPUInfo('basic'),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`getGPUInfo 超过 ${GPU_TIMEOUT_MS} 毫秒没有返回`));
        }, GPU_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    return { error: String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function readLogs(directory: string): { name: string; text: string }[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({ name, text: readFileSync(join(directory, name), 'utf8') }));
}

async function systemInfo(overlay: BrowserWindow | undefined) {
  const primary = screen.getPrimaryDisplay().id;
  const memory = process.getSystemMemoryInfo();
  // 操作系统模块只能在 platform/ 里用（硬性规则 3），这里只用 Electron 的跨平台接口和系统环境变量。
  return {
    os: { version: process.getSystemVersion(), arch: process.arch },
    cpu: {
      identifier: process.env['PROCESSOR_IDENTIFIER'] ?? null,
      cores: Number(process.env['NUMBER_OF_PROCESSORS']) || null,
    },
    memory: { totalKB: memory.total, freeKB: memory.free },
    gpu: await gpuInfo(),
    displays: screen.getAllDisplays().map((display) => ({
      id: display.id,
      label: display.label,
      primary: display.id === primary,
      bounds: display.bounds,
      size: display.size,
      workArea: display.workArea,
      scaleFactor: display.scaleFactor,
      rotation: display.rotation,
      internal: display.internal,
    })),
    overlayDisplayId:
      overlay && !overlay.isDestroyed() ? screen.getDisplayMatching(overlay.getBounds()).id : null,
    locale: {
      app: app.getLocale(),
      system: app.getSystemLocale(),
      preferred: app.getPreferredSystemLanguages(),
    },
  };
}

/**
 * 处理 diagnostics/export（D13）：弹出保存对话框，把日志、存档、版本、系统信息和内容状态打成 zip。
 * 安全模式下照常可用；退出过程中拒绝。导出完成后在文件夹里选中文件，失败时中文提示并写日志。
 */
export function createDiagnosticsExport(options: DiagnosticsOptions): () => Promise<void> {
  const now = options.now ?? Date.now;
  let busy = false;
  const run = async (): Promise<void> => {
    const result = await dialog.showSaveDialog({
      title: text.dialogTitle,
      defaultPath: join(app.getPath('desktop'), text.fileName(timestamp(now()))),
      filters: [{ name: text.filterName, extensions: ['zip'] }],
    });
    if (result.canceled || !result.filePath) {
      options.report(text.canceled);
      return;
    }
    const target = result.filePath;
    options.report(text.started);
    const zip = buildDiagnosticsZip({
      logs: readLogs(options.logDirectory),
      save: existsSync(options.saveFile) ? readFileSync(options.saveFile, 'utf8') : null,
      version: {
        app: app.getVersion(),
        electron: process.versions.electron,
        chromium: process.versions.chrome,
        node: process.versions.node,
        isPackaged: app.isPackaged,
        exportedAt: now(),
      },
      system: await systemInfo(options.overlayWindow()),
      content: contentSummary(options.content, options.contentDirectory, options.safeMode()),
      privacy: privacy(),
    });
    // 先写临时文件再替换，半截的压缩包不会留在用户选的位置。
    const temporary = `${target}.tmp`;
    try {
      writeFileSync(temporary, zip);
      renameSync(temporary, target);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
    options.report(text.saved(target));
    shell.showItemInFolder(target);
  };
  return async () => {
    if (options.stopping()) {
      options.report(text.stopping);
      return;
    }
    if (busy) {
      options.report(text.busy);
      return;
    }
    busy = true;
    try {
      await run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.report(text.failed(message));
      await dialog.showMessageBox({
        type: 'error',
        title: text.failedTitle,
        message: text.failed(message),
      });
    } finally {
      busy = false;
    }
  };
}
