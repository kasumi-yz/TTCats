// 用真实 Electron 验证协议；无窗口，不需要桌面交互。
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { app, protocol, net } from 'electron';
import { loadContent } from '../src/main/content/catalog';
import { registerContentProtocol, registerContentScheme } from '../src/main/content/protocol';
import { contentUrl } from '../src/shared/content-url';

registerContentScheme(protocol);
void app.whenReady().then(async () => {
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
    console.log('Electron protocol: full file, Range, disabled pack checks passed.');
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
