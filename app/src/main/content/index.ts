import { resolve } from 'node:path';

/** 打包后只读安装包 content；开发环境可用 TTCATS_CONTENT_DIR 切到测试目录。 */
export function contentDirectory(options: {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
  env?: Record<string, string | undefined>;
}): string {
  if (options.isPackaged) return resolve(options.resourcesPath, 'content');
  const env = options.env ?? process.env;
  return env.TTCATS_CONTENT_DIR
    ? resolve(env.TTCATS_CONTENT_DIR)
    : resolve(options.appPath, '../content');
}

export { loadContent, validateContentDir } from './catalog';
export { registerContentScheme, registerContentProtocol } from './protocol';
