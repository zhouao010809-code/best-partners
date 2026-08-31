import { afterEach, describe, expect, it } from 'vitest';
import { access, link, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createContractDiskSandbox } from '../helpers/contract-disk-sandbox.js';
import { contractSandboxRoots } from '../helpers/contract-runtime.js';

const RUN_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; outside: string; formal: string }> {
  const base = await mkdtemp(join(tmpdir(), 'contract-disk-sandbox-'));
  temporaryRoots.push(base);
  const root = join(base, 'test-vault');
  const outside = join(base, 'outside');
  const formal = join(base, 'formal');
  await Promise.all([mkdir(root), mkdir(outside), mkdir(formal)]);
  return {
    root: await realpath(root),
    outside: await realpath(outside),
    formal: await realpath(formal)
  };
}

describe('contract disk sandbox', () => {
  it('rejects an ancestor symlink before creating any file outside the canonical test root', async () => {
    const current = await fixture();
    await symlink(current.outside, join(current.root, '01图书馆'));
    const sandbox = createContractDiskSandbox({ canonicalTestVaultRoot: current.root, runId: RUN_ID });
    const path = `${contractSandboxRoots(RUN_ID).library}/note.md`;

    await expect(sandbox.createFile(path, new TextEncoder().encode('unsafe')))
      .rejects.toThrowError('CONTRACT_DISK_PATH_UNSAFE');
    await expect(access(join(current.outside, '来自其他', '__xiaozhao_contract__', RUN_ID, 'note.md')))
      .rejects.toBeDefined();
  });

  it('rejects a contract-prefix symlink into the formal vault', async () => {
    const current = await fixture();
    const parent = join(current.root, '01图书馆', '来自其他');
    await mkdir(parent, { recursive: true });
    await symlink(current.formal, join(parent, '__xiaozhao_contract__'));
    const sandbox = createContractDiskSandbox({ canonicalTestVaultRoot: current.root, runId: RUN_ID });

    await expect(sandbox.createFile(
      `${contractSandboxRoots(RUN_ID).library}/note.md`,
      new TextEncoder().encode('unsafe')
    )).rejects.toThrowError('CONTRACT_DISK_PATH_UNSAFE');
    await expect(access(join(current.formal, RUN_ID, 'note.md'))).rejects.toBeDefined();
  });

  it('fails closed if the canonical root pathname is replaced before an operation', async () => {
    const current = await fixture();
    const movedRoot = `${current.root}-moved`;
    await rename(current.root, movedRoot);
    await symlink(current.outside, current.root);
    const sandbox = createContractDiskSandbox({ canonicalTestVaultRoot: current.root, runId: RUN_ID });

    await expect(sandbox.createFile(
      `${contractSandboxRoots(RUN_ID).library}/note.md`,
      new TextEncoder().encode('unsafe')
    )).rejects.toThrowError('CONTRACT_DISK_PATH_UNSAFE');
    await expect(access(join(current.outside, '01图书馆'))).rejects.toBeDefined();
  });

  it('rejects a final symlink for create and overwrite', async () => {
    const current = await fixture();
    const roots = contractSandboxRoots(RUN_ID);
    const parent = join(current.root, ...roots.library.split('/'));
    const outsideFile = join(current.outside, 'outside.md');
    await mkdir(parent, { recursive: true });
    await writeFile(outsideFile, 'outside');
    await symlink(outsideFile, join(parent, 'note.md'));
    const sandbox = createContractDiskSandbox({ canonicalTestVaultRoot: current.root, runId: RUN_ID });

    await expect(sandbox.createFile(`${roots.library}/note.md`, new TextEncoder().encode('create')))
      .rejects.toThrowError('CONTRACT_DISK_PATH_UNSAFE');
    await expect(sandbox.overwriteFile(`${roots.library}/note.md`, new TextEncoder().encode('overwrite')))
      .rejects.toThrowError('CONTRACT_DISK_PATH_UNSAFE');
    await expect(readFile(outsideFile, 'utf8')).resolves.toBe('outside');
  });

  it('rejects overwriting a hard-linked final file', async () => {
    const current = await fixture();
    const roots = contractSandboxRoots(RUN_ID);
    const parent = join(current.root, ...roots.library.split('/'));
    const outsideFile = join(current.outside, 'outside.md');
    await mkdir(parent, { recursive: true });
    await writeFile(outsideFile, 'outside');
    await link(outsideFile, join(parent, 'note.md'));
    const sandbox = createContractDiskSandbox({ canonicalTestVaultRoot: current.root, runId: RUN_ID });

    await expect(sandbox.overwriteFile(`${roots.library}/note.md`, new TextEncoder().encode('overwrite')))
      .rejects.toThrowError('CONTRACT_DISK_PATH_UNSAFE');
    await expect(readFile(outsideFile, 'utf8')).resolves.toBe('outside');
  });

  it('creates, overwrites, renames, and deletes regular files inside the run sandbox', async () => {
    const current = await fixture();
    const roots = contractSandboxRoots(RUN_ID);
    const source = `${roots.knowledge}/source.md`;
    const destination = `${roots.knowledge}/renamed.md`;
    const sandbox = createContractDiskSandbox({ canonicalTestVaultRoot: current.root, runId: RUN_ID });

    await sandbox.createFile(source, new TextEncoder().encode('one'));
    await sandbox.overwriteFile(source, new TextEncoder().encode('two'));
    await sandbox.renameFile(source, destination);
    await expect(readFile(join(current.root, ...destination.split('/')), 'utf8')).resolves.toBe('two');
    await sandbox.deleteFile(destination);
    await expect(access(join(current.root, ...destination.split('/')))).rejects.toBeDefined();
  });

  it('idempotently ensures only an exact regular file for WAL-backed restart recovery', async () => {
    const current = await fixture();
    const roots = contractSandboxRoots(RUN_ID);
    const path = `${roots.library}/restart.md`;
    const sandbox = createContractDiskSandbox({ canonicalTestVaultRoot: current.root, runId: RUN_ID });

    await expect(sandbox.ensureFile(path, new TextEncoder().encode('expected')))
      .resolves.toBe('created');
    await expect(sandbox.ensureFile(path, new TextEncoder().encode('expected')))
      .resolves.toBe('existing');
    await expect(sandbox.ensureFile(path, new TextEncoder().encode('different')))
      .rejects.toThrowError('CONTRACT_DISK_PATH_UNSAFE');
    await expect(readFile(join(current.root, ...path.split('/')), 'utf8'))
      .resolves.toBe('expected');
  });

  it('reports directory durability failure after create without losing the WAL-addressable file', async () => {
    const current = await fixture();
    const path = `${contractSandboxRoots(RUN_ID).library}/restart.md`;
    let syncCount = 0;
    const sandbox = createContractDiskSandbox({
      canonicalTestVaultRoot: current.root,
      runId: RUN_ID,
      testOnlySyncDirectory: () => {
        syncCount += 1;
        if (syncCount >= 5) throw new Error('injected directory sync failure');
      }
    });

    await expect(sandbox.ensureFile(path, new TextEncoder().encode('expected')))
      .rejects.toThrowError('CONTRACT_DISK_PATH_UNSAFE');
    await expect(readFile(join(current.root, ...path.split('/')), 'utf8'))
      .resolves.toBe('expected');
  });
});
