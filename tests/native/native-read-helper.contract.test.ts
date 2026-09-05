import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { mkdir, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import { NativeReadVaultPort } from '../../src/server/vault/NativeReadVaultPort.js';
import { decodeNativeReadResponse, MAX_FILE_BYTES, type NativeReadCommand, type RootIdentity } from '../../src/server/vault/native-read-helper-protocol.js';
import { createFilesystemVaultFixture } from '../helpers/filesystem-vault-fixture.js';

const execute = promisify(execFile);
type Fixture = Awaited<ReturnType<typeof createFilesystemVaultFixture>>;
const fixtures: Fixture[] = [];
let helperPath: string;
async function fixture(): Promise<Fixture> {
  const created = await createFilesystemVaultFixture();
  fixtures.push(created);
  return created;
}
beforeAll(async () => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('NATIVE_TEST_REQUIRES_MACOS_ARM64');
  const build = await fixture();
  helperPath = join(build.root, 'atomic-file-helper-test');
  await execute('xcrun', ['clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', '-arch', 'arm64',
    '-mmacosx-version-min=13.0', '-DNATIVE_READ_TEST_HOOKS', resolve('native/macos/atomic-file-helper.c'), '-o', helperPath]);
});
afterAll(async () => {
  for (const created of fixtures.reverse()) await created.cleanup();
});

async function raw(command: NativeReadCommand, root: string, identity?: RootIdentity, path?: string) {
  const args = [command, root, ...(identity ? [identity.dev, identity.ino, path!] : [])];
  const { stdout } = await execute(helperPath, args, { encoding: 'buffer', maxBuffer: 14 * 1024 * 1024 });
  return decodeNativeReadResponse(stdout, command, identity);
}

describe('descriptor-anchored native read contract', () => {
  it('preserves BOM, CRLF, Chinese and missing final newline and exact filename bytes', async () => {
    const { root } = await fixture();
    const bytes = Buffer.from('\ufeff---\r\n标题: 中文\r\n---\r\n末行');
    const names = ['Cafe\u0301.md', 'NFC-Café.md', '转化率100%.md'];
    for (const name of names) await writeFile(join(root, '02知识库', name), bytes);
    const reader = await NativeReadVaultPort.create({ root, helperPath });
    for (const name of names) expect((await reader.readFile(`02知识库/${name}`)).bytes).toEqual(bytes);
    expect((await reader.listDirectory('02知识库')).map((entry) => entry.name)).toEqual(names);
    await reader.assertDirectory('03大讲堂');
    await expect(reader.listDirectory('03大讲堂')).rejects.toThrow('PATH_NOT_ALLOWED');
    await expect(reader.readFile('03大讲堂/a.md')).rejects.toThrow('PATH_NOT_ALLOWED');
  });

  it('omits hidden names and reports directories', async () => {
    const { root } = await fixture();
    await writeFile(join(root, '02知识库', '.hidden'), 'hidden');
    await symlink('/does-not-exist', join(root, '02知识库', '.link'));
    await mkdir(join(root, '02知识库', 'folder'));
    expect(await (await NativeReadVaultPort.create({ root, helperPath })).listDirectory('02知识库'))
      .toEqual([{ name: 'folder', kind: 'directory' }]);
  });

  it('rejects symlinks at root, root ancestors, parent and final component', async () => {
    const base = await fixture(); const outside = await fixture();
    await writeFile(join(outside.root, '02知识库', 'outside.md'), 'OUTSIDE');
    await symlink(outside.root, join(base.root, 'link'));
    await expect(NativeReadVaultPort.create({ root: join(base.root, 'link'), helperPath })).rejects.toThrow('PATH_NOT_ALLOWED');
    await expect(NativeReadVaultPort.create({ root: join(base.root, 'link', '02知识库'), helperPath })).rejects.toThrow('PATH_NOT_ALLOWED');
    const reader = await NativeReadVaultPort.create({ root: base.root, helperPath });
    await symlink(join(outside.root, '02知识库'), join(base.root, '02知识库', 'link'));
    await symlink(join(outside.root, '02知识库', 'outside.md'), join(base.root, '01图书馆', 'final.md'));
    await expect(reader.readFile('02知识库/link/outside.md')).rejects.toThrow('PATH_NOT_ALLOWED');
    await expect(reader.readFile('01图书馆/final.md')).rejects.toThrow('PATH_NOT_ALLOWED');
    await expect(reader.listDirectory('02知识库')).rejects.toThrow('PATH_NOT_ALLOWED');
  });

  it('rejects special files without blocking, absent files, wrong type, and oversized files', async () => {
    const { root } = await fixture(); const reader = await NativeReadVaultPort.create({ root, helperPath });
    await execute('/usr/bin/mkfifo', [join(root, '02知识库', 'pipe')]);
    await expect(reader.readFile('02知识库/pipe')).rejects.toThrow('TYPE_MISMATCH');
    await expect(reader.listDirectory('02知识库')).rejects.toThrow('PATH_NOT_ALLOWED');
    await expect(reader.readFile('02知识库/missing.md')).rejects.toThrow('NOT_FOUND');
    await mkdir(join(root, '02知识库', 'folder'));
    await expect(reader.readFile('02知识库/folder')).rejects.toThrow('TYPE_MISMATCH');
    await writeFile(join(root, '01图书馆', 'large.md'), Buffer.alloc(MAX_FILE_BYTES + 1));
    await expect(reader.readFile('01图书馆/large.md')).rejects.toThrow('FILE_TOO_LARGE');
    await expect(reader.assertFile('01图书馆/large.md')).rejects.toThrow('FILE_TOO_LARGE');
    await writeFile(join(root, '01图书馆', 'small.md'), 'small');
    await expect(reader.assertDirectory('01图书馆/small.md')).rejects.toThrow('TYPE_MISMATCH');
  });

  it('binds subsequent commands to the probed inode', async () => {
    const original = await fixture(); const outside = await fixture();
    const identity = (await raw('probe-root', original.root)).root;
    await expect(raw('list-dir', outside.root, identity, '02知识库')).rejects.toThrow('ROOT_IDENTITY_CHANGED');
  });

  it('keeps 20,000 directory entries in a separate bounded payload and rejects overflow', async () => {
    const { root } = await fixture();
    // Bounded batches avoid exhausting the test runner's file descriptor budget.
    for (let start = 0; start < 20_000; start += 100) {
      await Promise.all(Array.from({ length: 100 }, (_, offset) =>
        writeFile(join(root, '02知识库', `${String(start + offset).padStart(5, '0')}.md`), '')));
    }
    const reader = await NativeReadVaultPort.create({ root, helperPath });
    const entries = await reader.listDirectory('02知识库');
    expect(entries).toHaveLength(20_000);
    expect(entries[0]?.name).toBe('00000.md');
    expect(entries.at(-1)?.name).toBe('19999.md');
    await writeFile(join(root, '02知识库', 'overflow.md'), '');
    await expect(reader.listDirectory('02知识库')).rejects.toThrow('DIRECTORY_TOO_LARGE');
  });

  it('enforces path and command policy in the native helper independently of TypeScript', async () => {
    const { root } = await fixture(); const identity = (await raw('probe-root', root)).root;
    for (const path of ['02知识库//a', '02知识库/../a', '02知识库/.hidden', '03大讲堂/a', '/etc/passwd']) {
      await expect(raw('read-file', root, identity, path)).rejects.toThrow('PATH_NOT_ALLOWED');
    }
    await expect(raw('list-dir', root, identity, '03大讲堂')).rejects.toThrow('PATH_NOT_ALLOWED');
    expect((await raw('stat-file', root, identity, '03大讲堂')).kind).toBe('directory');
    const response = await execute(helperPath, ['write-file', root], { encoding: 'buffer' });
    expect(() => decodeNativeReadResponse(response.stdout, 'probe-root')).toThrow('INVALID_ARGUMENT');
  });

  it.each(['root', 'parent'] as const)('continues on held %s descriptor after pathname swap, never reading outside', async (stage) => {
    for (const command of ['read-file', 'list-dir'] as const) {
      const original = await fixture(); const outside = await fixture();
      await mkdir(join(original.root, '02知识库', 'parent'));
      await mkdir(join(outside.root, '02知识库', 'parent'));
      await writeFile(join(original.root, '02知识库', 'parent', 'inside.md'), 'INSIDE');
      await writeFile(join(outside.root, '02知识库', 'parent', 'outside.md'), 'OUTSIDE');
      // Same filename makes an incorrect escape observable through its bytes.
      await writeFile(join(outside.root, '02知识库', 'parent', 'inside.md'), 'OUTSIDE');
      const identity = (await raw('probe-root', original.root)).root;
      const relative = command === 'read-file' ? '02知识库/parent/inside.md' : '02知识库/parent';
      const source = stage === 'root' ? original.root : join(original.root, '02知识库', 'parent');
      const held = `${source}-held`;
      const target = stage === 'root' ? outside.root : join(outside.root, '02知识库', 'parent');
      const process = spawn(helperPath, [command, original.root, identity.dev, identity.ino, relative], {
        env: { NATIVE_READ_TEST_PAUSE: stage }, stdio: ['pipe', 'pipe', 'pipe']
      });
      const chunks: Buffer[] = []; process.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      const completion = new Promise<number | null>((resolveExit, reject) => {
        process.once('error', reject); process.once('close', resolveExit);
      });
      let moved = false;
      try {
        await new Promise<void>((resolvePause, reject) => {
          const timer = setTimeout(() => reject(new Error('NATIVE_TEST_PAUSE_TIMEOUT')), 3000);
          process.stderr.on('data', (chunk: Buffer) => {
            if (chunk.toString().includes(`PAUSED:${stage}`)) { clearTimeout(timer); resolvePause(); }
          });
        });
        await rename(source, held); moved = true;
        await symlink(target, source);
        process.stdin.end('continue');
        expect(await completion).toBe(0);
        const response = decodeNativeReadResponse(Buffer.concat(chunks), command, identity);
        if (command === 'read-file') expect(response.payload.toString()).toBe('INSIDE');
        else expect(response.entries).toEqual([{ name: 'inside.md', kind: 'file' }]);
      } finally {
        process.kill('SIGKILL');
        await completion;
        if (moved) { await unlink(source); await rename(held, source); }
      }
    }
  });

  it('rejects changes between file metadata checks', async () => {
    const { root } = await fixture(); const path = join(root, '02知识库', 'drift.md');
    await writeFile(path, 'before'); const identity = (await raw('probe-root', root)).root;
    const child = spawn(helperPath, ['read-file', root, identity.dev, identity.ino, '02知识库/drift.md'], {
      env: { NATIVE_READ_TEST_PAUSE: 'after-read' }, stdio: ['pipe', 'pipe', 'pipe']
    });
    const chunks: Buffer[] = []; child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    const completion = new Promise((resolveExit) => child.once('close', resolveExit));
    try {
      await new Promise<void>((resolvePause) => child.stderr.once('data', () => resolvePause()));
      await writeFile(path, 'changed with different size');
      child.stdin.end('continue'); await completion;
      expect(() => decodeNativeReadResponse(Buffer.concat(chunks), 'read-file', identity)).toThrow('VERSION_CONFLICT');
    } finally { child.kill('SIGKILL'); await completion; }
  });

  it('rejects pre-aborted requests and surfaces no absolute path in failures', async () => {
    const { root } = await fixture(); const reader = await NativeReadVaultPort.create({ root, helperPath });
    await expect(reader.readFile('02知识库/a.md', AbortSignal.abort())).rejects.toThrow('VAULT_REQUEST_ABORTED');
    try { await reader.readFile('02知识库/a.md'); } catch (error) { expect(String(error)).not.toContain(root); }
  });
});
