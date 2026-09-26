import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { validateUpdateUrl } from './update-navigation.js';

export const MAX_UPDATE_BYTES = 2 * 1024 ** 3;
const TOTAL_DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_INACTIVITY_TIMEOUT_MS = 30_000;
type TimeoutPhase = 'connection' | 'first-byte' | 'stalled' | 'total';
const timeoutCodes = {
  connection: 'UPDATE_CONNECTION_TIMEOUT', 'first-byte': 'UPDATE_FIRST_BYTE_TIMEOUT',
  stalled: 'UPDATE_DOWNLOAD_STALLED', total: 'UPDATE_DOWNLOAD_TIMEOUT'
} as const;
export class UpdateDownloadTimeoutError extends Error {
  readonly code: typeof timeoutCodes[TimeoutPhase];
  constructor(readonly phase: TimeoutPhase) {
    super(timeoutCodes[phase]); this.name = 'UpdateDownloadTimeoutError'; this.code = timeoutCodes[phase];
  }
}

// A custom transport must not leave the updater waiting if it misses an abort.
// Dispose any response that arrives after the caller has stopped waiting.
function abortable<T>(pending: Promise<T>, signal: AbortSignal, late?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    if (signal.aborted) aborted(); else signal.addEventListener('abort', aborted, { once: true });
    void pending.then(value => {
      signal.removeEventListener('abort', aborted);
      if (signal.aborted) { late?.(value); reject(signal.reason); } else resolve(value);
    }, error => { signal.removeEventListener('abort', aborted); reject(error); });
  });
}

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
  inactivityTimeoutMs?: number;
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
  input.signal.throwIfAborted();
  const inactivityTimeout = input.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;
  if (!Number.isSafeInteger(inactivityTimeout) || inactivityTimeout < 1 || inactivityTimeout > TOTAL_DOWNLOAD_TIMEOUT_MS) throw new Error('UPDATE_DOWNLOAD_INVALID');
  const deadlines = new AbortController();
  const signal = AbortSignal.any([input.signal, deadlines.signal]);
  const totalTimer = setTimeout(() => deadlines.abort(new UpdateDownloadTimeoutError('total')), TOTAL_DOWNLOAD_TIMEOUT_MS);
  totalTimer.unref();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const clearIdle = () => { if (idleTimer !== undefined) clearTimeout(idleTimer); idleTimer = undefined; };
  const arm = (phase: Exclude<TimeoutPhase, 'total'>) => {
    clearIdle(); idleTimer = setTimeout(() => deadlines.abort(new UpdateDownloadTimeoutError(phase)), inactivityTimeout); idleTimer.unref();
  };
  const fetcher = input.fetcher ?? fetch;
  let temporary: string | undefined;
  let response: Response | undefined;
  try {
    await mkdir(input.directory, { recursive: true, mode: 0o700 });
    temporary = await mkdtemp(join(input.directory, 'installer-'));
    signal.throwIfAborted();
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      arm('connection');
      response = await abortable(fetcher(url, { redirect: 'manual', signal, headers: { 'User-Agent': 'best-partners-update-download' } }), signal,
        late => { void late.body?.cancel().catch(() => undefined); });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      if (response.body) await abortable(response.body.cancel(), signal);
      const location = response.headers.get('location');
      if (!location || redirects === 5) throw new Error('UPDATE_REDIRECT_INVALID');
      url = validateRedirect(new URL(location, url).href);
      response = undefined;
    }
    if (!response?.ok || !response.body) throw new Error('UPDATE_DOWNLOAD_FAILED');
    arm('first-byte');
    const advertisedSize = response.headers.get('content-length');
    if (advertisedSize !== null && Number(advertisedSize) !== input.size) {
      await abortable(response.body.cancel(), signal); throw new Error('UPDATE_SIZE_MISMATCH');
    }
    const hash = createHash('sha256');
    let received = 0;
    let lastProgress = 0;
    const path = join(temporary, 'update.dmg');
    input.onProgress(0, input.size);
    const verify = new Transform({ transform(chunk: Buffer, _encoding, next) {
      if (chunk.length > 0) arm('stalled');
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
    clearIdle();
    signal.throwIfAborted();
    if (received !== input.size || hash.digest('hex') !== input.sha256) throw new Error('UPDATE_INTEGRITY_FAILED');
    return path;
  } catch (error) {
    const failure = signal.aborted ? signal.reason : error;
    deadlines.abort(failure);
    // The pipeline owns locked bodies. Dispose an unconsumed response without
    // waiting for a transport's potentially uncooperative cancellation hook.
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
    clearIdle(); clearTimeout(totalTimer);
    if (temporary) await rm(temporary, { recursive: true, force: true });
    throw failure;
  } finally { clearIdle(); clearTimeout(totalTimer); }
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
