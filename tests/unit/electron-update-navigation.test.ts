import { describe, expect, it } from 'vitest';
import { validateUpdateUrl } from '../../src/electron/update-navigation';

const release = 'https://github.com/zhouao010809-code/best-partners/releases';

describe('validateUpdateUrl', () => {
  it.each([
    release,
    `${release}/tag/v0.1.0`,
    `${release}/download/v0.1.0/Best-Partners-arm64.dmg`,
  ])('accepts official release URL %s', (value) => {
    expect(validateUpdateUrl(value)).toBe(value);
  });

  it.each([
    'http://github.com/zhouao010809-code/best-partners/releases',
    'https://github.com/other-owner/best-partners/releases',
    'https://github.com/zhouao010809-code/other-repo/releases',
    'https://gitlab.com/zhouao010809-code/best-partners/releases',
    'file:///tmp/update.dmg',
    'javascript:alert(1)',
    'https://user:password@github.com/zhouao010809-code/best-partners/releases',
    'https://github.com:443/zhouao010809-code/best-partners/releases',
    `${release}?download=1`,
    `${release}#download`,
    `${release}/not-a-release-path`,
    `${release}/tag`,
    `${release}/download/v0.1.0`,
    '',
    ' '.repeat(2049),
    42,
    null,
  ])('rejects invalid update URL %s', (value) => {
    expect(() => validateUpdateUrl(value)).toThrow('UPDATE_URL_INVALID');
  });
});
