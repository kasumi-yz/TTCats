// 独立 Electron 入口，只运行核对脚本，不启动正式应用、不读取用户存档。
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('tsx/cjs');
require('./verify-window-ledges.ts');
