import { strToU8, zipSync } from 'fflate';
import { zh } from '../../shared/strings.zh-CN';

const text = zh.diagnostics;

export interface Privacy {
  /** 用户目录，例如 C:\Users\名字。 */
  home: string;
  /** 电脑用户名。 */
  username: string;
}

export interface DiagnosticsInput {
  /** 日志目录下的全部文件，name 不带目录。 */
  logs: { name: string; text: string }[];
  /** save.json 的原文；没有存档时为 null。 */
  save: string | null;
  version: Record<string, unknown>;
  system: Record<string, unknown>;
  content: Record<string, unknown>;
  privacy: Privacy;
}

export const DIAGNOSTICS_FILES = {
  readme: '说明.txt',
  save: 'save.json',
  version: 'version.json',
  system: 'system.json',
  content: 'content.json',
  logs: 'logs/',
} as const;

const separator = String.raw`(?:\\+|/+)`;
const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Windows 自带的公共账户目录，不是某个人的名字。
const sharedProfiles = new Set(['public', 'default', 'default user', 'all users']);

/**
 * 把文本里的用户目录和用户名换成占位符。
 * 路径可能是正斜杠、反斜杠，也可能在日志的 JSON 编码里变成 \\ 甚至 \\\\，统一按"任意个分隔符"匹配。
 */
export function redact(source: string, privacy: Privacy): string {
  let result = source;
  const segments = privacy.home.split(/[\\/]+/).filter((segment) => segment !== '');
  if (segments.length > 0) {
    const home = segments
      .map((segment) => escape(segment).replace(/ /g, '(?: |%20)'))
      .join(separator);
    result = result.replace(new RegExp(home, 'giu'), text.homePlaceholder);
  }
  // 兜底：短文件名（NAME~1）或其他账户的用户目录。名字可以带空格，只要后面跟着分隔符。
  const word = String.raw`[^\\/:*?"<>|\s]+`;
  result = result.replace(
    new RegExp(
      String.raw`([A-Za-z]:${separator}Users${separator})((?:${word} )*${word}(?=[\\/])|${word})`,
      'giu',
    ),
    (match: string, prefix: string, name: string) =>
      sharedProfiles.has(name.toLowerCase()) ? match : prefix + text.userPlaceholder,
  );
  const username = privacy.username.trim();
  if (username !== '')
    result = result.replace(
      new RegExp(String.raw`(?<![\p{L}\p{N}_])${escape(username)}(?![\p{L}\p{N}_])`, 'giu'),
      text.userPlaceholder,
    );
  return result;
}

const json = (value: unknown): string => JSON.stringify(value, null, 2) + '\n';

/** 按 D13 组装诊断压缩包。所有文本都先替换隐私信息再写入。 */
export function buildDiagnosticsZip(input: DiagnosticsInput): Uint8Array {
  const clean = (value: string): Uint8Array => strToU8(redact(value, input.privacy));
  const files: Record<string, Uint8Array> = {
    [DIAGNOSTICS_FILES.readme]: clean(
      text.readme([
        { name: DIAGNOSTICS_FILES.readme, about: text.files.readme },
        { name: DIAGNOSTICS_FILES.logs, about: text.files.logs },
        {
          name: DIAGNOSTICS_FILES.save,
          about: input.save === null ? text.noSave : text.files.save,
        },
        { name: DIAGNOSTICS_FILES.version, about: text.files.version },
        { name: DIAGNOSTICS_FILES.system, about: text.files.system },
        { name: DIAGNOSTICS_FILES.content, about: text.files.content },
      ]),
    ),
    [DIAGNOSTICS_FILES.version]: clean(json(input.version)),
    [DIAGNOSTICS_FILES.system]: clean(json(input.system)),
    [DIAGNOSTICS_FILES.content]: clean(json(input.content)),
  };
  if (input.save !== null) files[DIAGNOSTICS_FILES.save] = clean(input.save);
  for (const log of input.logs) files[DIAGNOSTICS_FILES.logs + log.name] = clean(log.text);
  return zipSync(files, { level: 6 });
}
