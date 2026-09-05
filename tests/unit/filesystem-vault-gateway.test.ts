import { describe, expect, it, vi } from 'vitest';
import { FileSystemVaultGateway } from '../../src/server/vault/FileSystemVaultGateway.js';
import { sha256Bytes } from '../../src/server/vault/raw-bytes.js';
import type { NativeVaultReader } from '../../src/server/vault/NativeReadVaultPort.js';
import { MAX_FILE_BYTES } from '../../src/server/vault/native-read-helper-protocol.js';
import { NativeReadVaultPort } from '../../src/server/vault/NativeReadVaultPort.js';
import { createFilesystemVaultFixture } from '../helpers/filesystem-vault-fixture.js';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function setup(bytes = Buffer.from('\ufeff中文\r\n末行')) {
  const port: NativeVaultReader = {
    root: '/private/tmp/test-vault', rootIdentity: { dev: '1', ino: '2' },
    listDirectory: vi.fn(async () => [{ name: '资料', kind: 'directory' }, { name: '转化率100%.md', kind: 'file' }]),
    readFile: vi.fn(async () => ({ bytes })),
    assertFile: vi.fn(async () => {}),
    assertDirectory: vi.fn(async () => {})
  };
  const factory = { create: vi.fn(async () => port) };
  const openExternal = vi.fn(async (_url: string) => {});
  return { port, factory, openExternal };
}

describe('filesystem gateway', () => {
  it('keys the desktop cache by exact root and native root identity', async () => {
    const first = setup();
    const create = (port: NativeVaultReader) => FileSystemVaultGateway.create({ vaultRoot: port.root, nativeReader: { create: async () => port } });
    const gateway = await create(first.port);
    expect(gateway.cacheKey).toMatch(/^[a-f0-9]{64}$/u);
    expect((await create({ ...first.port })).cacheKey).toBe(gateway.cacheKey);
    expect((await create({ ...first.port, root: '/private/tmp/other-vault' })).cacheKey).not.toBe(gateway.cacheKey);
    expect((await create({ ...first.port, rootIdentity: { ...first.port.rootIdentity, ino: '3' } })).cacheKey).not.toBe(gateway.cacheKey);
    expect((await create({ ...first.port, rootIdentity: { ...first.port.rootIdentity, dev: '3' } })).cacheKey).not.toBe(gateway.cacheKey);
  });

  it('binds native root before constructing a read-only gateway and preserves bytes/hash', async () => {
    const { port, factory } = setup();
    const gateway = await FileSystemVaultGateway.create({ vaultRoot: port.root, nativeReader: factory });
    expect(factory.create).toHaveBeenCalledWith(port.root);
    const path = '02知识库/Cafe\u0301.md';
    const raw = await gateway.readRaw(path);
    expect(raw).toEqual({ path, bytes: Buffer.from('\ufeff中文\r\n末行'), rawSha256: sha256Bytes(Buffer.from('\ufeff中文\r\n末行')) });
    expect(port.readFile).toHaveBeenCalledWith(path, undefined);
    expect('fingerprint' in gateway).toBe(false);
    expect('readOpenApi' in gateway).toBe(false);
    expect(await gateway.listDirectory('02知识库')).toEqual(['资料/', '转化率100%.md']);
  });
  it('rejects forbidden paths and pre-abort before dispatch', async () => {
    const { port, factory } = setup();
    const gateway = await FileSystemVaultGateway.create({ vaultRoot: port.root, nativeReader: factory });
    await expect(gateway.readRaw('03大讲堂/a.md')).rejects.toThrow('PATH_NOT_ALLOWED');
    await expect(gateway.readRaw('02知识库/a.md', AbortSignal.abort())).rejects.toThrow('VAULT_REQUEST_ABORTED');
    expect(port.readFile).not.toHaveBeenCalled();
  });
  it('rejects oversized bytes and forwards live drift failures', async () => {
    const { port, factory } = setup(Buffer.alloc(MAX_FILE_BYTES + 1));
    const gateway = await FileSystemVaultGateway.create({ vaultRoot: port.root, nativeReader: factory });
    await expect(gateway.readRaw('02知识库/a.md')).rejects.toThrow('FILE_TOO_LARGE');
    vi.mocked(port.readFile).mockRejectedValueOnce(new Error('VERSION_CONFLICT'));
    await expect(gateway.readRaw('02知识库/a.md')).rejects.toThrow('VERSION_CONFLICT');
  });
  it('asserts existing file and opens only an encoded Obsidian URL', async () => {
    const { port, factory, openExternal } = setup();
    const gateway = await FileSystemVaultGateway.create({ vaultRoot: port.root, nativeReader: factory, openExternal });
    const path = '02知识库/转化率100% & Café.md';
    await gateway.openInObsidian(path);
    expect(port.assertFile).toHaveBeenCalledWith(path, undefined);
    const url = new URL(openExternal.mock.calls[0]![0] as string);
    expect(url.protocol).toBe('obsidian:');
    expect(url.hostname).toBe('open');
    expect(url.searchParams.get('vault')).toBe('test-vault');
    expect(url.searchParams.get('file')).toBe(path);
    vi.mocked(port.assertFile).mockRejectedValueOnce(new Error('NOT_FOUND'));
    await expect(gateway.openInObsidian(path)).rejects.toThrow('NOT_FOUND');
    expect(openExternal).toHaveBeenCalledTimes(1);
  });
});

async function withHelperScript(body: string, check: (helperPath: string, root: string) => Promise<void>) {
  const fixture = await createFilesystemVaultFixture();
  try {
    const helperPath = join(fixture.root, 'test-helper.cjs');
    await writeFile(helperPath, `#!${process.execPath}\n${body}\n`, { flag: 'wx', mode: 0o700 });
    await chmod(helperPath, 0o700);
    await check(helperPath, fixture.root);
  } finally { await fixture.cleanup(); }
}

const probeScript = `
const command = process.argv[2];
const header = Buffer.from(JSON.stringify({v:1,ok:true,command,root:{dev:'1',ino:'2'},payloadLength:0}));
const prefix = Buffer.alloc(4); prefix.writeUInt32BE(header.length);
const frame = Buffer.concat([prefix,header]);
`;

describe('native child process boundary', () => {
  it.each([
    ['nonzero exit', `${probeScript}process.stdout.write(frame,()=>process.exit(1));`, 'NATIVE_HELPER_FAILED'],
    ['truncated frame', `${probeScript}process.stdout.write(frame.subarray(0,-1));`, 'NATIVE_PROTOCOL_INVALID'],
    ['extra bytes', `${probeScript}process.stdout.write(Buffer.concat([frame,Buffer.from('extra')]));`, 'NATIVE_PROTOCOL_INVALID'],
    ['stdout cap', `process.stdout.write(Buffer.alloc(14*1024*1024));`, 'NATIVE_PROTOCOL_INVALID'],
    ['stderr cap', `process.stderr.write(Buffer.alloc(65537));setInterval(()=>{},1000);`, 'NATIVE_HELPER_FAILED']
  ])('rejects %s with sanitized diagnostics', async (_label, body, code) => {
    await withHelperScript(body!, async (helperPath, root) => {
      await expect(NativeReadVaultPort.create({ helperPath, root })).rejects.toThrow(code);
    });
  });

  it('kills a request that exceeds the five-second deadline', async () => {
    await withHelperScript('setInterval(()=>{},1000);', async (helperPath, root) => {
      await expect(NativeReadVaultPort.create({ helperPath, root })).rejects.toThrow('NATIVE_HELPER_TIMEOUT');
    });
  }, 7000);

  it('kills an in-flight read on abort and rejects identity drift', async () => {
    await withHelperScript(`${probeScript}
if(command==='probe-root') process.stdout.write(frame);
else setInterval(()=>{},1000);`, async (helperPath, root) => {
      const reader = await NativeReadVaultPort.create({ helperPath, root });
      const controller = new AbortController();
      const reading = reader.readFile('02知识库/a.md', controller.signal);
      controller.abort();
      await expect(reading).rejects.toThrow('VAULT_REQUEST_ABORTED');
    });
    await withHelperScript(`${probeScript}
if(command==='probe-root') process.stdout.write(frame);
else {
 const changed=Buffer.from(JSON.stringify({v:1,ok:true,command,root:{dev:'1',ino:'3'},payloadLength:0}));
 prefix.writeUInt32BE(changed.length);process.stdout.write(Buffer.concat([prefix,changed]));
}`, async (helperPath, root) => {
      const reader = await NativeReadVaultPort.create({ helperPath, root });
      await expect(reader.readFile('02知识库/a.md')).rejects.toThrow('ROOT_IDENTITY_CHANGED');
    });
  });
});
