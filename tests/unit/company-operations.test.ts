import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireCompanyServerLock,
  CompanyOperationsError,
  createCompanyBackup,
  verifyCompanyBackup
} from '../../src/server/company/company-operations.js';
import {
  installCompanySignalHandlers,
  type CompanySignalTarget
} from '../../src/server/company/graceful-shutdown.js';

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'company-operations-'));
  roots.push(root);
  const workspaceRoot = join(root, 'workspace');
  const stateRoot = join(root, 'state');
  const destinationRoot = join(root, 'destination');
  await Promise.all([
    mkdir(join(workspaceRoot, 'incoming'), { recursive: true }),
    mkdir(join(workspaceRoot, 'projects', 'project-1'), { recursive: true }),
    mkdir(join(workspaceRoot, 'skills'), { recursive: true }),
    mkdir(join(workspaceRoot, 'system'), { recursive: true }),
    mkdir(join(stateRoot, 'backups'), { recursive: true }),
    mkdir(join(stateRoot, 'recovery'), { recursive: true }),
    mkdir(destinationRoot, { recursive: true })
  ]);
  await writeFile(join(workspaceRoot, 'projects', 'project-1', '项目说明.md'), '# 项目\n', 'utf8');
  await writeFile(join(stateRoot, 'state.sqlite3'), 'sqlite-fixture', 'utf8');
  return { root, workspaceRoot, stateRoot, destinationRoot };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('company cold backup and restore verification', () => {
  it('copies the complete workspace and state into a hashed immutable snapshot', async () => {
    const paths = await fixture();
    const result = await createCompanyBackup({
      ...paths,
      now: () => new Date('2026-09-20T01:02:03.000Z')
    });

    expect(result.snapshotRoot).toContain('company-backup-20260920T010203000Z-');
    expect(result.manifest.entries).toEqual(expect.arrayContaining([
      { path: 'workspace/incoming', type: 'directory' },
      expect.objectContaining({ path: 'workspace/projects/project-1/项目说明.md', type: 'file' }),
      expect.objectContaining({ path: 'state/state.sqlite3', type: 'file' })
    ]));
    await expect(verifyCompanyBackup(result.snapshotRoot)).resolves.toEqual(result);
    const manifest = JSON.parse(await readFile(join(result.snapshotRoot, 'manifest.json'), 'utf8')) as unknown;
    expect(manifest).toEqual(result.manifest);
  });

  it('rejects changed snapshots, symlinks, overlapping destinations, and a running server', async () => {
    const paths = await fixture();
    const result = await createCompanyBackup(paths);
    await writeFile(join(result.snapshotRoot, 'workspace', 'projects', 'project-1', '项目说明.md'), 'tampered', 'utf8');
    await expect(verifyCompanyBackup(result.snapshotRoot)).rejects.toMatchObject({ code: 'COMPANY_BACKUP_MISMATCH' });

    const clean = await createCompanyBackup(paths);
    await writeFile(join(clean.snapshotRoot, 'unexpected.txt'), 'unexpected', 'utf8');
    await expect(verifyCompanyBackup(clean.snapshotRoot)).rejects.toMatchObject({ code: 'COMPANY_BACKUP_UNSAFE_SNAPSHOT' });

    await symlink(join(paths.workspaceRoot, 'projects'), join(paths.workspaceRoot, 'skills', 'linked-projects'));
    await expect(createCompanyBackup(paths)).rejects.toMatchObject({ code: 'COMPANY_BACKUP_SYMLINK_REJECTED' });
    await expect(createCompanyBackup({ ...paths, destinationRoot: join(paths.workspaceRoot, 'projects') }))
      .rejects.toMatchObject({ code: 'COMPANY_BACKUP_PATH_OVERLAP' });

    await rm(join(paths.workspaceRoot, 'skills', 'linked-projects'));
    const lock = acquireCompanyServerLock(paths.stateRoot);
    await expect(createCompanyBackup(paths)).rejects.toMatchObject({ code: 'COMPANY_BACKUP_SERVER_RUNNING' });
    lock.release();
  });
});

describe('company process lifecycle', () => {
  it('owns one server lock and releases only its own marker', async () => {
    const paths = await fixture();
    const lock = acquireCompanyServerLock(paths.stateRoot, new Date('2026-09-20T00:00:00.000Z'));
    await expect(readFile(lock.path, 'utf8')).resolves.toContain(`"pid":${process.pid}`);
    expect(() => acquireCompanyServerLock(paths.stateRoot)).toThrowError(CompanyOperationsError);
    lock.release();
    expect(() => lock.release()).not.toThrow();
    const replacement = acquireCompanyServerLock(paths.stateRoot);
    replacement.release();
  });

  it('closes exactly once across SIGTERM, SIGINT, and direct shutdown', async () => {
    class Target extends EventEmitter {
      exitCode?: number;
      override on(signal: NodeJS.Signals, listener: () => void): this { return super.on(signal, listener); }
      override off(signal: NodeJS.Signals, listener: () => void): this { return super.off(signal, listener); }
    }
    const target = new Target();
    const close = vi.fn(async () => undefined);
    const controller = installCompanySignalHandlers(close, target as CompanySignalTarget);
    target.emit('SIGTERM');
    target.emit('SIGINT');
    await controller.shutdown();
    expect(close).toHaveBeenCalledOnce();
    controller.dispose();
    expect(target.listenerCount('SIGTERM')).toBe(0);
    expect(target.listenerCount('SIGINT')).toBe(0);
  });
});
