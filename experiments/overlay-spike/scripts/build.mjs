// 用 esbuild 把 src/ 打包到 dist/：主进程、preload、渲染进程、测试脚本。
import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
mkdirSync(dist, { recursive: true });

const node = { bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron', 'koffi'], sourcemap: 'inline', logLevel: 'warning' };
const web = { bundle: true, platform: 'browser', format: 'iife', target: 'chrome140', sourcemap: 'inline', logLevel: 'warning' };

await Promise.all([
  build({ ...node, entryPoints: { main: 'src/main/main.ts', 'probe-main': 'src/probe/probe-main.ts' }, outdir: dist }),
  build({ ...node, entryPoints: { preload: 'src/main/preload.ts', 'probe-preload': 'src/probe/probe-preload.ts' }, outdir: dist }),
  build({ ...web, entryPoints: { overlay: 'src/renderer/overlay.ts', probe: 'src/probe/probe.ts' }, outdir: dist }),
  build({
    ...node,
    entryPoints: {
      'tools/perf': 'src/tools/perf.ts',
      'tools/interaction-test': 'src/tools/interaction-test.ts',
      'tools/capture-test': 'src/tools/capture-test.ts',
      'tools/record-interrupts': 'src/tools/record-interrupts.ts',
    },
    outdir: dist,
  }),
]);
cpSync(join(root, 'src', 'renderer', 'overlay.html'), join(dist, 'overlay.html'));
cpSync(join(root, 'src', 'probe', 'probe.html'), join(dist, 'probe.html'));
console.log('构建完成：dist/');
