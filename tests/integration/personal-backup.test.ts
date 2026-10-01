import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RULE_BUNDLE_SOURCE_PATHS } from '../../src/server/rules/rule-bundle.js';
import { createPersonalBackup, verifyPersonalBackup } from '../../src/server/operations/personal-backup.js';
import { parseBackupArguments, main as backupMain } from '../../scripts/personal-backup.js';
import { parseRestoreArguments } from '../../scripts/personal-restore-check.js';

const roots: string[] = [];
async function fixture() {
  const root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'personal-backup-test-'));
  roots.push(root);
  const vaultRoot = join(root, 'vault');
  const userDataRoot = join(root, 'user-data');
  const destinationRoot = join(root, 'backups');
  for (const path of ['00大脑规则', '01图书馆/小兆clipper', '02知识库', '03大讲堂', 'empty', 'node_modules/fixture']) {
    await fs.mkdir(join(vaultRoot, path), { recursive: true });
  }
  for (const path of RULE_BUNDLE_SOURCE_PATHS) await fs.writeFile(join(vaultRoot, path), '# Fixture rules\n');
  await fs.writeFile(join(vaultRoot, '01图书馆', 'material.md'), '原始资料\n');
  await fs.writeFile(join(vaultRoot, '01图书馆', 'attachment.bin'), Buffer.from([0, 255, 17]));
  await fs.writeFile(join(vaultRoot, 'node_modules/fixture/index.js'), 'rebuildable');
  await fs.writeFile(join(vaultRoot, 'package-lock.json'), '{"lockfileVersion":3}\n');
  const identity = await fs.stat(vaultRoot, { bigint: true });
  const cacheKey = createHash('sha256').update(JSON.stringify([vaultRoot, String(identity.dev), String(identity.ino)])).digest('hex');
  const stateRoot = join(userDataRoot, 'vaults', cacheKey);
  for (const path of [stateRoot, join(stateRoot, 'backups'), join(stateRoot, 'recovery'), join(stateRoot, 'trash', 'empty'), join(userDataRoot, 'config'), join(userDataRoot, 'model-credentials'), join(userDataRoot, 'Local Storage', 'leveldb'), join(userDataRoot, 'Cache'), destinationRoot]) {
    await fs.mkdir(path, { recursive: true });
  }
  await fs.writeFile(join(userDataRoot, 'config/app-config.json'), JSON.stringify({ vaultRoot }));
  const encrypted = Buffer.from([0, 250, 7, 11, 33]);
  await fs.writeFile(join(userDataRoot, 'model-credentials/deepseek-key.enc'), encrypted);
  await fs.writeFile(join(userDataRoot, 'Local Storage/leveldb/000001.log'), 'draft and conversation');
  await fs.writeFile(join(userDataRoot, 'Cache/rebuildable'), 'runtime cache');
  await fs.writeFile(join(stateRoot, 'recovery/intent.json'), JSON.stringify({ vaultRoot, cacheKey, pending: true }));
  const db = new Database(join(stateRoot, 'state.sqlite3'));
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE parents(id INTEGER PRIMARY KEY); CREATE TABLE children(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES parents(id)); INSERT INTO parents VALUES(1); INSERT INTO children VALUES(1,1);');
  db.close();
  await fs.copyFile(join(stateRoot, 'state.sqlite3'), join(stateRoot, 'backups/state-existing.sqlite3'));
  const otherState = join(userDataRoot, 'vaults', 'a'.repeat(64));
  await fs.mkdir(otherState);
  await fs.copyFile(join(stateRoot, 'state.sqlite3'), join(otherState, 'state.sqlite3'));
  return { root, vaultRoot, userDataRoot, destinationRoot, stateRoot, cacheKey, encrypted, cold: true as const };
}

async function rewriteManifest(snapshotRoot: string, update: (manifest: any) => void) {
  const path = join(snapshotRoot, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(path, 'utf8'));
  update(manifest);
  await fs.writeFile(path, JSON.stringify(manifest));
}

async function treeFingerprint(root: string): Promise<string> {
  const rows: unknown[] = [];
  async function walk(path: string, local = ''): Promise<void> {
    const info = await fs.lstat(path);
    if (info.isDirectory()) {
      rows.push([local, 'directory', info.mode]);
      for (const name of (await fs.readdir(path)).sort()) await walk(join(path, name), `${local}/${name}`);
    } else rows.push([local, 'file', info.mode, createHash('sha256').update(await fs.readFile(path)).digest('hex')]);
  }
  await walk(root); return JSON.stringify(rows);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('personal cold backup and offline restore checks', () => {
  it('preserves all persistent files, empty directories, encrypted bytes and every vault state; declares exclusions and restore limits', async () => {
    const f = await fixture();
    const before = await fs.readFile(join(f.stateRoot, 'state.sqlite3'));
    const sourceBefore = [await treeFingerprint(f.vaultRoot), await treeFingerprint(f.userDataRoot)];
    const result = await createPersonalBackup(f);
    expect(result.manifest.version).toBe(1);
    expect(result.manifest.source.vault).toMatchObject({ path: f.vaultRoot, cacheKey: f.cacheKey });
    expect(result.manifest.entries).toEqual(expect.arrayContaining([
      { path: 'vault/empty', type: 'directory' },
      expect.objectContaining({ path: 'vault/package-lock.json', type: 'file' }),
      expect.objectContaining({ path: 'user-data/Local Storage/leveldb/000001.log', type: 'file' }),
      expect.objectContaining({ path: `user-data/vaults/${'a'.repeat(64)}/state.sqlite3`, type: 'file' }),
      { path: `user-data/vaults/${f.cacheKey}/trash/empty`, type: 'directory' }
    ]));
    expect(result.manifest.exclusions.observed).toEqual(['user-data/Cache', 'vault/node_modules']);
    expect(result.manifest.notCovered).toEqual(['external-project-originals', 'browser-pending-clipper-queue', 'system-keychain']);
    expect(result.manifest.entries.some((entry: any) => entry.path.includes('node_modules') || entry.path.startsWith('user-data/Cache'))).toBe(false);
    expect(await fs.readFile(join(result.snapshotRoot, 'user-data/model-credentials/deepseek-key.enc'))).toEqual(f.encrypted);
    expect((await fs.stat(result.snapshotRoot)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(join(result.snapshotRoot, 'user-data/model-credentials/deepseek-key.enc'))).mode & 0o777).toBe(0o600);
    const snapshotBefore = await treeFingerprint(result.snapshotRoot);
    const checked = await verifyPersonalBackup(result.snapshotRoot);
    expect(checked).toMatchObject({ snapshotIntegrity: 'passed', sqliteIntegrity: 'passed', applicationRestore: 'unverified', requiresIdentityRebind: true });
    expect(checked.databases).toHaveLength(3);
    expect(await treeFingerprint(result.snapshotRoot)).toBe(snapshotBefore);
    expect(await fs.readFile(join(f.stateRoot, 'state.sqlite3'))).toEqual(before);
    expect(await fs.readFile(join(f.userDataRoot, 'config/app-config.json'), 'utf8')).toBe(JSON.stringify({ vaultRoot: f.vaultRoot }));
    const again = await createPersonalBackup(f);
    expect(again.snapshotRoot).not.toBe(result.snapshotRoot);
    expect(await fs.readFile(join(result.snapshotRoot, 'user-data/model-credentials/deepseek-key.enc'))).toEqual(f.encrypted);
    expect([await treeFingerprint(f.vaultRoot), await treeFingerprint(f.userDataRoot)]).toEqual(sourceBefore);
  });

  it('requires explicit cold confirmation and does not create any output when it is missing', async () => {
    const f = await fixture();
    await expect(createPersonalBackup({ ...f, cold: false })).rejects.toMatchObject({ code: 'PERSONAL_BACKUP_COLD_CONFIRMATION_REQUIRED' });
    expect(await fs.readdir(f.destinationRoot)).toEqual([]);
  });

  it('detects destination ancestor replacement inside mkdir and does not publish or copy data through the new link', async () => {
    const f = await fixture();
    const parent = join(f.root, 'target-parent'); const redirected = join(f.root, 'redirected-parent');
    const destinationRoot = join(parent, 'backups');
    await fs.mkdir(destinationRoot, { recursive: true }); await fs.mkdir(join(redirected, 'backups'), { recursive: true });
    const realMkdir = fs.mkdir; let replaced = false;
    vi.spyOn(fs, 'mkdir').mockImplementation(async (...args: Parameters<typeof fs.mkdir>) => {
      if (!replaced && String(args[0]).startsWith(destinationRoot) && String(args[0]).endsWith('.partial')) {
        replaced = true; await fs.rename(parent, `${parent}-old`); await fs.symlink(redirected, parent);
      }
      return realMkdir(...args);
    });
    await expect(createPersonalBackup({ ...f, destinationRoot })).rejects.toMatchObject({ code: 'PERSONAL_BACKUP_DESTINATION_CHANGED' });
    expect(replaced).toBe(true);
    expect(await fs.readdir(join(`${parent}-old`, 'backups'))).toEqual([]);
    for (const path of await fs.readdir(join(redirected, 'backups'))) {
      expect(path.endsWith('.partial')).toBe(true);
      expect(await fs.readdir(join(redirected, 'backups', path))).toEqual([]);
    }
  });

  it('does not delete an unrelated replacement of its partial output directory during rollback', async () => {
    const f = await fixture(); const realOpen = fs.open; let replaced: string | undefined;
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const path = String(args[0]);
      if (!replaced && path.includes('.partial/vault/')) {
        replaced = path.slice(0, path.indexOf('.partial/') + '.partial'.length);
        await fs.rename(replaced, `${replaced}-owned`); await fs.mkdir(replaced);
        await fs.writeFile(join(replaced, 'unrelated-original.txt'), 'must remain');
        throw Object.assign(new Error('injected copy failure'), { code: 'EIO' });
      }
      return realOpen(...args);
    });
    await expect(createPersonalBackup(f)).rejects.toMatchObject({ code: 'PERSONAL_BACKUP_OUTPUT_CHANGED' });
    expect(replaced).toBeDefined();
    expect(await fs.readFile(join(replaced!, 'unrelated-original.txt'), 'utf8')).toBe('must remain');
    expect((await fs.lstat(`${replaced}-owned`)).isDirectory()).toBe(true);
  });

  it('does not delete a replacement of its offline temporary directory during finally cleanup', async () => {
    const f = await fixture(); const result = await createPersonalBackup(f); const realOpen = fs.open; let replaced: string | undefined;
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const path = String(args[0]); const marker = '/vault/';
      if (!replaced && path.includes('xiaozhao-personal-restore-check-') && path.includes(marker)) {
        replaced = path.slice(0, path.indexOf(marker)); roots.push(replaced, `${replaced}-owned`);
        await fs.rename(replaced, `${replaced}-owned`); await fs.mkdir(replaced);
        await fs.writeFile(join(replaced, 'unrelated-original.txt'), 'must remain');
        throw Object.assign(new Error('injected offline copy failure'), { code: 'EIO' });
      }
      return realOpen(...args);
    });
    await expect(verifyPersonalBackup(result.snapshotRoot)).rejects.toMatchObject({ code: 'PERSONAL_RESTORE_CHECK_CLEANUP_FAILED' });
    expect(replaced).toBeDefined();
    expect(await fs.readFile(join(replaced!, 'unrelated-original.txt'), 'utf8')).toBe('must remain');
  });

  it('rejects a source ancestor replaced by a link to the same original inode tree', async () => {
    const f = await fixture(); const parent = join(f.root, 'source-parent'); const vaultRoot = join(parent, 'vault');
    await fs.mkdir(parent); await fs.rename(f.vaultRoot, vaultRoot);
    const info = await fs.lstat(vaultRoot, { bigint: true });
    const key = createHash('sha256').update(JSON.stringify([vaultRoot, String(info.dev), String(info.ino)])).digest('hex');
    await fs.rename(f.stateRoot, join(f.userDataRoot, 'vaults', key));
    await fs.writeFile(join(f.userDataRoot, 'config/app-config.json'), JSON.stringify({ vaultRoot }));
    const realOpen = fs.open; let replaced = false;
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (!replaced && String(args[0]).includes('.partial/vault/')) {
        replaced = true; await fs.rename(parent, `${parent}-original`); await fs.symlink(`${parent}-original`, parent);
      }
      return realOpen(...args);
    });
    await expect(createPersonalBackup({ ...f, vaultRoot })).rejects.toMatchObject({ code: 'PERSONAL_BACKUP_SOURCE_CHANGED' });
    expect(replaced).toBe(true); expect(await fs.readdir(f.destinationRoot)).toEqual([]);
    expect((await fs.stat(vaultRoot, { bigint: true })).ino).toBe(info.ino);
  });

  it('rejects a snapshot ancestor replaced by a link to the same original tree while copying offline', async () => {
    const f = await fixture(); const result = await createPersonalBackup(f); const realOpen = fs.open; let replaced = false;
    const parent = join(result.snapshotRoot, '..');
    const info = await fs.lstat(result.snapshotRoot, { bigint: true });
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (!replaced && String(args[0]).includes('xiaozhao-personal-restore-check-') && String(args[0]).includes('/vault/')) {
        replaced = true; await fs.rename(parent, `${parent}-original`); await fs.symlink(`${parent}-original`, parent);
      }
      return realOpen(...args);
    });
    await expect(verifyPersonalBackup(result.snapshotRoot)).rejects.toMatchObject({ code: 'PERSONAL_BACKUP_SOURCE_CHANGED' });
    expect(replaced).toBe(true); expect((await fs.stat(result.snapshotRoot, { bigint: true })).ino).toBe(info.ino);
  });

  it('rejects replacement of the reserved container inside publication rename and preserves the unrelated replacement', async () => {
    const f = await fixture(); const realRename = fs.rename; let replaced: string | undefined;
    vi.spyOn(fs, 'rename').mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
      if (!replaced && String(args[0]).endsWith('.partial') && String(args[1]).endsWith('/snapshot')) {
        replaced = join(String(args[1]), '..');
        await realRename(replaced, `${replaced}-owned`); await fs.mkdir(replaced);
        await fs.writeFile(join(replaced, 'unrelated-original.txt'), 'must remain');
      }
      return realRename(...args);
    });
    await expect(createPersonalBackup(f)).rejects.toMatchObject({ code: 'PERSONAL_BACKUP_OUTPUT_CHANGED' });
    expect(replaced).toBeDefined(); expect(await fs.readFile(join(replaced!, 'unrelated-original.txt'), 'utf8')).toBe('must remain');
  });

  it.each(['vault-descendant', 'user-data-descendant', 'destination-ancestor', 'source-overlap'] as const)('rejects %s overlap in either direction', async kind => {
    const f = await fixture();
    const options = kind === 'vault-descendant' ? { ...f, destinationRoot: join(f.vaultRoot, 'empty') }
      : kind === 'user-data-descendant' ? { ...f, destinationRoot: f.stateRoot }
      : kind === 'destination-ancestor' ? { ...f, destinationRoot: f.root }
      : { ...f, userDataRoot: join(f.vaultRoot, 'empty') };
    await expect(createPersonalBackup(options)).rejects.toMatchObject({ code: 'PERSONAL_BACKUP_PATH_OVERLAP' });
  });

  it.each(['file-link', 'directory-link', 'excluded-directory-link', 'source-root-link'] as const)('rejects a %s without publishing or following it', async kind => {
    const f = await fixture();
    let options = f;
    if (kind === 'source-root-link') {
      const linked = join(f.root, 'vault-link'); await fs.symlink(f.vaultRoot, linked); options = { ...f, vaultRoot: linked };
    } else if (kind === 'excluded-directory-link') {
      await fs.rm(join(f.userDataRoot, 'Cache'), { recursive: true });
      await fs.symlink(f.vaultRoot, join(f.userDataRoot, 'Cache'));
    } else {
      await fs.symlink(kind === 'file-link' ? join(f.vaultRoot, '01图书馆/material.md') : f.destinationRoot, join(f.vaultRoot, 'unsafe-link'));
    }
    await expect(createPersonalBackup(options)).rejects.toMatchObject({ code: 'PERSONAL_BACKUP_SYMLINK_REJECTED' });
    expect(await fs.readdir(f.destinationRoot)).toEqual([]);
  });

  it.each(['SingletonLock', 'SingletonCookie', 'SingletonSocket', '.clipper.lock', 'store.lock'])('refuses recognized running marker %s, including dangling symbolic locks', async name => {
    const f = await fixture();
    const path = name === '.clipper.lock' ? join(f.vaultRoot, '01图书馆/小兆clipper', name)
      : name === 'store.lock' ? join(f.stateRoot, name) : join(f.userDataRoot, name);
    await fs.symlink('/unavailable/runtime-marker', path);
    await expect(createPersonalBackup(f)).rejects.toMatchObject({ code: 'PERSONAL_BACKUP_SOURCE_RUNNING' });
    expect(await fs.readdir(f.destinationRoot)).toEqual([]);
  });

  it('rejects special files rather than reading from a socket', async () => {
    const f = await fixture(); const server = createServer();
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(join(f.vaultRoot, 'socket'), resolve); });
    try {
      await expect(createPersonalBackup(f)).rejects.toMatchObject({ code: 'PERSONAL_BACKUP_SPECIAL_FILE_REJECTED' });
      expect(await fs.readdir(f.destinationRoot)).toEqual([]);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('rejects a new file inserted into an already copied directory before publication', async () => {
    const f = await fixture(); const realOpen = fs.open; let changed = false;
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (!changed && String(args[0]).includes('.partial/user-data/')) {
        changed = true; await fs.writeFile(join(f.vaultRoot, 'empty', 'new-material.md'), 'new');
      }
      return realOpen(...args);
    });
    await expect(createPersonalBackup(f)).rejects.toMatchObject({ code: 'PERSONAL_BACKUP_SOURCE_CHANGED' });
    expect(changed).toBe(true); expect(await fs.readdir(f.destinationRoot)).toEqual([]);
  });

  it('rejects replacement of the source root while copying even when all original bytes remain', async () => {
    const f = await fixture(); const realOpen = fs.open; let changed = false;
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (!changed && String(args[0]).includes('.partial/user-data/')) {
        changed = true;
        await fs.rename(f.vaultRoot, join(f.root, 'old-vault'));
        await fs.cp(join(f.root, 'old-vault'), f.vaultRoot, { recursive: true });
      }
      return realOpen(...args);
    });
    await expect(createPersonalBackup(f)).rejects.toMatchObject({ code: 'PERSONAL_BACKUP_SOURCE_CHANGED' });
    expect(changed).toBe(true); expect(await fs.readdir(f.destinationRoot)).toEqual([]);
  });

  it('rejects changes to an earlier copied source file and cleans its partial snapshot', async () => {
    const f = await fixture();
    const realOpen = fs.open;
    let changed = false;
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (!changed && String(args[0]).includes('.partial/user-data/')) {
        changed = true;
        await fs.writeFile(join(f.vaultRoot, '01图书馆/material.md'), '已改变资料\n');
      }
      return realOpen(...args);
    });
    await expect(createPersonalBackup(f)).rejects.toMatchObject({ code: 'PERSONAL_BACKUP_SOURCE_CHANGED' });
    expect(changed).toBe(true);
    expect(await fs.readdir(f.destinationRoot)).toEqual([]);
  });

  it('reports disappearance of a pending source file as a changed source and cleans output', async () => {
    const f = await fixture(); const realOpen = fs.open; let changed = false;
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (!changed && String(args[0]).includes('.partial/user-data/')) {
        changed = true; await fs.rm(join(f.userDataRoot, 'model-credentials/deepseek-key.enc'));
      }
      return realOpen(...args);
    });
    await expect(createPersonalBackup(f)).rejects.toMatchObject({ code: 'PERSONAL_BACKUP_SOURCE_CHANGED' });
    expect(changed).toBe(true); expect(await fs.readdir(f.destinationRoot)).toEqual([]);
  });

  it.each(['missing', 'tampered', 'extra', 'snapshot-link'] as const)('rejects a %s snapshot before trusting it', async kind => {
    const f = await fixture(); const result = await createPersonalBackup(f);
    const material = join(result.snapshotRoot, 'vault/01图书馆/material.md');
    if (kind === 'missing') await fs.rm(material);
    else if (kind === 'tampered') await fs.writeFile(material, 'unexpected');
    else if (kind === 'extra') await fs.writeFile(join(result.snapshotRoot, 'user-data', 'unlisted'), 'extra');
    else { await fs.rm(material); await fs.symlink(join(f.vaultRoot, '01图书馆/material.md'), material); }
    await expect(verifyPersonalBackup(result.snapshotRoot)).rejects.toMatchObject({ code: kind === 'snapshot-link' ? 'PERSONAL_BACKUP_UNSAFE_SNAPSHOT' : 'PERSONAL_BACKUP_MISMATCH' });
  });

  it.each(['traversal', 'duplicate', 'missing-root', 'wrong-cache-key'] as const)('rejects manifest %s without reading outside the snapshot', async kind => {
    const f = await fixture(); const result = await createPersonalBackup(f);
    await rewriteManifest(result.snapshotRoot, manifest => {
      if (kind === 'traversal') manifest.entries[0].path = '../../outside';
      else if (kind === 'duplicate') manifest.entries.push(manifest.entries[0]);
      else if (kind === 'missing-root') manifest.entries = manifest.entries.filter((entry: any) => entry.path !== 'vault/02知识库');
      else manifest.source.vault.cacheKey = 'b'.repeat(64);
    });
    await expect(verifyPersonalBackup(result.snapshotRoot)).rejects.toMatchObject({ code: 'PERSONAL_BACKUP_MANIFEST_INVALID' });
  });

  it('rejects mismatched app settings or current vault cache before creating a snapshot', async () => {
    const f = await fixture();
    await fs.writeFile(join(f.userDataRoot, 'config/app-config.json'), JSON.stringify({ vaultRoot: f.destinationRoot }));
    await expect(createPersonalBackup(f)).rejects.toMatchObject({ code: 'PERSONAL_BACKUP_VAULT_BINDING_MISMATCH' });
    await fs.writeFile(join(f.userDataRoot, 'config/app-config.json'), JSON.stringify({ vaultRoot: f.vaultRoot }));
    await fs.rm(join(f.stateRoot, 'state.sqlite3'));
    await expect(createPersonalBackup(f)).rejects.toMatchObject({ code: 'PERSONAL_BACKUP_REQUIRED_ENTRY_MISSING' });
    expect(await fs.readdir(f.destinationRoot)).toEqual([]);
  });

  it.each(['corrupt', 'foreign-key-violation'] as const)('rejects a %s SQLite copy and always cleans the offline work directory', async kind => {
    const f = await fixture();
    if (kind === 'corrupt') await fs.writeFile(join(f.stateRoot, 'state.sqlite3'), 'not a SQLite database');
    else {
      const db = new Database(join(f.stateRoot, 'state.sqlite3')); db.pragma('foreign_keys=OFF'); db.exec('INSERT INTO children VALUES(2,99)'); db.close();
    }
    const result = await createPersonalBackup(f);
    const realMkdtemp = fs.mkdtemp; const temporary: string[] = [];
    vi.spyOn(fs, 'mkdtemp').mockImplementation(async (...args: Parameters<typeof fs.mkdtemp>) => {
      const path = await realMkdtemp(...args) as string; temporary.push(path); return path;
    });
    await expect(verifyPersonalBackup(result.snapshotRoot)).rejects.toMatchObject({ code: 'PERSONAL_BACKUP_SQLITE_INTEGRITY_FAILED' });
    expect(temporary).toHaveLength(1);
    for (const path of temporary) await expect(fs.lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['manifest', 'extra-root-file'] as const)('refuses a snapshot whose %s changes during offline copying', async kind => {
    const f = await fixture(); const result = await createPersonalBackup(f); const realOpen = fs.open; let changed = false;
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (!changed && String(args[0]).includes('xiaozhao-personal-restore-check-')) {
        changed = true;
        if (kind === 'manifest') await fs.appendFile(join(result.snapshotRoot, 'manifest.json'), ' ');
        else await fs.writeFile(join(result.snapshotRoot, 'unexpected'), 'new');
      }
      return realOpen(...args);
    });
    await expect(verifyPersonalBackup(result.snapshotRoot)).rejects.toMatchObject({ code: 'PERSONAL_BACKUP_MISMATCH' });
    expect(changed).toBe(true);
  });
});

describe('personal backup command contract', () => {
  it('accepts exactly the explicit vault, user-data, destination and cold confirmation in any order', () => {
    expect(parseBackupArguments(['--cold', '--destination', '/backup', '--vault', '/vault', '--user-data', '/data']))
      .toEqual({ cold: true, vaultRoot: '/vault', userDataRoot: '/data', destinationRoot: '/backup' });
    expect(parseRestoreArguments(['--snapshot', '/snapshot'])).toBe('/snapshot');
  });
  it.each([
    ['--vault', '/vault', '--user-data', '/data', '--destination', '/backup'],
    ['--cold', '--vault', '/vault', '--user-data', '/data'],
    ['--cold', '--cold', '--vault', '/vault', '--user-data', '/data', '--destination', '/backup'],
    ['--cold', '--vault', '/vault', '--vault', '/vault2', '--user-data', '/data', '--destination', '/backup'],
    ['--cold', '--vault', '--user-data', '/data', '--destination', '/backup'],
    ['--cold', '--password', 'raw-secret', '--vault', '/vault', '--user-data', '/data', '--destination', '/backup']
  ].map(argv => ({ argv })))('rejects incomplete or repeated command flags: $argv', ({ argv }) => {
    expect(() => parseBackupArguments(argv)).toThrowError('PERSONAL_BACKUP_ARGUMENTS_INVALID');
  });
  it('prints only a safe error code for invalid arguments', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const exitCode = process.exitCode;
    try {
      await backupMain(['--password', 'sk-raw-secret-value']);
      expect(stderr).toHaveBeenCalledWith('PERSONAL_BACKUP_ARGUMENTS_INVALID\n');
      expect(stdout).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(2);
      expect(JSON.stringify(stderr.mock.calls)).not.toContain('sk-raw-secret-value');
    } finally { process.exitCode = exitCode; }
  });
  it('reports snapshot identity and scope in command output without credential bytes', async () => {
    const f = await fixture(); const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await backupMain(['--vault', f.vaultRoot, '--user-data', f.userDataRoot, '--destination', f.destinationRoot, '--cold']);
    const output = JSON.parse(String(stdout.mock.calls[0]?.[0]));
    expect(output).toMatchObject({ manifestVersion: 1, sourceVault: { path: f.vaultRoot, cacheKey: f.cacheKey }, applicationRestore: 'unverified', requiresIdentityRebind: true });
    expect(output.exclusions.observed).toEqual(['user-data/Cache', 'vault/node_modules']);
    expect(output.notCovered).toContain('system-keychain');
    expect(output).not.toHaveProperty('credentials');
  });
});
