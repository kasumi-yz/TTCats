import { describe, expect, it } from 'vitest';
import { contentUrl } from './content-url';

describe('猫咪包文件的地址', () => {
  it('每一段单独编码，斜杠保留', () => {
    expect(contentUrl('test-a', 'clips/walk.webm')).toBe(
      'ttcats-content://cats/test-a/clips/walk.webm',
    );
    expect(contentUrl('doudou', 'clips/豆豆 1.webm')).toBe(
      'ttcats-content://cats/doudou/clips/%E8%B1%86%E8%B1%86%201.webm',
    );
  });
});
