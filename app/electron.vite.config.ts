import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    build: {
      // 窗口开着 sandbox，sandbox 里的 preload 只能是一个完整的 CommonJS 文件（out/preload/index.cjs）
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: { panels: resolve(import.meta.dirname, 'src/renderer/panels/index.html') },
      },
    },
    plugins: [react()],
  },
});
