// 在仓库根目录运行（work/ 是临时输出）：
// npx esbuild app/scripts/verify-content-protocol.ts --bundle --platform=node --external:electron --format=esm --outfile=work/verify-content-protocol.mjs
// npx electron work/verify-content-protocol.mjs --content-dir=app/test-content
// 真实隐藏窗口验证 file:// 和本地 HTTP 页面的遮罩读取、视频跳转及 WebGL 上传。
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { app, BrowserWindow, protocol, net } from 'electron';
import { loadContent } from '../src/main/content/catalog';
import { registerContentProtocol, registerContentScheme } from '../src/main/content/protocol';
import { contentUrl } from '../src/shared/content-url';

registerContentScheme(protocol);
app.on('window-all-closed', () => {
  // 两个来源之间销毁隐藏窗口时，保持验证进程运行，最后显式返回检查结果。
});
void app.whenReady().then(async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'ttcats-protocol-'));
  const page = join(temporary, 'index.html');
  const html =
    '<!doctype html><html><head><title>Content protocol verification</title></head><body></body></html>';
  writeFileSync(page, html);
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(html);
  });
  let exitCode = 0;
  try {
    const contentDir = resolve(app.commandLine.getSwitchValue('content-dir'));
    const catalog = loadContent(contentDir);
    assert.equal(Object.keys(catalog.cats).length, 3);
    registerContentProtocol(protocol, net, contentDir, catalog);
    const url = contentUrl('test-calm', 'clips/walk.webm');
    const response = await net.fetch(url);
    assert.equal(response.status, 200);
    const all = Buffer.from(await response.arrayBuffer());
    assert.ok(all.length > 100);
    const range = await net.fetch(url, { headers: { Range: 'bytes=0-10' } });
    assert.equal(range.status, 206);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), all.subarray(0, 11));
    assert.equal((await net.fetch(contentUrl('unknown', 'cat.json'))).status, 403);
    await new Promise<void>((resolveListening, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolveListening);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const maskUrl = contentUrl('test-calm', 'clips/walk.hitmask.bin');
    const expectedMask = Array.from(
      readFileSync(join(contentDir, 'cats/test-calm/clips/walk.hitmask.bin')),
    );
    for (const origin of ['file', 'http']) {
      const window = new BrowserWindow({
        show: false,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          backgroundThrottling: false,
          autoplayPolicy: 'no-user-gesture-required',
        },
      });
      try {
        if (origin === 'file') await window.loadFile(page);
        else await window.loadURL(`http://127.0.0.1:${address.port}/`);
        const result: unknown = await window.webContents.executeJavaScript(`(async () => {
          const mask = await fetch(${JSON.stringify(maskUrl)});
          if (mask.status !== 200) throw new Error('Mask status: ' + mask.status);
          const bytes = Array.from(new Uint8Array(await mask.arrayBuffer()));
          const video = document.createElement('video');
          video.crossOrigin = 'anonymous';
          video.muted = true;
          document.body.append(video);
          function waitFor(event) {
            return new Promise((resolve, reject) => {
              const timeout = setTimeout(() => { cleanup(); reject(new Error('Video timeout: ' + event)); }, 10000);
              const done = () => { cleanup(); resolve(); };
              const fail = () => { cleanup(); reject(new Error('Video error: ' + video.error?.code)); };
              function cleanup() { clearTimeout(timeout); video.removeEventListener(event, done); video.removeEventListener('error', fail); }
              video.addEventListener(event, done, { once: true });
              video.addEventListener('error', fail, { once: true });
            });
          }
          const ready = waitFor('loadeddata');
          video.src = ${JSON.stringify(url)};
          await ready;
          const gl = document.createElement('canvas').getContext('webgl');
          if (!gl) throw new Error('WebGL unavailable');
          const texture = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, texture);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
          if (gl.getError() !== gl.NO_ERROR) throw new Error('WebGL upload failed');
          const seeked = waitFor('seeked');
          video.currentTime = 0.5;
          await seeked;
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
          if (gl.getError() !== gl.NO_ERROR) throw new Error('WebGL upload after seek failed');
          gl.deleteTexture(texture);
          const report = { bytes, width: video.videoWidth, height: video.videoHeight, time: video.currentTime };
          video.remove();
          return report;
        })()`);
        assert.deepEqual(result, { bytes: expectedMask, width: 128, height: 128, time: 0.5 });
        console.log(
          `${origin} renderer: mask fetch, anonymous video, WebGL upload and seek passed.`,
        );
      } finally {
        window.destroy();
      }
    }
    console.log('Electron protocol: full file, Range, disabled pack and renderer checks passed.');
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    server.close();
    rmSync(temporary, { recursive: true, force: true });
    app.exit(exitCode);
  }
});
