// 测试用的本地控制通道：被测程序在 127.0.0.1 上开一个小 HTTP 服务，
// 启动后往 stdout 打印 "CONTROL_PORT=<端口>"，测试脚本据此连接。

import { createServer } from 'node:http';

export type Handler = (body: Record<string, unknown>, query: URLSearchParams) => unknown | Promise<unknown>;

export function startControlServer(routes: Record<string, Handler>): Promise<number> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const handler = routes[`${req.method} ${url.pathname}`];
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', async () => {
      try {
        if (!handler) throw new Error(`没有这个接口：${req.method} ${url.pathname}`);
        const result = await handler(raw ? JSON.parse(raw) : {}, url.searchParams);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result ?? { ok: true }));
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
  });
  // 测试脚本会复用连接；默认 5 秒的空闲超时会让复用的连接被服务端关掉（ECONNRESET）
  server.keepAliveTimeout = 10 * 60 * 1000;
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      process.stdout.write(`CONTROL_PORT=${port}\n`);
      resolve(port);
    });
  });
}
