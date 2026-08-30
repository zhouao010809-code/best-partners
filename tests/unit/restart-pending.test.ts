import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  consumeRestartPending,
  isVerifiedNonPermanentCleanup,
  loadCleanupPending,
  loadRestartPending,
  markRestartPendingVerified,
  promoteRestartPendingToCleanup,
  restartPendingAlreadyCompleted,
  restartPendingHasVerifiedRestart,
  restartPendingMatchesProfile,
  writeCleanupPending,
  writeRestartPending
} from '../helpers/restart-pending.js';
import { buildContractProfile } from '../../src/server/vault/contract-profile-store.js';

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
    profileKey: 'b'.repeat(64)
  };
}

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
    })).rejects.toThrowError('RESTART_PENDING_NOT_CURRENT');
    await expect(loadRestartPending(directory)).resolves.toEqual(pending);

    const verified = await markRestartPendingVerified(directory, pending);
    expect(verified).toEqual({ ...pending, phase: 'restart-verified' });
    await expect(loadRestartPending(directory)).resolves.toEqual(verified);
    await expect(markRestartPendingVerified(directory, verified)).resolves.toEqual(verified);
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
      reasonCode: 'MANUAL_CLEANUP_REQUIRED'
    });
    await expect(loadRestartPending(directory)).resolves.toBeUndefined();
    await expect(loadCleanupPending(directory, pending.runId)).resolves.toMatchObject({
      runId: pending.runId,
      noteId: pending.noteId,
      profileKey: pending.profileKey,
      cleanupStatus: 'unverified',
      cleanupReasonCode: 'MANUAL_CLEANUP_REQUIRED'
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
      reasonCode: 'CONDITIONAL_NONPERMANENT_CLEANUP_FAILED'
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
    const cleanup = { status: 'unverified' as const, reasonCode: 'MANUAL_CLEANUP_REQUIRED' };

    await writeCleanupPending(directory, pending, cleanup);
    await writeCleanupPending(directory, pending, cleanup);
    await expect(loadCleanupPending(directory, pending.runId)).resolves.toMatchObject({
      runId: pending.runId,
      noteId: pending.noteId,
      cleanupStatus: 'unverified',
      cleanupReasonCode: 'MANUAL_CLEANUP_REQUIRED'
    });
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

  it('keeps cleanup as the only active record when post-promotion claim removal fails', async () => {
    const base = await mkdtemp(join(tmpdir(), 'restart-pending-'));
    roots.push(base);
    const directory = join(base, 'contract-profiles');
    const pending = record();
    await writeRestartPending(directory, pending);
    let removalAttempted = false;

    await promoteRestartPendingToCleanup(directory, pending, {
      status: 'failed',
      reasonCode: 'CONDITIONAL_NONPERMANENT_CLEANUP_FAILED'
    }, {
      testOnlyRemoveClaimAfterCleanupCommit: async () => {
        removalAttempted = true;
        throw new Error('injected claim removal failure');
      }
    });
    expect(removalAttempted).toBe(true);
    await expect(loadRestartPending(directory)).resolves.toBeUndefined();
    await expect(loadCleanupPending(directory, pending.runId)).resolves.toMatchObject({
      cleanupStatus: 'failed'
    });
  });

  it('passes cleanup only after a successful trash response and a 404 raw reread', () => {
    expect(isVerifiedNonPermanentCleanup(204, 404)).toBe(true);
    expect(isVerifiedNonPermanentCleanup(204, 200)).toBe(false);
    expect(isVerifiedNonPermanentCleanup(500, 404)).toBe(false);
  });

  it('recognizes a persisted restart-plus-cleanup success so a restored pending can be consumed on retry', () => {
    const pending = record();
    const completedAt = '2026-08-31T03:00:00.000Z';
    const profile = buildContractProfile({
      pluginId: 'obsidian-local-rest-api',
      pluginVersion: '5.1.0',
      obsidianVersion: '1.13.7',
      openApiSha256: 'a'.repeat(64),
      checkedAt: completedAt,
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
          reasonCode: 'CONDITIONAL_NONPERMANENT_CLEANUP_PASSED',
          primitive: 'DELETE_NON_PERMANENT'
        }
      ]
    });
    const matchingPending = {
      ...pending,
      phase: 'restart-verified' as const,
      profileKey: profile.profileKey
    };

    expect(restartPendingAlreadyCompleted(matchingPending, profile)).toBe(true);
    expect(restartPendingAlreadyCompleted(pending, profile)).toBe(false);
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
      profileKey: verifiedRestart.profileKey
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
