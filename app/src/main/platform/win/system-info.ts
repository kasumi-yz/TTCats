import * as os from 'node:os';
import type { SystemInfo } from '../types';

/** Windows 的系统信息。个别环境拿不到账户信息时，退回 USERNAME 环境变量和用户目录名。 */
export function readWindowsSystemInfo(): SystemInfo {
  const home = os.homedir();
  let username = process.env['USERNAME'] ?? home.split(/[\\/]/).at(-1) ?? '';
  try {
    username = os.userInfo().username;
  } catch {
    // 用上面的退路。
  }
  const cpus = os.cpus();
  return {
    home,
    username,
    os: { version: os.version(), release: os.release(), arch: os.arch() },
    cpu: { model: cpus[0]?.model.trim() ?? null, cores: cpus.length },
    memory: { totalBytes: os.totalmem(), freeBytes: os.freemem() },
  };
}
