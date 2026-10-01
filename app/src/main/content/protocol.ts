import { createReadStream, realpathSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import type { Net, Protocol } from 'electron';
import type { ContentCatalog } from '../../shared/core-api';
import { CONTENT_PROTOCOL } from '../../shared/content-url';
import { IdSchema, PackPathSchema } from '../../shared/schemas/common';
import { zh } from '../../shared/strings.zh-CN';
import { isInside } from './catalog';

/** 必须在 app.ready 之前调用；handle 在 ready 之后安装（由主进程拼装）。 */
export function registerContentScheme(
  protocol: Pick<Protocol, 'registerSchemesAsPrivileged'>,
): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: CONTENT_PROTOCOL,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ]);
}

/** 不使用 URL.pathname：URL 解析会先消除 ..，使危险的原始路径丢失。 */
export function resolveContentFile(
  url: string,
  contentDir: string,
  catalog: ContentCatalog,
): string | undefined {
  const match = /^ttcats-content:\/\/cats\/([^/?#]+)\/([^?#]+)$/.exec(url);
  if (!match) return undefined;
  try {
    const cat = decodeURIComponent(match[1] ?? '');
    const path = (match[2] ?? '').split('/').map(decodeURIComponent).join('/');
    if (
      !IdSchema.safeParse(cat).success ||
      !PackPathSchema.safeParse(path).success ||
      path.includes('%')
    )
      return undefined;
    if (!Object.hasOwn(catalog.cats, cat)) return undefined;
    const root = realpathSync(resolve(contentDir, 'cats', cat));
    const target = realpathSync(resolve(root, path));
    if (!isInside(root, target) || !statSync(target).isFile()) return undefined;
    return target;
  } catch {
    return undefined;
  }
}

export function registerContentProtocol(
  protocol: Pick<Protocol, 'handle'>,
  net: Pick<Net, 'fetch'>,
  contentDir: string,
  catalog: ContentCatalog,
): void {
  protocol.handle(CONTENT_PROTOCOL, (request) => {
    const file = resolveContentFile(request.url, contentDir, catalog);
    if (!file || (request.method !== 'GET' && request.method !== 'HEAD'))
      return new Response(zh.content.denied, { status: 403 });
    const range = request.headers.get('range');
    if (range !== null) {
      // Electron 的 file: fetch 忽略 Range，必须在协议层实现才能可靠跳转视频。
      const size = statSync(file).size;
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      const first = match?.[1] ?? '';
      const last = match?.[2] ?? '';
      const start = first ? Number(first) : Math.max(0, size - Number(last));
      const end = first && last ? Math.min(Number(last), size - 1) : size - 1;
      if (
        !match ||
        (!first && !last) ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        start >= size
      ) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      }
      const types: Record<string, string> = {
        '.webm': 'video/webm',
        '.png': 'image/png',
        '.json': 'application/json',
        '.ogg': 'audio/ogg',
      };
      const body =
        request.method === 'HEAD'
          ? null
          : (Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream<Uint8Array>);
      return new Response(body, {
        status: 206,
        headers: {
          'Content-Type': types[extname(file)] ?? 'application/octet-stream',
          'Content-Length': String(end - start + 1),
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${start}-${end}/${size}`,
        },
      });
    }
    return net.fetch(pathToFileURL(file).href, {
      method: request.method,
      headers: request.headers,
    });
  });
}
