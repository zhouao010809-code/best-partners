import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readdir, readFile, symlink } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLIPPER_EXTENSION_ID } from '../../src/shared/api/clipper.js';
import { decodeNativeMessage, encodeNativeMessage, handleClipperMessage, runClipperHost } from '../../src/electron/clipper-host.js';

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
    const root = await mkdtemp(join(tmpdir(), 'clipper-host-'));
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
    const parent = await mkdtemp(join(tmpdir(), 'clipper-host-symlink-'));
    const real = await mkdtemp(join(tmpdir(), 'clipper-host-real-'));
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
});

describe('clipper native host stream runner', () => {
  it('handles fragmented frames and emits an explicit oversized-frame error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clipper-host-runner-'));
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
