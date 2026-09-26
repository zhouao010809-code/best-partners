import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { clearPreviousUpdateDownloads, downloadUpdateInstaller } from '../../src/electron/update-download.js';

const url = 'https://github.com/zhouao010809-code/best-partners/releases/download/v0.1.1/best-partners-0.1.1-arm64.dmg';
const body = Buffer.from('isolated update installer');
const digest = createHash('sha256').update(body).digest('hex');
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'update-download-test-')); roots.push(directory);
  return { directory, url, sha256: digest, size: body.length, signal: new AbortController().signal, onProgress: vi.fn(), fetcher: vi.fn(async () => new Response(body)) };
}

it('streams a checked installer into a private temporary directory and reports actual bytes', async () => {
  const input = await setup();
  const path = await downloadUpdateInstaller(input);
  expect(await readFile(path)).toEqual(body);
  expect(input.onProgress).toHaveBeenLastCalledWith(body.length, body.length);
  expect(input.fetcher).toHaveBeenCalledWith(url, expect.objectContaining({ redirect: 'manual' }));
});

it('cleans prior-session installers at startup without removing unrelated cache files', async () => {
  const input = await setup();
  await downloadUpdateInstaller(input);
  await writeFile(join(input.directory, 'keep.txt'), 'keep');
  await mkdir(join(input.directory, 'other-cache'));
  await clearPreviousUpdateDownloads(input.directory);
  expect((await readdir(input.directory)).sort()).toEqual(['keep.txt', 'other-cache']);
});

it.each(['hash', 'short', 'large'] as const)('removes partial files for a %s mismatch', async kind => {
  const input = await setup();
  if (kind === 'hash') input.sha256 = '0'.repeat(64);
  else input.size += kind === 'short' ? 1 : -1;
  await expect(downloadUpdateInstaller(input)).rejects.toThrow();
  expect(await readdir(input.directory)).toEqual([]);
});

it('follows only GitHub asset HTTPS redirects and validates the final bytes', async () => {
  const input = await setup();
  input.fetcher.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/github-production-release-asset/file?signature=test' } }));
  expect(await readFile(await downloadUpdateInstaller(input))).toEqual(body);
  expect(input.fetcher).toHaveBeenCalledTimes(2);
});

it.each(['http://release-assets.githubusercontent.com/file', 'https://evil.example/file', 'https://user@release-assets.githubusercontent.com/file', 'https://release-assets.githubusercontent.com:444/file'])('rejects redirect %s', async location => {
  const input = await setup();
  input.fetcher.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location } }));
  await expect(downloadUpdateInstaller(input)).rejects.toThrow();
  expect(input.fetcher).toHaveBeenCalledTimes(1);
  expect(await readdir(input.directory)).toEqual([]);
});

it('rejects untrusted starting URLs before fetching', async () => {
  const input = await setup(); input.url = 'https://evil.example/update.dmg';
  await expect(downloadUpdateInstaller(input)).rejects.toThrow();
  expect(input.fetcher).not.toHaveBeenCalled();
});

it('cancels a streaming download and removes the incomplete file', async () => {
  const input = await setup();
  const abort = new AbortController(); input.signal = abort.signal;
  input.fetcher.mockImplementation(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(body.subarray(0, 3)); },
    pull() { abort.abort(); }
  })));
  await expect(downloadUpdateInstaller(input)).rejects.toThrow();
  expect(await readdir(input.directory)).toEqual([]);
});

it('refuses oversized metadata without downloading', async () => {
  const input = await setup(); input.size = 3 * 1024 ** 3;
  await expect(downloadUpdateInstaller(input)).rejects.toThrow();
  expect(input.fetcher).not.toHaveBeenCalled();
});
