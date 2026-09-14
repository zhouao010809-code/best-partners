import { expect, test } from '@playwright/test';
import { mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLIPPER_EXTENSION_ID } from '../../src/shared/api/clipper.js';
import { handleClipperMessage } from '../../src/electron/clipper-host.js';

test('native clipper runner writes one packet, deduplicates, and rejects bad messages', async () => {
  const vaultRoot = await mkdtemp(join(tmpdir(), 'xiaozhao-clipper-e2e-'));
  try {
    await mkdir(join(vaultRoot, '01图书馆', '小兆clipper'), { recursive: true });
    const config = { version: 1 as const, vaultRoot, token: 't'.repeat(32), extensionId: CLIPPER_EXTENSION_ID };
    const payload = { packetId: 'electron-packet', title: '测试剪藏', url: 'https://example.com', content: '测试正文', clippedAt: '2026-09-14T00:00:00.000Z' };
    await expect(handleClipperMessage({ extensionId: CLIPPER_EXTENSION_ID, token: config.token, payload }, config)).resolves.toMatchObject({ ok: true, duplicate: false });
    await expect(handleClipperMessage({ extensionId: CLIPPER_EXTENSION_ID, token: config.token, payload: { ...payload, packetId: 'other-packet' } }, config)).resolves.toMatchObject({ ok: true, duplicate: true });
    await expect(handleClipperMessage({ extensionId: CLIPPER_EXTENSION_ID, token: 'x'.repeat(32), payload }, config)).rejects.toThrow(/未配对/u);
    const entries = await readdir(join(vaultRoot, '01图书馆', '小兆clipper'));
    expect(entries.filter((entry) => !entry.startsWith('.'))).toEqual(['electron-packet']);
  } finally {
    await rm(vaultRoot, { recursive: true, force: true });
  }
});

test('native clipper runner rejects symlink intermediate directories', async () => {
  const vaultRoot = await mkdtemp(join(tmpdir(), 'xiaozhao-clipper-symlink-'));
  try {
    await mkdir(join(vaultRoot, 'outside', '小兆clipper'), { recursive: true });
    await symlink(join(vaultRoot, 'outside'), join(vaultRoot, '01图书馆'));
    const config = { version: 1 as const, vaultRoot, token: 't'.repeat(32), extensionId: CLIPPER_EXTENSION_ID };
    const payload = { packetId: 'symlink-packet', title: '测试剪藏', url: 'https://example.com', content: '测试正文', clippedAt: '2026-09-14T00:00:00.000Z' };
    await expect(handleClipperMessage({ extensionId: CLIPPER_EXTENSION_ID, token: config.token, payload }, config)).rejects.toThrow('保存位置无效');
  } finally {
    await rm(vaultRoot, { recursive: true, force: true });
  }
});
