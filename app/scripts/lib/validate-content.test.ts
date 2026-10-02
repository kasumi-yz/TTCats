import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contentDir as realContentDir } from './paths';
import { validateContentDir } from './validate-content';

const exampleCat = JSON.parse(
  readFileSync(join(realContentDir, 'cats/doudou/cat.json'), 'utf8'),
) as Record<string, unknown>;

let root: string;

function writeJson(relativePath: string, data: unknown) {
  const file = join(root, relativePath);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(data));
}

beforeEach(() => {
  root = join(mkdtempSync(join(tmpdir(), 'ttcats-')), 'content');
  mkdirSync(root);
});
afterEach(() => {
  rmSync(join(root, '..'), { recursive: true, force: true });
});

describe('validate:content', () => {
  it('仓库里的示例猫咪包能通过校验', () => {
    expect(validateContentDir(realContentDir).problems).toEqual([]);
  });

  it('删掉必填字段时，用中文说清楚是哪只猫、缺了什么', () => {
    const withoutName = { ...exampleCat };
    delete withoutName['name'];
    writeJson('cats/doudou/cat.json', withoutName);
    expect(validateContentDir(root).problems).toEqual([
      '猫咪包「doudou」 content/cats/doudou/cat.json：缺少必填字段 name（名字）',
    ]);
  });

  it('嵌套字段缺失时给出完整路径', () => {
    const personality = { ...(exampleCat['personality'] as object), patience: undefined };
    writeJson('cats/doudou/cat.json', { ...exampleCat, personality });
    expect(validateContentDir(root).problems).toEqual([
      '猫咪包「doudou」 content/cats/doudou/cat.json：缺少必填字段 personality.patience（耐心）',
    ]);
  });

  it('拼错的字段会被指出来', () => {
    writeJson('cats/doudou/cat.json', { ...exampleCat, nmae: '豆豆' });
    expect(validateContentDir(root).problems[0]).toContain('有不认识的字段：nmae');
  });

  it('数值超出范围时报中文错误', () => {
    writeJson('cats/doudou/cat.json', { ...exampleCat, relativeSize: 3 });
    const [problem] = validateContentDir(root).problems;
    expect(problem).toMatch(/^猫咪包「doudou」 .*字段 relativeSize（相对体型） 不对：.*1\.5/);
  });

  it('id 和文件夹名不一致时报错', () => {
    writeJson('cats/doudou2/cat.json', { ...exampleCat, sounds: { meow: [], purr: [] } });
    expect(validateContentDir(root).problems).toEqual([
      '猫咪包「doudou2」 content/cats/doudou2/cat.json：id 写的是「doudou」，但它所在的文件夹或文件名是「doudou2」，两者必须一样',
    ]);
  });

  it('缺少 cat.json 时报错', () => {
    mkdirSync(join(root, 'cats/kubo'), { recursive: true });
    expect(validateContentDir(root).problems).toEqual(['猫咪包「kubo」：缺少文件 cat.json']);
  });

  it('不是合法 JSON 时报错', () => {
    mkdirSync(join(root, 'cats/kubo'), { recursive: true });
    writeFileSync(join(root, 'cats/kubo/cat.json'), '{ "id": ');
    expect(validateContentDir(root).problems[0]).toMatch(
      /^猫咪包「kubo」 content\/cats\/kubo\/cat\.json：不是合法的 JSON：/,
    );
  });

  it('声音位指向的文件不存在时报错', () => {
    writeJson('cats/doudou/cat.json', {
      ...exampleCat,
      sounds: { meow: ['sounds/meow-1.ogg'], purr: [] },
    });
    expect(validateContentDir(root).problems).toEqual([
      '猫咪包「doudou」 content/cats/doudou/cat.json：字段 sounds.meow 指向的文件不存在：sounds/meow-1.ogg',
    ]);
  });

  it('用换行伪装的路径不能引用猫咪包外面的文件', () => {
    // Codex 审查时的复现：content 的上一级放一个文件，再用带换行的 .. 路径去引用它
    writeFileSync(join(root, '..', 'outside.ogg'), '');
    writeJson('cats/doudou/cat.json', {
      ...exampleCat,
      sounds: { meow: ['\n/../../../../outside.ogg'], purr: [] },
    });
    const { problems } = validateContentDir(root);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('字段 sounds.meow[0]（喵叫） 不对：');
  });

  it('引用指向文件夹时报错', () => {
    mkdirSync(join(root, 'cats/doudou/sounds'), { recursive: true });
    writeJson('cats/doudou/cat.json', { ...exampleCat, sounds: { meow: ['sounds'], purr: [] } });
    expect(validateContentDir(root).problems).toEqual([
      '猫咪包「doudou」 content/cats/doudou/cat.json：字段 sounds.meow 指向的是文件夹，不是文件：sounds',
    ]);
  });

  it('引用存在的普通文件时通过', () => {
    mkdirSync(join(root, 'cats/doudou/sounds'), { recursive: true });
    writeFileSync(join(root, 'cats/doudou/sounds/meow-1.ogg'), '');
    writeJson('cats/doudou/cat.json', {
      ...exampleCat,
      sounds: { meow: ['sounds/meow-1.ogg'], purr: [] },
    });
    expect(validateContentDir(root).problems).toEqual([]);
  });

  it('事件配置的 id 必须和文件名一样', () => {
    writeJson('events/good-morning.json', {
      schemaVersion: 1,
      id: 'morning',
      name: '早安',
      trigger: { type: 'firstLaunchOfDay' },
      cooldownMinutes: 0,
      cats: { min: 1, max: 3 },
      steps: [{ do: 'sound', slot: 'meow' }],
    });
    expect(validateContentDir(root).problems).toEqual([
      '事件配置「good-morning」 content/events/good-morning.json：id 写的是「morning」，但它所在的文件夹或文件名是「good-morning」，两者必须一样',
    ]);
  });
});
