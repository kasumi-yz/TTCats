// npm run start:test-pack（在 app/ 里运行）：按《验收清单》手动验收时，用测试猫咪包启动正式应用。
// 存档放在系统临时目录的 ttcats-m1-acceptance 里，不碰真实存档；
// 退出后再次运行会读同一份存档，用来检查"退出再启动，状态还在"。
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appRoot } from './lib/desktop';

const dataDirectory = join(tmpdir(), 'ttcats-m1-acceptance');
mkdirSync(dataDirectory, { recursive: true });
const electron = createRequire(join(appRoot, 'package.json'))('electron') as string;
const env: NodeJS.ProcessEnv = { ...process.env, TTCATS_TEST_APP_DATA: dataDirectory };
delete env['ELECTRON_RENDERER_URL'];
delete env['ELECTRON_RUN_AS_NODE'];
console.log(`用测试猫咪包启动 TTCats，存档目录：${dataDirectory}`);
const child = spawn(electron, [appRoot, '--test-content'], { env, stdio: 'inherit' });
child.on('exit', (code) => {
  process.exitCode = code ?? 0;
});
