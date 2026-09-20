import { describe, expect, it, vi } from 'vitest';
import {
  RELEASES_URL,
  RELEASE_PAGE_URL,
  checkForUpdate,
  type UpdateCheckResult,
} from '../../src/electron/update-check';

const release = (overrides: Record<string, unknown> = {}) => {
  const tag = String(overrides.tag_name ?? 'v0.1.2');
  const tagPath = tag.replace(/^v/, '');
  return {
  tag_name: 'v0.1.2',
  draft: false,
  prerelease: false,
  html_url: `${RELEASE_PAGE_URL}/tag/${tag}`,
  body: '## Notes\n\n**Fast** fix [details](https://example.invalid/details).',
  published_at: '2026-09-20T00:00:00Z',
  assets: [
    { name: `Best-Partners-${tagPath}-arm64.dmg`, browser_download_url: `https://github.com/zhouao010809-code/best-partners/releases/download/${tag}/Best-Partners-${tagPath}-arm64.dmg` },
    { name: `Best-Partners-${tagPath}-x64.dmg`, browser_download_url: `https://github.com/zhouao010809-code/best-partners/releases/download/${tag}/Best-Partners-${tagPath}-x64.dmg` },
  ],
  ...overrides,
  };
};

const fetcher = (payload: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(payload), { status }));
const input = (currentVersion: string, payload: unknown, extra: Record<string, unknown> = {}) => ({
  currentVersion,
  fetcher: fetcher(payload),
  now: () => new Date('2026-09-20T12:00:00Z'),
  ...extra,
});

function expectError(result: UpdateCheckResult, code: string) {
  expect(result.kind).toBe('error');
  if (result.kind === 'error') expect(result.code).toBe(code);
}

describe('checkForUpdate', () => {
  it('exports the stable GitHub feed URLs', () => {
    expect(RELEASES_URL).toBe('https://api.github.com/repos/zhouao010809-code/best-partners/releases?per_page=20');
    expect(RELEASE_PAGE_URL).toBe('https://github.com/zhouao010809-code/best-partners/releases');
  });

  it('selects the highest stable arm64 release and sanitizes notes', async () => {
    const result = await checkForUpdate(input('0.1.1', [
      release({ tag_name: 'v9.0.0', draft: true }),
      release({ tag_name: 'v0.1.2-beta.1', prerelease: true }),
      release({ tag_name: 'v0.1.1' }),
      release({ tag_name: 'v0.1.2' }),
      release({ tag_name: 'v0.1.3' }),
    ]));
    expect(result).toMatchObject({ kind: 'available', currentVersion: '0.1.1', version: '0.1.3', releaseUrl: `${RELEASE_PAGE_URL}/tag/v0.1.3` });
    if (result.kind === 'available') {
      expect(result.assetUrl).toContain('v0.1.3/');
      expect(result.notes).toBe('Notes\n\nFast fix details.');
      expect(result.publishedAt).toBe('2026-09-20T00:00:00Z');
    }
  });

  it('skips prerelease releases for stable apps', async () => {
    const result = await checkForUpdate(input('0.1.1', [release({ tag_name: 'v0.1.2-beta.1', prerelease: true })]));
    expect(result).toMatchObject({ kind: 'up-to-date', currentVersion: '0.1.1' });
  });

  it('allows a prerelease app to upgrade to a higher prerelease', async () => {
    const result = await checkForUpdate(input('0.1.2-beta.1', [release({ tag_name: 'v0.1.2-beta.2', prerelease: true })]));
    expect(result).toMatchObject({ kind: 'available', version: '0.1.2-beta.2' });
  });

  it('returns up-to-date when there is no matching arm64 asset', async () => {
    const result = await checkForUpdate(input('0.1.1', [release({ assets: [{ name: 'Best-Partners-0.1.2-x64.dmg', browser_download_url: 'https://github.com/x/x/releases/download/v0.1.2/x.dmg' }] })]));
    expect(result).toMatchObject({ kind: 'up-to-date', currentVersion: '0.1.1' });
  });

  it('truncates long notes by Unicode characters', async () => {
    const result = await checkForUpdate(input('0.1.1', [release({ body: '😀'.repeat(5000) })]));
    expect(result.kind).toBe('available');
    if (result.kind === 'available') expect(Array.from(result.notes ?? '')).toHaveLength(4000);
  });

  it('rejects a non-string asset URL as an invalid feed', async () => {
    expectError(await checkForUpdate(input('0.1.1', [release({ assets: [{ name: 'x-arm64.dmg', browser_download_url: 42 }] })])), 'UPDATE_FEED_INVALID');
  });

  it('returns feed unavailable for HTTP and fetch failures', async () => {
    expectError(await checkForUpdate({ currentVersion: '0.1.1', fetcher: fetcher({}, 503) }), 'UPDATE_FEED_UNAVAILABLE');
    expectError(await checkForUpdate({ currentVersion: '0.1.1', fetcher: vi.fn(async () => { throw new Error('network'); }) }), 'UPDATE_FEED_UNAVAILABLE');
  });

  it('returns feed invalid for malformed JSON and schema', async () => {
    expectError(await checkForUpdate({ currentVersion: '0.1.1', fetcher: vi.fn(async () => new Response('{', { status: 200 })) }), 'UPDATE_FEED_INVALID');
    expectError(await checkForUpdate(input('0.1.1', { nope: true })), 'UPDATE_FEED_INVALID');
  });

  it('returns version invalid for malformed current versions', async () => {
    const fetch = vi.fn();
    const result = await checkForUpdate({ currentVersion: 'v1.2', fetcher: fetch });
    expectError(result, 'UPDATE_VERSION_INVALID');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports stable versions as up-to-date', async () => {
    const result = await checkForUpdate(input('0.1.2', [release({ tag_name: 'v0.1.2' })]));
    expect(result).toMatchObject({ kind: 'up-to-date', currentVersion: '0.1.2' });
  });

  it('uses the GitHub request headers and timeout signal', async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(_url).toBe(RELEASES_URL);
      expect(init?.headers).toEqual({ Accept: 'application/vnd.github+json', 'User-Agent': 'best-partners-update-check' });
      expect(init?.signal).toBeDefined();
      return new Response('[]', { status: 200 });
    });
    await checkForUpdate({ currentVersion: '0.1.1', fetcher: fetch });
  });
});
