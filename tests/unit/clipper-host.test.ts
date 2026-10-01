import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtemp, mkdir, readdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLIPPER_EXTENSION_ID } from '../../src/shared/api/clipper.js';
import { decodeNativeMessage, encodeNativeMessage, handleClipperMessage, runClipperHost } from '../../src/electron/clipper-host.js';

const directories: string[] = [];
async function temporary(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix)); directories.push(directory); return directory;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('clipper native messaging framing', () => {
  it('uses a little endian four byte length prefix', () => {
    const frame = encodeNativeMessage({ ok: true });
    expect(frame.readUInt32LE(0)).toBe(frame.length - 4);
    expect(decodeNativeMessage(frame)).toEqual({ ok: true });
  });
  it('rejects truncated frames', () => {
    expect(() => decodeNativeMessage(Buffer.from([1, 0, 0, 0]))).toThrow();
  });
  it('rejects oversized frames before decoding the body', () => {
    const frame = Buffer.alloc(4); frame.writeUInt32LE(12 * 1024 * 1024 + 1);
    expect(() => decodeNativeMessage(frame)).toThrow(/12 MiB/iu);
  });
});

describe('clipper native host writes', () => {
  it('writes an atomic packet and treats repeated packet or content as duplicate', async () => {
    const root = await temporary('clipper-host-');
    await mkdir(join(root, '01图书馆', '小兆clipper'), { recursive: true });
    const config = { version: 1 as const, vaultRoot: root, token: 't'.repeat(32), extensionId: CLIPPER_EXTENSION_ID };
    const message = { extensionId: CLIPPER_EXTENSION_ID, token: config.token, payload: { packetId: 'p1', title: '标题', url: 'https://example.com', content: '正文', clippedAt: '2026-09-14T00:00:00.000Z' } };
    await expect(handleClipperMessage(message, config)).resolves.toMatchObject({ duplicate: false });
    await expect(handleClipperMessage({ ...message, payload: { ...message.payload, packetId: 'p2' } }, config)).resolves.toMatchObject({ duplicate: true });
    await expect(handleClipperMessage({ ...message, payload: { ...message.payload, content: '更新正文' } }, config)).resolves.toMatchObject({ duplicate: true });
    await expect(handleClipperMessage(message, config)).resolves.toMatchObject({ duplicate: true });
    const files = await readdir(join(root, '01图书馆', '小兆clipper', 'p1'));
    expect(files.sort()).toEqual(['index.md', 'metadata.json']);
    expect(await readFile(join(root, '01图书馆', '小兆clipper', 'p1', 'metadata.json'), 'utf8')).toContain('contentHash');
  });
  it('rejects symlinked vault path components and inbox entries', async () => {
    const parent = await temporary('clipper-host-symlink-');
    const real = await temporary('clipper-host-real-');
    await mkdir(join(real, '01图书馆', '小兆clipper'), { recursive: true });
    await symlink(real, join(parent, 'vault-link'));
    const config = { version: 1 as const, vaultRoot: join(parent, 'vault-link'), token: 't'.repeat(32), extensionId: CLIPPER_EXTENSION_ID };
    const payload = { packetId: 'p1', title: '标题', url: 'https://example.com', content: '正文', clippedAt: '2026-09-14T00:00:00.000Z' };
    await expect(handleClipperMessage({ extensionId: CLIPPER_EXTENSION_ID, token: config.token, payload }, config)).rejects.toThrow(/保存位置无效/u);
    await symlink(join(real, '01图书馆', '小兆clipper'), join(real, '01图书馆', '小兆clipper-link'));
    const realConfig = { ...config, vaultRoot: real };
    await expect(handleClipperMessage({ extensionId: CLIPPER_EXTENSION_ID, token: realConfig.token, payload }, realConfig)).resolves.toMatchObject({ ok: true });
    await symlink(join(real, '01图书馆', '小兆clipper', 'p1'), join(real, '01图书馆', '小兆clipper', 'linked'));
    await expect(handleClipperMessage({ extensionId: CLIPPER_EXTENSION_ID, token: realConfig.token, payload: { ...payload, packetId: 'p2', content: '不同' } }, realConfig)).rejects.toThrow(/保存位置无效/u);
  });
  it('leaves another host lock intact when exclusive acquisition fails', async () => {
    const root = await temporary('clipper-host-contention-');
    const inbox = join(root, '01图书馆', '小兆clipper'); await mkdir(inbox, { recursive: true });
    const lock = join(inbox, '.clipper.lock'); await writeFile(lock, 'other owner', { mode: 0o600 });
    const identity = await stat(lock);
    const config = { version: 1 as const, vaultRoot: root, token: 't'.repeat(32), extensionId: CLIPPER_EXTENSION_ID };
    const payload = { packetId: 'p1', title: '标题', url: 'https://example.com', content: '正文', clippedAt: '2026-09-14T00:00:00.000Z' };
    await expect(handleClipperMessage({ extensionId: CLIPPER_EXTENSION_ID, token: config.token, payload }, config)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(lock, 'utf8')).toBe('other owner');
    expect(await stat(lock)).toMatchObject({ dev: identity.dev, ino: identity.ino });
    expect(await readdir(inbox)).toEqual(['.clipper.lock']);
  });
  it('does not unlink a replacement lock when releasing its own open handle', async () => {
    const root = await temporary('clipper-host-replaced-lock-');
    const inbox = join(root, '01图书馆', '小兆clipper'); await mkdir(inbox, { recursive: true });
    const lock = join(inbox, '.clipper.lock');
    const originalReadDirectory = fs.readdir.bind(fs);
    vi.spyOn(fs, 'readdir').mockImplementationOnce(async (...args) => {
      // Replace the path while the production host still owns its original descriptor.
      await rename(lock, join(inbox, '.original-lock'));
      await writeFile(lock, 'replacement owner', { mode: 0o600 });
      return originalReadDirectory(...args);
    });
    const config = { version: 1 as const, vaultRoot: root, token: 't'.repeat(32), extensionId: CLIPPER_EXTENSION_ID };
    const payload = { packetId: 'p1', title: '标题', url: 'https://example.com', content: '正文', clippedAt: '2026-09-14T00:00:00.000Z' };
    await expect(handleClipperMessage({ extensionId: CLIPPER_EXTENSION_ID, token: config.token, payload }, config)).resolves.toMatchObject({ duplicate: false });
    expect(await readFile(lock, 'utf8')).toBe('replacement owner');
    expect((await stat(lock)).ino).not.toBe((await stat(join(inbox, '.original-lock'))).ino);
  });
});

describe('clipper native host stream runner', () => {
  it('handles fragmented frames and emits an explicit oversized-frame error', async () => {
    const root = await temporary('clipper-host-runner-');
    await mkdir(join(root, '01图书馆', '小兆clipper'), { recursive: true });
    const configPath = join(root, 'config.json');
    const config = { version: 1 as const, vaultRoot: root, token: 't'.repeat(32), extensionId: CLIPPER_EXTENSION_ID };
    await (await import('node:fs/promises')).writeFile(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
    const input = new PassThrough(); const output = new PassThrough(); const chunks: Buffer[] = [];
    output.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    const runner = runClipperHost({ configPath, input, output });
    const message = encodeNativeMessage({ extensionId: CLIPPER_EXTENSION_ID, token: config.token, type: 'ping' });
    input.write(message.subarray(0, 2)); input.write(message.subarray(2)); input.end(); await runner;
    expect(decodeNativeMessage(Buffer.concat(chunks))).toEqual({ ok: true, pong: true });
    const oversizedInput = new PassThrough(); const oversizedOutput = new PassThrough(); const oversizedChunks: Buffer[] = [];
    oversizedOutput.on('data', (chunk) => oversizedChunks.push(Buffer.from(chunk)));
    const oversizedRunner = runClipperHost({ configPath, input: oversizedInput, output: oversizedOutput });
    const header = Buffer.alloc(4); header.writeUInt32LE(12 * 1024 * 1024 + 1); oversizedInput.end(header); await oversizedRunner;
    expect(decodeNativeMessage(Buffer.concat(oversizedChunks))).toMatchObject({ ok: false, error: expect.stringMatching(/12 MiB/u) });
  });
});
