import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { listPackage } from '@electron/asar';

const root = resolve(process.argv[2] ?? 'dist/win-unpacked');
const source = resolve(import.meta.dirname, '../../content');
const resources = join(root, 'resources');
const archive = join(resources, 'app.asar');

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

const normalize = (path: string) => path.replaceAll('\\', '/').replace(/^\//, '');
if (!existsSync(archive)) throw new Error(`安装包缺少应用文件：${archive}`);
const packaged = [
  ...files(root).map((path) => normalize(relative(root, path))),
  ...listPackage(archive, { isPack: false }).map((path) => `resources/app.asar/${normalize(path)}`),
].sort();
const forbidden =
  /(^|\/)(test-content|test-[^/]*|scripts|e2e|tests?|__tests__)(\/|$)|\.(test|spec)\.[^/]+$/;
// 第三方依赖的测试也不应发布；检查 ASAR 内部及解包后的原生模块。
const leaked = packaged.filter((path) => forbidden.test(path));
if (leaked.length) throw new Error(`安装包包含测试内容或脚本：\n${leaked.join('\n')}`);
for (const required of [
  'out/main/index.js',
  'out/preload/index.cjs',
  'out/renderer/panels/index.html',
  'out/renderer/overlay/index.html',
]) {
  if (!packaged.includes(`resources/app.asar/${required}`))
    throw new Error(`安装包缺少入口：${required}`);
}
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const expected = files(source)
  .map((path) => normalize(relative(source, path)))
  .sort();
const content = join(resources, 'content');
if (!existsSync(content)) throw new Error('安装包缺少正式 content/');
const actual = files(content)
  .map((path) => normalize(relative(content, path)))
  .sort();
if (!expected.length || JSON.stringify(actual) !== JSON.stringify(expected))
  throw new Error('安装包正式 content/ 文件清单与仓库不一致');
for (const path of expected) {
  if (hash(join(source, path)) !== hash(join(content, path)))
    throw new Error(`安装包正式内容不一致：${path}`);
}
console.log(packaged.join('\n'));
console.log(
  `安装包内容检查通过：${packaged.length} 项，正式内容 ${expected.length} 个文件，无测试猫咪包、测试脚本或 e2e。`,
);
