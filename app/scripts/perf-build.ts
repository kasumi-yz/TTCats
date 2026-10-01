import { join, resolve } from 'node:path';
import { build } from 'vite';
export const appRoot = resolve(import.meta.dirname, '..');
export const output = join(appRoot, 'out/overlay-check');
export async function buildOverlayCheck(): Promise<void> {
  await build({
    configFile: false,
    root: appRoot,
    logLevel: 'warn',
    build: {
      outDir: output,
      // 保留已有测量结果，renderer 目录单独清理。
      emptyOutDir: false,
      lib: {
        entry: join(appRoot, 'src/main/overlay/desktop.fixture.ts'),
        formats: ['es'],
        fileName: () => 'desktop.mjs',
      },
      rollupOptions: { external: ['electron', 'koffi', /^node:/] },
    },
  });
  await build({
    configFile: false,
    root: join(appRoot, 'src/renderer'),
    base: './',
    logLevel: 'warn',
    build: {
      outDir: join(output, 'renderer'),
      target: 'esnext',
      emptyOutDir: true,
      rollupOptions: {
        input: {
          overlay: join(appRoot, 'src/renderer/overlay/index.html'),
          test: join(appRoot, 'src/renderer/overlay/test.html'),
        },
      },
    },
  });
}
