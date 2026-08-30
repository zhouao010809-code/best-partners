import { describe, expect, it } from 'vitest';
import { normalizeVaultPath } from '../../src/server/security/vault-path.js';

describe('normalizeVaultPath', () => {
  it.each([
    '/etc/passwd',
    '../02知识库/a.md',
    '01图书馆/../../x.md',
    '01图书馆\\x.md',
    '.obsidian/plugins/x',
    '02知识库/%252e%252e/x.md'
  ])('rejects %s', (value) => {
    expect(() => normalizeVaultPath(value, 'read')).toThrowError('PATH_NOT_ALLOWED');
  });

  it('normalizes decomposed Unicode in an allowed markdown path', () => {
    expect(normalizeVaultPath('01图书馆/来自个人/Cafe\u0301.md', 'read'))
      .toBe('01图书馆/来自个人/Café.md');
  });

  it('prevents writes to the rules area', () => {
    expect(() => normalizeVaultPath('00大脑规则/00_大脑规范.md', 'write'))
      .toThrowError('PATH_NOT_ALLOWED');
  });
});
