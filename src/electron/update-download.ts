import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { validateUpdateUrl } from './update-navigation.js';

export const MAX_UPDATE_BYTES = 2 * 1024 ** 3;

// Only this updater's prior-session directories are disposable. Run before
// starting any new transfer; never scan the vault or other user-data folders.
export async function clearPreviousUpdateDownloads(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  await Promise.all(entries.filter(entry => entry.isDirectory() && /^installer-[A-Za-z0-9]+$/u.test(entry.name))
    .map(entry => rm(join(directory, entry.name), { recursive: true, force: true })));
}

export type InstallerDownloadInput = {
  directory: string; url: string; sha256: string; size: number; signal: AbortSignal;
  onProgress(received: number, total: number): void;
  fetcher?: typeof fetch;
};

function validateRedirect(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) throw new Error('UPDATE_REDIRECT_INVALID');
  if (url.hostname === 'github.com') return validateUpdateUrl(value);
  if (url.hostname !== 'release-assets.githubusercontent.com') throw new Error('UPDATE_REDIRECT_INVALID');
  return url.href;
}

export async function downloadUpdateInstaller(input: InstallerDownloadInput): Promise<string> {
  let url = validateUpdateUrl(input.url);
  if (!new URL(url).pathname.includes('/releases/download/') || !url.endsWith('.dmg')
    || !/^[a-f\d]{64}$/u.test(input.sha256) || !Number.isSafeInteger(input.size)
    || input.size <= 0 || input.size > MAX_UPDATE_BYTES) throw new Error('UPDATE_DOWNLOAD_INVALID');
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(15 * 60_000)]);
  signal.throwIfAborted();
  const fetcher = input.fetcher ?? fetch;
  await mkdir(input.directory, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(input.directory, 'installer-'));
  try {
    let response: Response | undefined;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      response = await fetcher(url, { redirect: 'manual', signal, headers: { 'User-Agent': 'best-partners-update-download' } });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location || redirects === 5) throw new Error('UPDATE_REDIRECT_INVALID');
      url = validateRedirect(new URL(location, url).href);
      response = undefined;
    }
    if (!response?.ok || !response.body) throw new Error('UPDATE_DOWNLOAD_FAILED');
    const advertisedSize = response.headers.get('content-length');
    if (advertisedSize !== null && Number(advertisedSize) !== input.size) {
      await response.body.cancel(); throw new Error('UPDATE_SIZE_MISMATCH');
    }
    const hash = createHash('sha256');
    let received = 0;
    let lastProgress = 0;
    const path = join(temporary, 'update.dmg');
    input.onProgress(0, input.size);
    const verify = new Transform({ transform(chunk: Buffer, _encoding, next) {
      received += chunk.length;
      if (received > input.size) { next(new Error('UPDATE_SIZE_MISMATCH')); return; }
      hash.update(chunk);
      const now = Date.now();
      if (received === input.size || now - lastProgress >= 100) {
        lastProgress = now; input.onProgress(received, input.size);
      }
      next(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>), verify, createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal });
    signal.throwIfAborted();
    if (received !== input.size || hash.digest('hex') !== input.sha256) throw new Error('UPDATE_INTEGRITY_FAILED');
    return path;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyInstaller(path: string, sha256: string, size: number): Promise<void> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    if (bytes > size) throw new Error('UPDATE_INTEGRITY_FAILED');
    hash.update(chunk);
  }
  if (bytes !== size || hash.digest('hex') !== sha256) throw new Error('UPDATE_INTEGRITY_FAILED');
}
