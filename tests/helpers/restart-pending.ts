import { randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import type { StoredContractProfile } from '../../src/server/vault/contract-profile-store.js';

const reasonCodeSchema = z.string().min(1).max(128).regex(/^[A-Z0-9_:-]+$/);
const restartPendingSchema = z.object({
  schemaVersion: z.literal(1),
  phase: z.enum(['prepared', 'restart-verified']),
  runId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  root: z.enum(['library', 'knowledge']),
  noteId: z.string().min(1).max(64).regex(/^[a-z0-9._-]+$/i),
  rawSha256: z.string().regex(/^[a-f0-9]{64}$/),
  upstreamVersion: z.string().min(1).max(256).regex(/^[a-z0-9._:-]+$/i),
  profileKey: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
const cleanupPendingSchema = restartPendingSchema.extend({
  cleanupStatus: z.enum(['unverified', 'failed']),
  cleanupReasonCode: reasonCodeSchema
}).strict();

export type RestartPending = z.infer<typeof restartPendingSchema>;
export type CleanupPending = z.infer<typeof cleanupPendingSchema>;

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as NodeJS.ErrnoException).code === code;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return false;
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function resolvePendingDirectory(directory: string, create: boolean): Promise<string> {
  const name = basename(directory);
  if (!/^[a-z0-9._-]+$/i.test(name) || name === '.' || name === '..') throw new Error('unsafe');
  const parent = await realpath(dirname(directory));
  const candidate = join(parent, name);
  try {
    const status = await lstat(candidate);
    if (status.isSymbolicLink() || !status.isDirectory()) throw new Error('unsafe');
  } catch (error) {
    if (!hasCode(error, 'ENOENT') || !create) throw error;
    await mkdir(candidate, { mode: 0o700 });
    const created = await lstat(candidate);
    if (created.isSymbolicLink() || !created.isDirectory()) throw new Error('unsafe');
  }
  if (await realpath(candidate) !== candidate) throw new Error('unsafe');
  if (create) await chmod(candidate, 0o700);
  return candidate;
}

async function withPendingLock<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = join(directory, 'restart-pending.lock');
  const deadline = Date.now() + 5_000;
  let lock;
  while (lock === undefined) {
    try {
      const candidate = await open(lockPath, 'wx', 0o600);
      try {
        await candidate.sync();
        lock = candidate;
      } catch (error) {
        await candidate.close().catch(() => {});
        await unlink(lockPath).catch(() => {});
        throw error;
      }
    } catch (error) {
      if (!hasCode(error, 'EEXIST') || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  let completed = false;
  let value: T | undefined;
  let operationFailure: unknown;
  try {
    value = await operation();
    completed = true;
  } catch (error) {
    operationFailure = error;
  }
  try {
    await lock.close();
  } catch {
    // A committed pending-state transition remains authoritative.
  }
  try {
    await unlink(lockPath);
    await syncDirectory(directory);
  } catch {
    // A leftover lock makes later transitions fail closed; it cannot undo this one.
  }
  if (!completed) throw operationFailure;
  return value as T;
}

async function atomicWriteExclusive(
  directory: string,
  fileName: string,
  serialized: string,
  allowExistingExact = false
): Promise<void> {
  const target = join(directory, fileName);
  const temporary = join(directory, `${fileName}.${randomUUID()}.tmp`);
  const stored = `${serialized}\n`;
  let handle;
  try {
    if (await exists(target)) {
      if (allowExistingExact && await readFile(target, 'utf8') === stored) return;
      throw new Error('target exists');
    }
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(stored, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (await exists(target)) throw new Error('target exists');
    await rename(temporary, target);
    // Rename is the commit point. A post-commit fsync failure must not make the
    // caller restore another active record alongside this one.
    await syncDirectory(directory).catch(() => {});
  } catch (error) {
    try {
      await handle?.close();
    } catch {
      // Best-effort close before removing an uncommitted record.
    }
    try {
      await unlink(temporary);
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
}

export async function writeRestartPending(
  profileDirectory: string,
  value: RestartPending
): Promise<void> {
  let parsed: RestartPending;
  try {
    parsed = restartPendingSchema.parse(value);
  } catch {
    throw new Error('RESTART_PENDING_INVALID');
  }
  try {
    const canonicalDirectory = await resolvePendingDirectory(profileDirectory, true);
    await withPendingLock(canonicalDirectory, async () => {
      await atomicWriteExclusive(canonicalDirectory, 'restart-pending.json', JSON.stringify(parsed));
    });
  } catch {
    throw new Error('RESTART_PENDING_WRITE_FAILED');
  }
}

export async function loadRestartPending(
  profileDirectory: string
): Promise<RestartPending | undefined> {
  try {
    const canonicalDirectory = await resolvePendingDirectory(profileDirectory, false);
    return restartPendingSchema.parse(
      JSON.parse(await readFile(join(canonicalDirectory, 'restart-pending.json'), 'utf8')) as unknown
    );
  } catch {
    return undefined;
  }
}

export async function markRestartPendingVerified(
  profileDirectory: string,
  expected: RestartPending
): Promise<RestartPending> {
  let parsedExpected: RestartPending;
  try {
    parsedExpected = restartPendingSchema.parse(expected);
  } catch {
    throw new Error('RESTART_PENDING_NOT_CURRENT');
  }
  try {
    const canonicalDirectory = await resolvePendingDirectory(profileDirectory, false);
    return await withPendingLock(canonicalDirectory, async () => {
      const target = join(canonicalDirectory, 'restart-pending.json');
      const current = restartPendingSchema.parse(
        JSON.parse(await readFile(target, 'utf8')) as unknown
      );
      if (JSON.stringify(current) !== JSON.stringify(parsedExpected)) {
        throw new Error('mismatch');
      }
      if (current.phase === 'restart-verified') return current;

      const verified = restartPendingSchema.parse({ ...current, phase: 'restart-verified' });
      const temporary = join(
        canonicalDirectory,
        `restart-pending.verified.${randomUUID()}.tmp`
      );
      let handle;
      try {
        handle = await open(temporary, 'wx', 0o600);
        await handle.writeFile(`${JSON.stringify(verified)}\n`, 'utf8');
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temporary, target);
        await syncDirectory(canonicalDirectory);
        return verified;
      } catch (error) {
        await handle?.close().catch(() => {});
        await unlink(temporary).catch(() => {});
        throw error;
      }
    });
  } catch {
    throw new Error('RESTART_PENDING_NOT_CURRENT');
  }
}

export async function loadCleanupPending(
  profileDirectory: string,
  runId: string
): Promise<CleanupPending | undefined> {
  try {
    const parsedRunId = restartPendingSchema.shape.runId.parse(runId);
    const canonicalDirectory = await resolvePendingDirectory(profileDirectory, false);
    return cleanupPendingSchema.parse(
      JSON.parse(await readFile(
        join(canonicalDirectory, `cleanup-pending.${parsedRunId}.json`),
        'utf8'
      )) as unknown
    );
  } catch {
    return undefined;
  }
}

function buildCleanupPending(
  pending: RestartPending,
  cleanup: { readonly status: 'unverified' | 'failed'; readonly reasonCode: string }
): CleanupPending {
  return cleanupPendingSchema.parse({
    ...pending,
    cleanupStatus: cleanup.status,
    cleanupReasonCode: cleanup.reasonCode
  });
}

function cleanupFileName(runId: string): string {
  return `cleanup-pending.${runId}.json`;
}

export async function writeCleanupPending(
  profileDirectory: string,
  pending: RestartPending,
  cleanup: { readonly status: 'unverified' | 'failed'; readonly reasonCode: string }
): Promise<void> {
  let record: CleanupPending;
  try {
    record = buildCleanupPending(pending, cleanup);
  } catch {
    throw new Error('RESTART_PENDING_INVALID');
  }
  try {
    const canonicalDirectory = await resolvePendingDirectory(profileDirectory, true);
    await withPendingLock(canonicalDirectory, async () => {
      await atomicWriteExclusive(
        canonicalDirectory,
        cleanupFileName(record.runId),
        JSON.stringify(record),
        true
      );
    });
  } catch {
    throw new Error('RESTART_PENDING_WRITE_FAILED');
  }
}

export function restartPendingMatchesProfile(
  pending: RestartPending,
  profileKey: string
): boolean {
  return pending.profileKey === profileKey;
}

export function restartPendingAlreadyCompleted(
  pending: RestartPending,
  profile: StoredContractProfile
): boolean {
  const cleanup = profile.evidence
    .filter((record) => record.operation === 'cleanup')
    .at(-1);
  return restartPendingHasVerifiedRestart(pending, profile)
    && cleanup?.status === 'passed'
    && cleanup.reasonCode === 'CONDITIONAL_NONPERMANENT_CLEANUP_PASSED'
    && cleanup.primitive === 'DELETE_NON_PERMANENT';
}

export function restartPendingHasVerifiedRestart(
  pending: RestartPending,
  profile: StoredContractProfile
): boolean {
  const restart = profile.evidence
    .filter((record) => record.operation === 'restartPersistence')
    .at(-1);
  return pending.phase === 'restart-verified'
    && pending.profileKey === profile.profileKey
    && profile.restartPersistence === 'passed'
    && restart?.status === 'passed'
    && restart.reasonCode === 'RAW_HASH_AND_VERSION_PERSISTED'
    && restart.primitive === 'RAW_REREAD';
}

export function isVerifiedNonPermanentCleanup(
  deleteStatus: number,
  rereadStatus: number
): boolean {
  return deleteStatus >= 200 && deleteStatus < 300 && rereadStatus === 404;
}

async function restoreClaim(
  profileDirectory: string,
  target: string,
  claimed: string
): Promise<void> {
  try {
    if (!(await exists(claimed))) return;
    if (!(await exists(target))) {
      await rename(claimed, target);
    } else {
      await rename(claimed, join(
        profileDirectory,
        `restart-pending.recovery.${randomUUID()}.json`
      ));
    }
    await syncDirectory(profileDirectory);
  } catch {
    // The claim remains recoverable at its existing 0600 path if restoration cannot finish.
  }
}

async function claimCurrent(
  profileDirectory: string,
  expected: RestartPending
): Promise<{ readonly target: string; readonly claimed: string }> {
  const target = join(profileDirectory, 'restart-pending.json');
  const claimed = join(profileDirectory, `restart-pending.claimed.${randomUUID()}.tmp`);
  try {
    await rename(target, claimed);
    await syncDirectory(profileDirectory);
    const actual = restartPendingSchema.parse(
      JSON.parse(await readFile(claimed, 'utf8')) as unknown
    );
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('mismatch');
    return { target, claimed };
  } catch (error) {
    await restoreClaim(profileDirectory, target, claimed);
    throw error;
  }
}

export async function consumeRestartPending(
  profileDirectory: string,
  expected: RestartPending,
  options: {
    /** @internal deterministic fault injection for recovery tests. */
    readonly testOnlySyncAfterClaimUnlink?: (directory: string) => Promise<void>;
  } = {}
): Promise<void> {
  try {
    const canonicalDirectory = await resolvePendingDirectory(profileDirectory, false);
    await withPendingLock(canonicalDirectory, async () => {
      const { target, claimed } = await claimCurrent(canonicalDirectory, expected);
      const recovery = join(
        canonicalDirectory,
        `restart-pending.recovery.${randomUUID()}.json`
      );
      try {
        await link(claimed, recovery);
        await syncDirectory(canonicalDirectory);
        await unlink(claimed);
        await (options.testOnlySyncAfterClaimUnlink ?? syncDirectory)(canonicalDirectory);
      } catch (error) {
        try {
          const source = await exists(claimed) ? claimed : recovery;
          let restored = false;
          if (!(await exists(target)) && await exists(source)) {
            await rename(source, target);
            restored = true;
          }
          if (restored && await exists(recovery)) await unlink(recovery);
          await syncDirectory(canonicalDirectory);
        } catch {
          // Claimed/recovery bytes remain in the guarded store for manual recovery.
        }
        throw error;
      }
      try {
        await unlink(recovery);
        await syncDirectory(canonicalDirectory);
      } catch {
        // The active restart record is consumed; an ignored recovery link may remain.
      }
    });
  } catch {
    throw new Error('RESTART_PENDING_NOT_CURRENT');
  }
}

export async function promoteRestartPendingToCleanup(
  profileDirectory: string,
  expected: RestartPending,
  cleanup: { readonly status: 'unverified' | 'failed'; readonly reasonCode: string },
  options: {
    /** @internal deterministic fault injection for post-commit cleanup tests. */
    readonly testOnlyRemoveClaimAfterCleanupCommit?: (claimed: string) => Promise<void>;
  } = {}
): Promise<void> {
  let cleanupRecord: CleanupPending;
  try {
    cleanupRecord = buildCleanupPending(expected, cleanup);
  } catch {
    throw new Error('RESTART_PENDING_NOT_CURRENT');
  }
  try {
    const canonicalDirectory = await resolvePendingDirectory(profileDirectory, false);
    await withPendingLock(canonicalDirectory, async () => {
      const { target, claimed } = await claimCurrent(canonicalDirectory, expected);
      try {
        await atomicWriteExclusive(
          canonicalDirectory,
          cleanupFileName(cleanupRecord.runId),
          JSON.stringify(cleanupRecord),
          true
        );
      } catch (error) {
        await restoreClaim(canonicalDirectory, target, claimed);
        throw error;
      }
      try {
        await (options.testOnlyRemoveClaimAfterCleanupCommit ?? unlink)(claimed);
        await syncDirectory(canonicalDirectory);
      } catch {
        // Cleanup is now the sole active record; the ignored claim preserves a recovery copy.
      }
    });
  } catch {
    throw new Error('RESTART_PENDING_NOT_CURRENT');
  }
}
