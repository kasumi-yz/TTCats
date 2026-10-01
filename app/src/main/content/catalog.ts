// 校验 content/ 下的全部内容，报错用中文，并说清楚是哪只猫、哪个文件、缺了什么（硬性规则 4）。
import { existsSync, readdirSync, readFileSync, statSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { z } from 'zod';
import {
  CatSchema,
  ClipSchema,
  EventSchema,
  validateWith,
  missingRequiredClips,
  type Clip,
} from '../../shared/schemas';
import { zh } from '../../shared/strings.zh-CN';
import type { ContentCatalog } from '../../shared/core-api';
import { hitMaskLayout } from '../../shared/hitmask';

export interface ContentReport {
  checkedFiles: number;
  problems: string[];
  catalog: ContentCatalog;
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
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
}

export function validateContentDir(contentDir: string, requireClips = false): ContentReport {
  const report: ContentReport = {
    checkedFiles: 0,
    problems: [],
    catalog: { cats: {}, disabled: [] },
  };
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

  /** 确认猫咪包里引用的路径在包内，并且是一个普通文件。 */
  function requireFile(packDir: string, who: string, from: string, field: string, path: string) {
    const target = resolve(packDir, path);
    const inside = relative(packDir, target);
    let problem: string | undefined;
    if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      problem = v.referencedOutsidePack(field, path);
    } else if (!existsSync(target)) {
      problem = v.referencedFileMissing(field, path);
    } else if (!isInside(realpathSync(packDir), realpathSync(target))) {
      problem = v.referencedOutsidePack(field, path);
    } else if (!statSync(target).isFile()) {
      problem = v.referencedNotAFile(field, path);
    }
    if (problem !== undefined) report.problems.push(`${who} ${rel(from)}：${problem}`);
  }

  for (const folder of listDirs(join(contentDir, 'cats'))) {
    const problemStart = report.problems.length;
    const clips: Clip[] = [];
    let cat;
    const packDir = join(contentDir, 'cats', folder);
    const who = v.catPack(folder);
    const catFile = join(packDir, 'cat.json');
    try {
      if (!isInside(realpathSync(join(contentDir, 'cats')), realpathSync(packDir))) {
        report.problems.push(`${who}：${v.referencedOutsidePack('cat.json', folder)}`);
      }

      if (!existsSync(catFile)) {
        report.problems.push(`${who}：${v.fileMissing('cat.json')}`);
      } else {
        cat = check(CatSchema, catFile, who);
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
          if (clips.some((other) => other.name === clip.name && other.variant === clip.variant)) {
            report.problems.push(
              `${who} ${rel(clipFile)}：${zh.content.duplicateClip(clip.name, clip.variant)}`,
            );
          }
          clips.push(clip);
          requireFile(packDir, who, clipFile, 'video', clip.video);
          requireFile(packDir, who, clipFile, 'hitMask', clip.hitMask);
          const mask = resolve(packDir, clip.hitMask);
          if (
            existsSync(mask) &&
            statSync(mask).isFile() &&
            isInside(realpathSync(packDir), realpathSync(mask)) &&
            statSync(mask).size !== hitMaskLayout(clip).totalBytes
          ) {
            report.problems.push(
              `${who} ${rel(clipFile)}：${zh.content.maskLength(clip.hitMask, hitMaskLayout(clip).totalBytes, statSync(mask).size)}`,
            );
          }
        }
      }
      if (requireClips) {
        const missing = missingRequiredClips(clips.map((clip) => clip.name));
        if (missing.length) report.problems.push(`${who}：${zh.content.missingClips(missing)}`);
      }
    } catch (error) {
      report.problems.push(
        `${who}：${zh.content.packReadFailed(error instanceof Error ? error.message : String(error))}`,
      );
    }
    const problems = report.problems.slice(problemStart);
    if (cat !== undefined && problems.length === 0) report.catalog.cats[folder] = { cat, clips };
    else report.catalog.disabled.push({ cat: folder, problems });
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

export function isInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/** 运行时始终检查必需片段，坏包只停用自身。 */
export function loadContent(
  contentDir: string,
  log: (problem: string) => void = console.error,
): ContentCatalog {
  const report = validateContentDir(contentDir, true);
  report.problems.forEach((problem) => {
    log(problem);
  });
  return report.catalog;
}
