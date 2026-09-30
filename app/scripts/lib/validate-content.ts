// 校验 content/ 下的全部内容，报错用中文，并说清楚是哪只猫、哪个文件、缺了什么（硬性规则 4）。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type { z } from 'zod';
import { CatSchema, ClipSchema, EventSchema, validateWith } from '../../src/shared/schemas';
import { zh } from '../../src/shared/strings.zh-CN';

export interface ContentReport {
  checkedFiles: number;
  problems: string[];
}

const v = zh.validation;

function listJson(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .sort()
    .map((n) => join(dir, n));
}

function listDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => statSync(join(dir, n)).isDirectory())
    .sort();
}

export function validateContentDir(contentDir: string): ContentReport {
  const report: ContentReport = { checkedFiles: 0, problems: [] };
  const rel = (file: string) => relative(join(contentDir, '..'), file).replaceAll('\\', '/');

  /** 读一个 JSON 文件并校验；出错时把问题记进报告，前缀写明是谁、哪个文件。 */
  function check<S extends z.ZodType>(
    schema: S,
    file: string,
    who: string,
  ): z.output<S> | undefined {
    report.checkedFiles += 1;
    const prefix = `${who} ${rel(file)}：`;
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      report.problems.push(prefix + v.fileNotJson((error as Error).message));
      return undefined;
    }
    const result = validateWith(schema, data);
    if (!result.ok) {
      report.problems.push(...result.problems.map((p) => prefix + p));
      return undefined;
    }
    return result.value;
  }

  function requireFile(packDir: string, who: string, from: string, field: string, path: string) {
    if (!existsSync(join(packDir, path))) {
      report.problems.push(`${who} ${rel(from)}：${v.referencedFileMissing(field, path)}`);
    }
  }

  for (const folder of listDirs(join(contentDir, 'cats'))) {
    const packDir = join(contentDir, 'cats', folder);
    const who = v.catPack(folder);
    const catFile = join(packDir, 'cat.json');
    if (!existsSync(catFile)) {
      report.problems.push(`${who}：${v.fileMissing('cat.json')}`);
    } else {
      const cat = check(CatSchema, catFile, who);
      if (cat !== undefined) {
        if (cat.id !== folder) {
          report.problems.push(`${who} ${rel(catFile)}：${v.idMismatch(cat.id, folder)}`);
        }
        for (const [slot, files] of Object.entries(cat.sounds)) {
          for (const path of files) requireFile(packDir, who, catFile, `sounds.${slot}`, path);
        }
      }
    }
    for (const clipFile of listJson(join(packDir, 'clips'))) {
      const clip = check(ClipSchema, clipFile, who);
      if (clip !== undefined) {
        requireFile(packDir, who, clipFile, 'video', clip.video);
        requireFile(packDir, who, clipFile, 'hitMask', clip.hitMask);
      }
    }
  }

  for (const eventFile of listJson(join(contentDir, 'events'))) {
    const expectedId = basename(eventFile, '.json');
    const who = v.eventFile(expectedId);
    const event = check(EventSchema, eventFile, who);
    if (event !== undefined && event.id !== expectedId) {
      report.problems.push(`${who} ${rel(eventFile)}：${v.idMismatch(event.id, expectedId)}`);
    }
  }

  return report;
}
