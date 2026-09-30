// npm run validate:content：校验 content/ 下的猫咪包和事件配置。
import { zh } from '../src/shared/strings.zh-CN';
import { validateContentDir } from './lib/validate-content';
import { contentDir } from './lib/paths';

const report = validateContentDir(contentDir);
if (report.problems.length > 0) {
  console.error(zh.validation.summaryFailed(report.problems.length));
  for (const problem of report.problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(zh.validation.summaryOk(report.checkedFiles));
