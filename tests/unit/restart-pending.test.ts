import { afterEach, describe, expect, it } from 'vitest';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  classifyNonPermanentCleanup,
  consumeCleanupPending,
  cleanupPendingMatchesRestart,
  consumeRestartPending,
  isVerifiedNonPermanentCleanup,
  loadCleanupPending,
  loadRestartPending,
  markRestartPendingFailed,
  markRestartPendingPrepared,
  markRestartPendingVerified,
  promoteRestartPendingToCleanup,
  restartPendingAlreadyCompleted,
  restartPendingHasVerifiedRestart,
  restartPendingMatchesProfile,
  writeCleanupPending,
  writeRestartPending
} from '../helpers/restart-pending.js';
import {
  buildContractProfile,
  computeContractProfileRevision
} from '../../src/server/vault/contract-profile-store.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function record() {
  return {
    schemaVersion: 1 as const,
    phase: 'prepared' as const,
    runId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    root: 'library' as const,
    noteId: 'restart.md',
    rawSha256: 'a'.repeat(64),
    upstreamVersion: 'version-token:1',
    profileKey: 'b'.repeat(64),
    manualCleanupReasonCode: 'MANUAL_CLEANUP_REQUIRED' as const
  };
}

function preparing() {
  const { upstreamVersion: _upstreamVersion, ...identity } = record();
  return { ...identity, phase: 'preparing' as const };
}

const restartActivation = {
  verifiedAt: '2026-08-31T03:00:00.000Z',
  intendedProfileRevision: 'c'.repeat(64)
};
const cleanupCheckedAt = '2026-08-31T03:30:00.000Z';

const restartFailure = {
  failedAt: '2026-08-31T03:00:01.000Z',
  reasonCode: 'RESTART_STATE_MISMATCH' as const,
  intendedProfileRevision: 'd'.repeat(64)
};

describe('restart pending store', () => {
  it('atomically writes a sanitized 0600 record in a 0700 directory', async () => {
    const base = await mkdtemp(join(tmpdir(), 'restart-pending-'));
    roots.push(base);
    const directory = join(base, 'contract-profiles');
    await writeRestartPending(directory, record());
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, 'restart-pending.json'))).mode & 0o777).toBe(0o600);
    await expect(loadRestartPending(directory)).resolves.toEqual(record());
    expect(await readFile(join(directory, 'restart-pending.json'), 'utf8'))
      .not.toContain('/private/vault');
  });

  it('treats an exact preparing WAL write as an idempotent retry', async () => {
    const base = await mkdtemp(join(tmpdir(), 'restart-pending-'));
    roots.push(base);
    const directory = join(base, 'contract-profiles');
    const wal = preparing();
    await writeRestartPending(directory, wal);
    await expect(writeRestartPending(directory, wal)).resolves.toBeUndefined();
    await expect(loadRestartPending(directory)).resolves.toEqual(wal);
  });

  it('atomically advances the exact preparing WAL to prepared observation facts', async () => {
    const base = await mkdtemp(join(tmpdir(), 'restart-pending-'));
    roots.push(base);
    const directory = join(base, 'contract-profiles');
    const wal = preparing();
    await writeRestartPending(directory, wal);
    const prepared = await markRestartPendingPrepared(directory, wal, {
      rawSha256: wal.rawSha256,
      upstreamVersion: 'version-token:1'
    });
    expect(prepared).toEqual(record());
    await expect(loadRestartPending(directory)).resolves.toEqual(prepared);
    await expect(markRestartPendingPrepared(directory, wal, {
      rawSha256: wal.rawSha256,
      upstreamVersion: 'version-token:1'
    })).resolves.toEqual(prepared);
  });

  it('reconciles visible WAL and prepared records after an injected directory-sync failure', async () => {
    const base = await mkdtemp(join(tmpdir(), 'restart-pending-sync-'));
    roots.push(base);
    const directory = join(base, 'contract-profiles');
    const wal = preparing();
    await expect(writeRestartPending(directory, wal, {
      testOnlySyncAfterCommit: async () => { throw new Error('injected WAL sync failure'); }
    })).rejects.toThrowError('RESTART_PENDING_WRITE_FAILED');
    await expect(loadRestartPending(directory)).resolves.toEqual(wal);
    await expect(writeRestartPending(directory, wal)).resolves.toBeUndefined();

    await expect(markRestartPendingPrepared(directory, wal, {
      rawSha256: wal.rawSha256,
      upstreamVersion: 'version-token:1'
    }, {
      testOnlySyncAfterCommit: async () => { throw new Error('injected transition sync failure'); }
    })).rejects.toThrowError('RESTART_PENDING_NOT_CURRENT');
    await expect(loadRestartPending(directory)).resolves.toEqual(record());
    await expect(markRestartPendingPrepared(directory, wal, {
      rawSha256: wal.rawSha256,
      upstreamVersion: 'version-token:1'
    })).resolves.toEqual(record());
  });

  it.each(['symlink', 'hardlink'] as const)(
    'does not load restart pending through a final-file %s',
    async (kind) => {
      const base = await mkdtemp(join(tmpdir(), 'restart-pending-link-'));
      roots.push(base);
      const directory = join(base, 'contract-profiles');
      await writeRestartPending(directory, record());
      const target = join(directory, 'restart-pending.json');
      const outside = join(base, `outside-${kind}.json`);
      await rename(target, outside);
      if (kind === 'symlink') await symlink(outside, target);
      else await link(outside, target);

      await expect(loadRestartPending(directory)).resolves.toBeUndefined();
    }
  );

  it('rejects a cleanup payload stored under another run filename and mismatched identity', async () => {
    const base = await mkdtemp(join(tmpdir(), 'cleanup-pending-identity-'));
    roots.push(base);
    const directory = join(base, 'contract-profiles');
    const first = record();
    const second = { ...record(), runId: '01ARZ3NDEKTSV4RRFFQ69G5FAW' };
    const cleanup = {
      status: 'failed' as const,
      reasonCode: 'MANUAL_CLEANUP_REQUIRED',
      checkedAt: cleanupCheckedAt
    };
    await writeCleanupPending(directory, second, cleanup);
    await rename(
      join(directory, `cleanup-pending.${second.runId}.json`),
      join(directory, `cleanup-pending.${first.runId}.json`)
    );

    await expect(loadCleanupPending(directory, first.runId)).resolves.toBeUndefined();
    expect(cleanupPendingMatchesRestart({
      ...first,
      cleanupStatus: 'failed',
      cleanupReasonCode: 'MANUAL_CLEANUP_REQUIRED',
      cleanupCheckedAt
    }, first)).toBe(true);
    expect(cleanupPendingMatchesRestart({
      ...first,
      root: 'knowledge',
      cleanupStatus: 'failed',
      cleanupReasonCode: 'MANUAL_CLEANUP_REQUIRED',
      cleanupCheckedAt
    }, first)).toBe(false);
  });

  it('rejects exact pending and cleanup records whose final mode is not 0600', async () => {
    const base = await mkdtemp(join(tmpdir(), 'restart-pending-mode-'));
    roots.push(base);
    const directory = join(base, 'contract-profiles');
    await writeRestartPending(directory, record());
    const pendingPath = join(directory, 'restart-pending.json');
    await chmod(pendingPath, 0o644);

    await expect(loadRestartPending(directory)).resolves.toBeUndefined();
    await expect(writeRestartPending(directory, record()))
      .rejects.toThrowError('RESTART_PENDING_WRITE_FAILED');

    await chmod(pendingPath, 0o600);
    const cleanup = {
      status: 'unverified' as const,
      reasonCode: 'MANUAL_CLEANUP_REQUIRED',
      checkedAt: cleanupCheckedAt
    };
    await writeCleanupPending(directory, record(), cleanup);
    const cleanupPath = join(directory, `cleanup-pending.${record().runId}.json`);
    await chmod(cleanupPath, 0o644);
    await expect(loadCleanupPending(directory, record().runId)).resolves.toBeUndefined();
    await expect(writeCleanupPending(directory, record(), cleanup))
      .rejects.toThrowError('RESTART_PENDING_WRITE_FAILED');
  });

  it.each(['symlink', 'hardlink'] as const)(
    'rejects an existing-exact cleanup final-file %s',
    async (kind) => {
      const base = await mkdtemp(join(tmpdir(), 'cleanup-pending-link-'));
      roots.push(base);
      const directory = join(base, 'contract-profiles');
      const cleanup = {
        status: 'unverified' as const,
        reasonCode: 'MANUAL_CLEANUP_REQUIRED',
        checkedAt: cleanupCheckedAt
      };
      await writeCleanupPending(directory, record(), cleanup);
      const target = join(directory, `cleanup-pending.${record().runId}.json`);
      const outside = join(base, `outside-cleanup-${kind}.json`);
      await rename(target, outside);
      if (kind === 'symlink') await symlink(outside, target);
      else await link(outside, target);

      await expect(writeCleanupPending(directory, record(), cleanup))
        .rejects.toThrowError('RESTART_PENDING_WRITE_FAILED');
      await expect(loadCleanupPending(directory, record().runId)).resolves.toBeUndefined();
    }
  );

  it('fails closed for missing, malformed, or path-bearing records', async () => {
    const base = await mkdtemp(join(tmpdir(), 'restart-pending-'));
    roots.push(base);
    const directory = join(base, 'contract-profiles');
    await expect(loadRestartPending(directory)).resolves.toBeUndefined();
    await expect(writeRestartPending(directory, {
      ...record(),
      noteId: '../private/restart.md'
    })).rejects.toThrowError('RESTART_PENDING_INVALID');
    await writeRestartPending(directory, record());
    await writeFile(join(directory, 'restart-pending.json'), 'secret malformed json');
    await expect(loadRestartPending(directory)).resolves.toBeUndefined();
  });

  it('bounds final-file reads before parsing', async () => {
    const base = await mkdtemp(join(tmpdir(), 'restart-pending-bounded-'));
    roots.push(base);
    const directory = join(base, 'contract-profiles');
    await mkdir(directory, { mode: 0o700 });
    await writeFile(join(directory, 'restart-pending.json'), 'x'.repeat(32 * 1024), {
      mode: 0o600
    });

    await expect(loadRestartPending(directory)).resolves.toBeUndefined();
  });

  it('rejects a symlinked pending directory for writes and loads', async () => {
    const base = await mkdtemp(join(tmpdir(), 'restart-pending-symlink-'));
    roots.push(base);
    const directory = join(base, 'contract-profiles');
    const outside = join(base, 'outside');
    await mkdir(outside);
    await symlink(outside, directory);

    await expect(writeRestartPending(directory, record()))
      .rejects.toThrowError('RESTART_PENDING_WRITE_FAILED');
    expect(await readdir(outside)).toEqual([]);

    await rm(directory);
    await writeRestartPending(outside, record());
    await symlink(outside, directory);
    await expect(loadRestartPending(directory)).resolves.toBeUndefined();
  });

  it('matches the exact profile key and consumes a verified record once', async () => {
    const base = await mkdtemp(join(tmpdir(), 'restart-pending-'));
    roots.push(base);
    const directory = join(base, 'contract-profiles');
    const pending = record();
    expect(restartPendingMatchesProfile(pending, pending.profileKey)).toBe(true);
    expect(restartPendingMatchesProfile(pending, 'c'.repeat(64))).toBe(false);
    await writeRestartPending(directory, pending);
    expect(restartPendingMatchesProfile((await loadRestartPending(directory))!, 'c'.repeat(64))).toBe(false);
    await expect(loadRestartPending(directory)).resolves.toEqual(pending);
    await consumeRestartPending(directory, pending);
    await expect(loadRestartPending(directory)).resolves.toBeUndefined();
    await expect(consumeRestartPending(directory, pending))
      .rejects.toThrowError('RESTART_PENDING_NOT_CURRENT');
  });

  it('atomically advances only the exact current run to restart-verified', async () => {
    const base = await mkdtemp(join(tmpdir(), 'restart-pending-'));
    roots.push(base);
    const directory = join(base, 'contract-profiles');
    const pending = record();
    await writeRestartPending(directory, pending);

    await expect(markRestartPendingVerified(directory, {
      ...pending,
      upstreamVersion: 'other-version'
    }, restartActivation)).rejects.toThrowError('RESTART_PENDING_NOT_CURRENT');
    await expect(loadRestartPending(directory)).resolves.toEqual(pending);

    const verified = await markRestartPendingVerified(directory, pending, restartActivation);
    expect(verified).toEqual({
      ...pending,
      phase: 'restart-verified',
      ...restartActivation
    });
    await expect(loadRestartPending(directory)).resolves.toEqual(verified);
    await expect(markRestartPendingVerified(directory, pending, restartActivation))
      .resolves.toEqual(verified);
    await expect(markRestartPendingVerified(directory, verified, {
      verifiedAt: '2026-08-31T03:00:01.000Z',
      intendedProfileRevision: 'd'.repeat(64)
    })).rejects.toThrowError('RESTART_PENDING_NOT_CURRENT');
    await expect(markRestartPendingVerified(directory, verified, {
      verifiedAt: restartActivation.verifiedAt,
      intendedProfileRevision: 'd'.repeat(64)
    })).rejects.toThrowError('RESTART_PENDING_NOT_CURRENT');
    await expect(loadRestartPending(directory)).resolves.toEqual(verified);
  });

  it('atomically advances a mismatch to a terminal restart-failed record', async () => {
    const base = await mkdtemp(join(tmpdir(), 'restart-pending-failed-'));
    roots.push(base);
    const directory = join(base, 'contract-profiles');
    const pending = record();
    await writeRestartPending(directory, pending);

    const failed = await markRestartPendingFailed(directory, pending, restartFailure);
    expect(failed).toEqual({
      ...pending,
      phase: 'restart-failed',
      ...restartFailure
    });
    await expect(loadRestartPending(directory)).resolves.toEqual(failed);
    await expect(markRestartPendingFailed(directory, pending, restartFailure))
      .resolves.toEqual(failed);
    await expect(markRestartPendingVerified(directory, pending, restartActivation))
      .rejects.toThrowError('RESTART_PENDING_NOT_CURRENT');
  });

  it('allows only one terminal outcome to win a concurrent failed-versus-verified race', async () => {
    const base = await mkdtemp(join(tmpdir(), 'restart-pending-outcome-race-'));
    roots.push(base);
    const directory = join(base, 'contract-profiles');
    const pending = record();
    await writeRestartPending(directory, pending);

    const settled = await Promise.allSettled([
      markRestartPendingFailed(directory, pending, restartFailure),
      markRestartPendingVerified(directory, pending, restartActivation)
    ]);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await loadRestartPending(directory))?.phase)
      .toMatch(/^(restart-failed|restart-verified)$/);
  });

  it('restores claimed bytes after corrupt or mismatched records fail consumption', async () => {
    const base = await mkdtemp(join(tmpdir(), 'restart-pending-'));
    roots.push(base);
    const directory = join(base, 'contract-profiles');
    const pending = record();
    await writeRestartPending(directory, pending);
    await writeFile(join(directory, 'restart-pending.json'), 'corrupt secret-free bytes\n');
    await expect(consumeRestartPending(directory, pending))
      .rejects.toThrowError('RESTART_PENDING_NOT_CURRENT');
    await expect(readFile(join(directory, 'restart-pending.json'), 'utf8'))
      .resolves.toBe('corrupt secret-free bytes\n');

    await writeFile(join(directory, 'restart-pending.json'), `${JSON.stringify({
      ...pending,
      upstreamVersion: 'version-token:2'
    })}\n`);
    await expect(consumeRestartPending(directory, pending))
      .rejects.toThrowError('RESTART_PENDING_NOT_CURRENT');
    await expect(loadRestartPending(directory)).resolves.toMatchObject({
      upstreamVersion: 'version-token:2'
    });
    expect((await readdir(directory)).some((name) => name.includes('.claimed.'))).toBe(false);
  });

  it('serializes concurrent consumers so exactly one can consume the current record', async () => {
    const base = await mkdtemp(join(tmpdir(), 'restart-pending-'));
    roots.push(base);
    const directory = join(base, 'contract-profiles');
    const pending = record();
    await writeRestartPending(directory, pending);
    const settled = await Promise.allSettled([
      consumeRestartPending(directory, pending),
      consumeRestartPending(directory, pending)
    ]);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await readdir(directory)).some((name) => (
      name.includes('.claimed.') || name.endsWith('.lock') || name.endsWith('.tmp')
    ))).toBe(false);
  });

  it('serializes concurrent writers without replacing an already committed pending record', async () => {
    const base = await mkdtemp(join(tmpdir(), 'restart-pending-'));
    roots.push(base);
    const directory = join(base, 'contract-profiles');
    const left = record();
    const right = { ...record(), runId: '01ARZ3NDEKTSV4RRFFQ69G5FAW' };
    const settled = await Promise.allSettled([
      writeRestartPending(directory, left),
      writeRestartPending(directory, right)
    ]);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect([left, right]).toContainEqual(await loadRestartPending(directory));
    expect((await readdir(directory)).some((name) => (
      name.endsWith('.lock') || name.endsWith('.tmp')
    ))).toBe(false);
  });

  it('promotes verified restart state to a 0600 cleanup-pending record without losing identifiers', async () => {
    const base = await mkdtemp(join(tmpdir(), 'restart-pending-'));
    roots.push(base);
    const directory = join(base, 'contract-profiles');
    const pending = record();
    await writeRestartPending(directory, pending);
    await promoteRestartPendingToCleanup(directory, pending, {
      status: 'unverified',
      reasonCode: 'MANUAL_CLEANUP_REQUIRED',
      checkedAt: cleanupCheckedAt
    });
    await expect(loadRestartPending(directory)).resolves.toBeUndefined();
    await expect(loadCleanupPending(directory, pending.runId)).resolves.toMatchObject({
      runId: pending.runId,
      noteId: pending.noteId,
      profileKey: pending.profileKey,
      cleanupStatus: 'unverified',
      cleanupReasonCode: 'MANUAL_CLEANUP_REQUIRED',
      cleanupCheckedAt
    });
    expect((await stat(join(directory, `cleanup-pending.${pending.runId}.json`))).mode & 0o777)
      .toBe(0o600);
  });

  it('restores restart pending if cleanup promotion cannot commit', async () => {
    const base = await mkdtemp(join(tmpdir(), 'restart-pending-'));
    roots.push(base);
    const directory = join(base, 'contract-profiles');
    const pending = record();
    await writeRestartPending(directory, pending);
    const cleanupPath = join(directory, `cleanup-pending.${pending.runId}.json`);
    await writeFile(cleanupPath, 'existing cleanup\n', { mode: 0o600 });
    await expect(promoteRestartPendingToCleanup(directory, pending, {
      status: 'failed',
      reasonCode: 'CONDITIONAL_NONPERMANENT_CLEANUP_FAILED',
      checkedAt: cleanupCheckedAt
    })).rejects.toThrowError('RESTART_PENDING_NOT_CURRENT');
    await expect(loadRestartPending(directory)).resolves.toEqual(pending);
    await expect(readFile(cleanupPath, 'utf8'))
      .resolves.toBe('existing cleanup\n');
  });

  it('writes an idempotent per-run cleanup record directly for prepare-time orphans', async () => {
    const base = await mkdtemp(join(tmpdir(), 'restart-pending-'));
    roots.push(base);
    const directory = join(base, 'contract-profiles');
    const pending = record();
    const cleanup = {
      status: 'unverified' as const,
      reasonCode: 'MANUAL_CLEANUP_REQUIRED',
      checkedAt: cleanupCheckedAt
    };

    await writeRestartPending(directory, pending);
    await writeCleanupPending(directory, pending, cleanup);
    await writeCleanupPending(directory, pending, cleanup);
    await expect(loadCleanupPending(directory, pending.runId)).resolves.toMatchObject({
      runId: pending.runId,
      noteId: pending.noteId,
      cleanupStatus: 'unverified',
      cleanupReasonCode: 'MANUAL_CLEANUP_REQUIRED',
      cleanupCheckedAt
    });
    const stored = await loadCleanupPending(directory, pending.runId);
    expect(stored).toBeDefined();
    await consumeCleanupPending(directory, stored!);
    await expect(loadCleanupPending(directory, pending.runId)).resolves.toBeUndefined();
    await expect(loadRestartPending(directory)).resolves.toEqual(pending);
    await consumeRestartPending(directory, pending);
    await expect(loadRestartPending(directory)).resolves.toBeUndefined();
    await expect(consumeCleanupPending(directory, stored!))
      .rejects.toThrowError('RESTART_PENDING_NOT_CURRENT');
  });

  it('keeps exact cleanup recovery bytes when rollback finds a changed target', async () => {
    const base = await mkdtemp(join(tmpdir(), 'cleanup-pending-rollback-'));
    roots.push(base);
    const directory = join(base, 'contract-profiles');
    const pending = record();
    const cleanup = {
      status: 'failed' as const,
      reasonCode: 'MANUAL_CLEANUP_REQUIRED',
      checkedAt: cleanupCheckedAt
    };
    await writeCleanupPending(directory, pending, cleanup);
    const stored = await loadCleanupPending(directory, pending.runId);
    expect(stored).toBeDefined();

    await expect(consumeCleanupPending(directory, stored!, {
      testOnlySyncAfterTargetUnlink: async (currentDirectory) => {
        await writeFile(
          join(currentDirectory, `cleanup-pending.${pending.runId}.json`),
          'changed\n',
          { mode: 0o600 }
        );
        throw new Error('injected sync failure');
      }
    })).rejects.toThrowError('RESTART_PENDING_NOT_CURRENT');
    const names = await readdir(directory);
    expect(names).toContain(`cleanup-pending.${pending.runId}.recovery.json`);
    expect(await readFile(
      join(directory, `cleanup-pending.${pending.runId}.recovery.json`),
      'utf8'
    )).toBe(`${JSON.stringify(stored)}\n`);
  });

  it('restores the pending target when post-unlink durability fails during consumption', async () => {
    const base = await mkdtemp(join(tmpdir(), 'restart-pending-'));
    roots.push(base);
    const directory = join(base, 'contract-profiles');
    const pending = record();
    await writeRestartPending(directory, pending);
    let syncAttempted = false;

    await expect(consumeRestartPending(directory, pending, {
      testOnlySyncAfterClaimUnlink: async () => {
        syncAttempted = true;
        throw new Error('injected sync failure');
      }
    })).rejects.toThrowError('RESTART_PENDING_NOT_CURRENT');
    expect(syncAttempted).toBe(true);
    await expect(loadRestartPending(directory)).resolves.toEqual(pending);
  });

  it('keeps both durable locators when post-promotion pending removal fails', async () => {
    const base = await mkdtemp(join(tmpdir(), 'restart-pending-'));
    roots.push(base);
    const directory = join(base, 'contract-profiles');
    const pending = record();
    await writeRestartPending(directory, pending);
    let removalAttempted = false;

    await expect(promoteRestartPendingToCleanup(directory, pending, {
      status: 'failed',
      reasonCode: 'CONDITIONAL_NONPERMANENT_CLEANUP_FAILED',
      checkedAt: cleanupCheckedAt
    }, {
      testOnlyRemoveClaimAfterCleanupCommit: async () => {
        removalAttempted = true;
        throw new Error('injected claim removal failure');
      }
    })).rejects.toThrowError('RESTART_PENDING_NOT_CURRENT');
    expect(removalAttempted).toBe(true);
    await expect(loadRestartPending(directory)).resolves.toEqual(pending);
    await expect(loadCleanupPending(directory, pending.runId)).resolves.toMatchObject({
      cleanupStatus: 'failed'
    });
  });

  it('passes cleanup only after a successful trash response and a 404 raw reread', () => {
    expect(isVerifiedNonPermanentCleanup(204, 404)).toBe(true);
    expect(isVerifiedNonPermanentCleanup(204, 200)).toBe(false);
    expect(isVerifiedNonPermanentCleanup(500, 404)).toBe(false);
  });

  it('never treats a cleanup target that was already missing as verified deletion', () => {
    expect(classifyNonPermanentCleanup({ preReadStatus: 404 })).toEqual({
      status: 'failed',
      reasonCode: 'CLEANUP_TARGET_ALREADY_MISSING'
    });
    expect(classifyNonPermanentCleanup({
      preReadStatus: 200,
      deleteStatus: 204,
      rereadStatus: 404
    })).toEqual({
      status: 'passed',
      reasonCode: 'CONDITIONAL_NONPERMANENT_CLEANUP_PASSED'
    });
  });

  it('recognizes a persisted restart-plus-cleanup success so a restored pending can be consumed on retry', () => {
    const pending = record();
    const completedAt = '2026-08-31T03:00:00.000Z';
    const intendedProfileRevision = 'c'.repeat(64);
    const cleanupReasonCode = `CLEANUP_PASSED:${pending.runId}:${intendedProfileRevision.toUpperCase()}`;
    const profile = buildContractProfile({
      pluginId: 'obsidian-local-rest-api',
      pluginVersion: '5.1.0',
      obsidianVersion: '1.13.7',
      openApiSha256: 'a'.repeat(64),
      checkedAt: completedAt,
      restartCheckedAt: completedAt,
      safeRead: false,
      safeCreate: false,
      safeReplace: false,
      safeRestore: false,
      safeDelete: false,
      rereadVerified: false,
      externalMutationObservation: 'unverified',
      restartPersistence: 'passed',
      evidence: [
        {
          operation: 'restartPersistence',
          status: 'passed',
          timestamp: completedAt,
          reasonCode: 'RAW_HASH_AND_VERSION_PERSISTED',
          primitive: 'RAW_REREAD'
        },
        {
          operation: 'cleanup',
          status: 'passed',
          timestamp: completedAt,
          reasonCode: cleanupReasonCode,
          primitive: 'DELETE_NON_PERMANENT'
        }
      ]
    });
    const matchingPending = {
      ...pending,
      phase: 'restart-verified' as const,
      profileKey: profile.profileKey,
      verifiedAt: completedAt,
      intendedProfileRevision
    };

    expect(restartPendingAlreadyCompleted(matchingPending, profile)).toBe(true);
    expect(restartPendingAlreadyCompleted(pending, profile)).toBe(false);
    expect(restartPendingAlreadyCompleted({
      ...matchingPending,
      runId: '01ARZ3NDEKTSV4RRFFQ69G5FAW'
    }, profile)).toBe(false);
  });

  it('keeps a run in the verified-restart phase while cleanup is failed or unverified', () => {
    const pending = record();
    const checkedAt = '2026-08-31T03:00:00.000Z';
    const verifiedRestart = buildContractProfile({
      pluginId: 'obsidian-local-rest-api',
      pluginVersion: '5.1.0',
      obsidianVersion: '1.13.7',
      openApiSha256: 'a'.repeat(64),
      checkedAt,
      restartCheckedAt: checkedAt,
      safeRead: false,
      safeCreate: false,
      safeReplace: false,
      safeRestore: false,
      safeDelete: false,
      rereadVerified: false,
      externalMutationObservation: 'unverified',
      restartPersistence: 'passed',
      evidence: [
        {
          operation: 'restartPersistence',
          status: 'passed',
          timestamp: checkedAt,
          reasonCode: 'RAW_HASH_AND_VERSION_PERSISTED',
          primitive: 'RAW_REREAD'
        },
        {
          operation: 'cleanup',
          status: 'failed',
          timestamp: checkedAt,
          reasonCode: 'CONDITIONAL_NONPERMANENT_CLEANUP_FAILED',
          primitive: 'DELETE_NON_PERMANENT'
        }
      ]
    });
    const matching = {
      ...pending,
      phase: 'restart-verified' as const,
      profileKey: verifiedRestart.profileKey,
      verifiedAt: checkedAt,
      intendedProfileRevision: computeContractProfileRevision(verifiedRestart)
    };

    expect(restartPendingHasVerifiedRestart(matching, verifiedRestart)).toBe(true);
    expect(restartPendingAlreadyCompleted(matching, verifiedRestart)).toBe(false);
    expect(restartPendingHasVerifiedRestart(pending, verifiedRestart)).toBe(false);

    const {
      schemaVersion: _schemaVersion,
      profileKey: _profileKey,
      formalWriteGate: _formalWriteGate,
      ...verifiedRestartInput
    } = verifiedRestart;
    const downgraded = buildContractProfile({
      ...verifiedRestartInput,
      restartPersistence: 'failed',
      evidence: [
        ...verifiedRestart.evidence,
        {
          operation: 'restartPersistence',
          status: 'failed',
          timestamp: '2026-08-31T04:00:00.000Z',
          reasonCode: 'RESTART_STATE_MISMATCH',
          primitive: 'RAW_REREAD'
        }
      ]
    });
    expect(restartPendingHasVerifiedRestart(
      { ...pending, profileKey: downgraded.profileKey },
      downgraded
    )).toBe(false);
  });
});
