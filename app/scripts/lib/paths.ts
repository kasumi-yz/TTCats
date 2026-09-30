import { resolve } from 'node:path';

export const repoRoot = resolve(import.meta.dirname, '../../..');
export const contentDir = resolve(repoRoot, 'content');
export const schemasDir = resolve(repoRoot, 'schemas');
