// npm run validate:content：校验 content/ 下的猫咪包和事件配置。
import { resolve } from 'node:path';
import { zh } from '../src/shared/strings.zh-CN';
import { validateContentDir } from './lib/validate-content';
import { contentDir } from './lib/paths';

// 正式内容保留档案草稿；测试内容和运行时严格检查必需片段。
const reports = [
  validateContentDir(contentDir),
  validateContentDir(resolve(contentDir, '../app/test-content'), true),
];
const report = {
  checkedFiles: reports.reduce((sum, item) => sum + item.checkedFiles, 0),
  problems: reports.flatMap((item) => item.problems),
};
if (report.problems.length > 0) {
  console.error(zh.validation.summaryFailed(report.problems.length));
  for (const problem of report.problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(zh.validation.summaryOk(report.checkedFiles));
