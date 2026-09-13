import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLIPPER_EXTENSION_ID } from '../../src/shared/api/clipper.js';
import { decodeNativeMessage, encodeNativeMessage, handleClipperMessage } from '../../src/electron/clipper-host.js';

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
    await expect(handleClipperMessage(message, config)).resolves.toMatchObject({ duplicate: true });
    const files = await readdir(join(root, '01图书馆', '小兆clipper', 'p1'));
    expect(files.sort()).toEqual(['index.md', 'metadata.json']);
    expect(await readFile(join(root, '01图书馆', '小兆clipper', 'p1', 'metadata.json'), 'utf8')).toContain('contentHash');
  });
});
