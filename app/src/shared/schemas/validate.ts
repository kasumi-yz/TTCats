// M1 定稿（#18）。
// 用 schema 校验内容，把 zod 的报错翻成中文，并说清楚是哪个字段出了什么问题（硬性规则 4）。
import { z } from 'zod';
import { zh } from '../strings.zh-CN';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; problems: string[] };

const zhLocale = z.locales.zhCN();

function describePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return zh.validation.wholeFile;
  const dotted = path
    .map((key, i) => (typeof key === 'number' ? `[${key}]` : `${i === 0 ? '' : '.'}${String(key)}`))
    .join('');
  const last = [...path].reverse().find((key): key is string => typeof key === 'string');
  const label = last === undefined ? undefined : zh.fields[last];
  return label === undefined ? dotted : `${dotted}（${label}）`;
}

function describeIssue(issue: z.core.$ZodIssue): string {
  const v = zh.validation;
  if (issue.code === 'unrecognized_keys') {
    return issue.path.length === 0
      ? v.unknownFields(issue.keys)
      : v.unknownFieldsIn(describePath(issue.path), issue.keys);
  }
  if (issue.code === 'invalid_type' && issue.input === undefined) {
    return v.missingField(describePath(issue.path));
  }
  return v.badField(describePath(issue.path), issue.message);
}

/** 用 schema 校验一份数据；失败时返回中文的问题列表（不含是哪只猫、哪个文件，由调用方加上）。 */
export function validateWith<S extends z.ZodType>(
  schema: S,
  data: unknown,
): ValidationResult<z.output<S>> {
  const result = schema.safeParse(data, {
    reportInput: true,
    error: (issue) => zhLocale.localeError(issue),
  });
  if (result.success) return { ok: true, value: result.data };
  // 同一个字段可能有好几道检查报出同一句话（比如日期），重复的只留一条
  return { ok: false, problems: [...new Set(result.error.issues.map(describeIssue))] };
}
