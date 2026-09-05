import { describe, expect, it } from 'vitest';
import { validateFilesystemPath, validateFilesystemRoot } from '../../src/server/vault/filesystem-path.js';

describe('filesystem lexical paths', () => {
  it.each(['02知识库/转化率100%.md', '02知识库/Cafe\u0301.md', '02知识库/Café.md', '01图书馆/%2e%2e.md'])('preserves %s', (path) => {
    expect(validateFilesystemPath(path)).toBe(path);
  });
  it.each(['', '/etc/passwd', '02知识库', '02知识库/', '02知识库//a', '02知识库/../a', '02知识库/./a', '02知识库/.a', '02知识库/a\\b', '02知识库/a\0b', '03大讲堂/a', '04秘密/a', '02知识库/\ud800'])('rejects %s', (path) => {
    expect(() => validateFilesystemPath(path)).toThrow('PATH_NOT_ALLOWED');
  });
  it('permits lecture directory existence checks only', () => {
    expect(validateFilesystemPath('03大讲堂', 'directory-check')).toBe('03大讲堂');
    expect(() => validateFilesystemPath('03大讲堂', 'directory')).toThrow('PATH_NOT_ALLOWED');
    expect(() => validateFilesystemPath('03大讲堂/a', 'directory-check')).toThrow('PATH_NOT_ALLOWED');
  });
  it('validates absolute roots lexically without rewriting their identity', () => {
    expect(validateFilesystemRoot('/private/tmp/Cafe\u0301')).toBe('/private/tmp/Cafe\u0301');
    for (const root of ['relative', '/', '/tmp/../other', '/tmp//a', '/tmp/a/']) {
      expect(() => validateFilesystemRoot(root)).toThrow('PATH_NOT_ALLOWED');
    }
  });
});
