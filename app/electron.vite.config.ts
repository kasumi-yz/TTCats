import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // 独立入口供 Electron 主进程验证原生模块，后续桌面层直接导入源码接口。
        input: {
          index: resolve(import.meta.dirname, 'src/main/index.ts'),
          platform: resolve(import.meta.dirname, 'src/main/platform/index.ts'),
        },
        external: ['koffi'],
        output: { exports: 'named' },
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
