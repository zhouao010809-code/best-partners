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
  return { directory, url, sha256: digest, size: body.length, signal: new AbortController().signal, onProgress: vi.fn(), fetcher: vi.fn<typeof fetch>(async () => new Response(body)) };
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

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

it.each(['connection', 'first-byte', 'stalled'] as const)('bounds a stalled %s phase, removes partial files and clears owned timers', async phase => {
  const input = await setup(); const abort = new AbortController(); input.signal = abort.signal;
  const entered = deferred<void>(); let activeSignal: AbortSignal | undefined;
  input.fetcher.mockImplementation(async (_url, options) => {
    activeSignal = options!.signal as AbortSignal;
    if (phase === 'connection') {
      entered.resolve();
      return new Promise<Response>((_resolve, reject) => activeSignal!.addEventListener('abort', () => reject(activeSignal!.reason), { once: true }));
    }
    return new Response(new ReadableStream({ start(controller) { if (phase === 'stalled') controller.enqueue(body.subarray(0, 3)); } }));
  });
  input.onProgress.mockImplementation((received: number) => { if (phase === 'first-byte' && received === 0 || phase === 'stalled' && received === 3) entered.resolve(); });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const outcome = downloadUpdateInstaller({ ...input, inactivityTimeoutMs: 30 }).then(() => undefined, error => error);
  try {
    await entered.promise;
    await vi.advanceTimersByTimeAsync(31);
    expect(activeSignal?.aborted).toBe(true);
    const error = await outcome;
    expect(error).toMatchObject({ name: 'UpdateDownloadTimeoutError', phase });
    expect(abort.signal.aborted).toBe(false);
    expect(await readdir(input.directory)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  } finally { abort.abort(); await outcome; vi.useRealTimers(); }
});

it('restarts the no-progress deadline only when nonempty bytes arrive and keeps the total 15-minute deadline', async () => {
  const input = await setup(); const started = deferred<void>(); let stream!: ReadableStreamDefaultController<Uint8Array>;
  input.fetcher.mockImplementation(async () => new Response(new ReadableStream({ start(controller) { stream = controller; } })));
  input.onProgress.mockImplementation((received: number) => { if (received === 0) started.resolve(); });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const timerSpy = vi.spyOn(globalThis, 'setTimeout');
  const outcome = downloadUpdateInstaller({ ...input, inactivityTimeoutMs: 30 });
  try {
    await started.promise;
    for (let start = 0; start < body.length; start += 4) {
      await vi.advanceTimersByTimeAsync(20);
      stream.enqueue(body.subarray(start, start + 4));
      await turn(); await turn();
    }
    stream.close();
    expect(await readFile(await outcome)).toEqual(body);
    expect(timerSpy).toHaveBeenCalledWith(expect.any(Function), 15 * 60_000);
    expect(input.onProgress).toHaveBeenLastCalledWith(body.length, body.length);
    expect(vi.getTimerCount()).toBe(0);
  } finally { timerSpy.mockRestore(); vi.useRealTimers(); }
});

it('does not treat empty chunks as byte progress', async () => {
  const input = await setup(); const abort = new AbortController(); input.signal = abort.signal;
  const started = deferred<void>(); let stream!: ReadableStreamDefaultController<Uint8Array>; let activeSignal: AbortSignal | undefined;
  input.fetcher.mockImplementation(async (_url, options) => { activeSignal = options!.signal as AbortSignal; return new Response(new ReadableStream({ start(controller) { stream = controller; } })); });
  input.onProgress.mockImplementation(() => started.resolve());
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const outcome = downloadUpdateInstaller({ ...input, inactivityTimeoutMs: 30 }).then(() => undefined, error => error);
  try {
    await started.promise;
    await vi.advanceTimersByTimeAsync(20); stream.enqueue(new Uint8Array()); await turn();
    await vi.advanceTimersByTimeAsync(11);
    expect(activeSignal?.aborted).toBe(true);
    expect(await outcome).toMatchObject({ phase: 'first-byte' });
    expect(vi.getTimerCount()).toBe(0);
  } finally { abort.abort(); await outcome; vi.useRealTimers(); }
});

it('keeps user cancellation distinct from a timeout and removes every deadline timer', async () => {
  const input = await setup(); const abort = new AbortController(); input.signal = abort.signal;
  const started = deferred<void>();
  input.fetcher.mockImplementation(async () => new Response(new ReadableStream()));
  input.onProgress.mockImplementation(() => started.resolve());
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const outcome = downloadUpdateInstaller({ ...input, inactivityTimeoutMs: 30 }).then(() => undefined, error => error);
  try {
    await started.promise; await vi.advanceTimersByTimeAsync(20); abort.abort();
    expect(await outcome).toMatchObject({ name: 'AbortError' });
    expect(await readdir(input.directory)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it('still aborts after 15 minutes even while nonempty chunks keep the inactivity deadline alive', async () => {
  const input = await setup(); input.size = 100;
  const abort = new AbortController(); input.signal = abort.signal;
  const started = deferred<void>(); let stream!: ReadableStreamDefaultController<Uint8Array>;
  input.fetcher.mockImplementation(async () => new Response(new ReadableStream({ start(controller) { stream = controller; } })));
  input.onProgress.mockImplementation(() => started.resolve());
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const outcome = downloadUpdateInstaller(input).then(() => undefined, error => error);
  try {
    await started.promise;
    for (let index = 0; index < 31; index += 1) {
      await vi.advanceTimersByTimeAsync(29_000); stream.enqueue(Uint8Array.of(1)); await turn(); await turn();
    }
    await vi.advanceTimersByTimeAsync(1_001);
    expect(await outcome).toMatchObject({ phase: 'total', code: 'UPDATE_DOWNLOAD_TIMEOUT' });
    expect(await readdir(input.directory)).toEqual([]); expect(vi.getTimerCount()).toBe(0);
  } finally { abort.abort(); await outcome; vi.useRealTimers(); }
});

it('bounds a transport that ignores abort and cancels a response that arrives after timeout', async () => {
  const input = await setup(); const started = deferred<void>(); const delayed = deferred<Response>();
  input.fetcher.mockImplementation(() => { started.resolve(); return delayed.promise; });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const outcome = downloadUpdateInstaller({ ...input, inactivityTimeoutMs: 30 }).then(() => undefined, error => error);
  try {
    await started.promise; await vi.advanceTimersByTimeAsync(31);
    expect(await outcome).toMatchObject({ phase: 'connection' });
    const cancel = vi.fn();
    delayed.resolve(new Response(new ReadableStream({ cancel })));
    await turn();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(input.onProgress).not.toHaveBeenCalled();
    expect(await readdir(input.directory)).toEqual([]); expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it('clears deadline timers after integrity failure as well as timeout and cancellation', async () => {
  const input = await setup(); input.sha256 = '0'.repeat(64);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    await expect(downloadUpdateInstaller(input)).rejects.toThrow('UPDATE_INTEGRITY_FAILED');
    expect(vi.getTimerCount()).toBe(0); expect(await readdir(input.directory)).toEqual([]);
  } finally { vi.useRealTimers(); }
});

it('aborts the transport and cancels an unconsumed non-2xx body without waiting for a stalled cancel hook', async () => {
  const input = await setup(); let activeSignal: AbortSignal | undefined;
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  input.fetcher.mockImplementation(async (_url, options) => {
    activeSignal = options!.signal as AbortSignal;
    return new Response(new ReadableStream({ cancel }), { status: 503 });
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    await expect(downloadUpdateInstaller(input)).rejects.toThrow('UPDATE_DOWNLOAD_FAILED');
    expect(activeSignal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(await readdir(input.directory)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
