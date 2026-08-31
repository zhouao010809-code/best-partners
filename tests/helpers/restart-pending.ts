import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import {
  computeContractProfileRevision,
  type StoredContractProfile
} from '../../src/server/vault/contract-profile-store.js';

const MAX_PENDING_BYTES = 16 * 1024;
const PENDING_READ_TIMEOUT_MS = 1_000;
const RESTART_FILE = 'restart-pending.json';
const RESTART_RECOVERY_FILE = 'restart-pending.recovery.json';

const reasonCodeSchema = z.string().min(1).max(128).regex(/^[A-Z0-9_:-]+$/);
const runIdSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const restartIdentityFields = {
  schemaVersion: z.literal(1),
  runId: runIdSchema,
  root: z.enum(['library', 'knowledge']),
  noteId: z.string().min(1).max(64).regex(/^[a-z0-9._-]+$/i),
  rawSha256: sha256Schema,
  profileKey: sha256Schema,
  manualCleanupReasonCode: z.literal('MANUAL_CLEANUP_REQUIRED')
} as const;
const upstreamVersionSchema = z.string().min(1).max(256).regex(/^[a-z0-9._:-]+$/i);
const preparingRestartPendingSchema = z.object({
  ...restartIdentityFields,
  phase: z.literal('preparing')
}).strict();
const preparedRestartPendingSchema = z.object({
  ...restartIdentityFields,
  phase: z.literal('prepared'),
  upstreamVersion: upstreamVersionSchema
}).strict();
const restartVerifiedPendingSchema = z.object({
  ...restartIdentityFields,
  phase: z.literal('restart-verified'),
  upstreamVersion: upstreamVersionSchema,
  verifiedAt: z.string().datetime({ offset: true }),
  intendedProfileRevision: sha256Schema
}).strict();
const restartFailedPendingSchema = z.object({
  ...restartIdentityFields,
  phase: z.literal('restart-failed'),
  upstreamVersion: upstreamVersionSchema,
  failedAt: z.string().datetime({ offset: true }),
  reasonCode: z.literal('RESTART_STATE_MISMATCH'),
  intendedProfileRevision: sha256Schema
}).strict();
const restartPendingSchema = z.discriminatedUnion('phase', [
  preparingRestartPendingSchema,
  preparedRestartPendingSchema,
  restartVerifiedPendingSchema,
  restartFailedPendingSchema
]);
const cleanupFields = {
  cleanupStatus: z.enum(['unverified', 'failed']),
  cleanupReasonCode: reasonCodeSchema,
  cleanupCheckedAt: z.string().datetime({ offset: true })
} as const;
const cleanupPendingSchema = z.discriminatedUnion('phase', [
  preparingRestartPendingSchema.extend(cleanupFields).strict(),
  preparedRestartPendingSchema.extend(cleanupFields).strict(),
  restartVerifiedPendingSchema.extend(cleanupFields).strict(),
  restartFailedPendingSchema.extend(cleanupFields).strict()
]);
const activationSchema = z.object({
  verifiedAt: z.string().datetime({ offset: true }),
  intendedProfileRevision: sha256Schema
}).strict();

export type RestartPending = z.infer<typeof restartPendingSchema>;
export type PreparingRestartPending = z.infer<typeof preparingRestartPendingSchema>;
export type PreparedRestartPending = z.infer<typeof preparedRestartPendingSchema>;
export type RestartVerifiedPending = z.infer<typeof restartVerifiedPendingSchema>;
export type RestartFailedPending = z.infer<typeof restartFailedPendingSchema>;
export type ObservedRestartPending = PreparedRestartPending | RestartVerifiedPending;
export type CleanupPending = z.infer<typeof cleanupPendingSchema>;

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as NodeJS.ErrnoException).code === code;
}

async function settleBeforeDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('pending read timeout')), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
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
    await syncDirectory(parent);
  }
  if (await realpath(candidate) !== candidate) throw new Error('unsafe');
  if (create) await chmod(candidate, 0o700);
  return candidate;
}

async function readRegularFileNoFollow(path: string): Promise<string> {
  if (typeof constants.O_NOFOLLOW !== 'number' || constants.O_NOFOLLOW === 0) {
    throw new Error('nofollow unavailable');
  }
  const before = await settleBeforeDeadline(lstat(path), PENDING_READ_TIMEOUT_MS);
  if (
    before.isSymbolicLink()
    || !before.isFile()
    || before.nlink !== 1
    || (before.mode & 0o777) !== 0o600
    || before.size > MAX_PENDING_BYTES
  ) {
    throw new Error('unsafe pending file');
  }
  const handle = await settleBeforeDeadline(
    open(path, constants.O_RDONLY | constants.O_NOFOLLOW),
    PENDING_READ_TIMEOUT_MS
  );
  try {
    const opened = await settleBeforeDeadline(handle.stat(), PENDING_READ_TIMEOUT_MS);
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || (opened.mode & 0o777) !== 0o600
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size > MAX_PENDING_BYTES
    ) {
      throw new Error('unsafe pending file');
    }
    const buffer = Buffer.alloc(MAX_PENDING_BYTES + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await settleBeforeDeadline(
        handle.read(buffer, offset, buffer.byteLength - offset, offset),
        PENDING_READ_TIMEOUT_MS
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_PENDING_BYTES) throw new Error('pending file too large');
    return buffer.subarray(0, offset).toString('utf8');
  } finally {
    await handle.close().catch(() => {});
  }
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readRegularFileNoFollow(path);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return undefined;
    throw error;
  }
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
  await lock.close().catch(() => {});
  try {
    await unlink(lockPath);
    await syncDirectory(directory);
  } catch {
    // A leftover lock blocks later transitions; it cannot undo this operation.
  }
  if (!completed) throw operationFailure;
  return value as T;
}

async function atomicWriteExclusive(
  directory: string,
  fileName: string,
  serialized: string,
  allowExistingExact: boolean,
  syncAfterCommit: (directory: string) => Promise<void> = syncDirectory
): Promise<void> {
  const target = join(directory, fileName);
  const temporary = join(directory, `${fileName}.${randomUUID()}.tmp`);
  const stored = `${serialized}\n`;
  const existing = await readIfPresent(target);
  if (existing !== undefined) {
    if (!allowExistingExact || existing !== stored) throw new Error('target exists');
    await syncAfterCommit(directory);
    return;
  }

  let handle;
  let linked = false;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(stored, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, target);
      linked = true;
    } catch (error) {
      if (
        !hasCode(error, 'EEXIST')
        || !allowExistingExact
        || await readRegularFileNoFollow(target) !== stored
      ) {
        throw error;
      }
    }
    await unlink(temporary);
    if (linked && await readRegularFileNoFollow(target) !== stored) {
      throw new Error('exclusive write mismatch');
    }
    await syncAfterCommit(directory);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function replaceExactRecord(
  directory: string,
  expected: RestartPending,
  desired: RestartPending,
  syncAfterCommit: (directory: string) => Promise<void> = syncDirectory
): Promise<RestartPending> {
  const target = join(directory, RESTART_FILE);
  const expectedBytes = `${JSON.stringify(expected)}\n`;
  const desiredBytes = `${JSON.stringify(desired)}\n`;
  const currentBytes = await readRegularFileNoFollow(target);
  if (currentBytes === desiredBytes) {
    await syncAfterCommit(directory);
    return desired;
  }
  if (currentBytes !== expectedBytes) throw new Error('pending mismatch');

  const temporary = join(directory, `restart-pending.transition.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(desiredBytes, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
    await syncAfterCommit(directory);
    if (await readRegularFileNoFollow(target) !== desiredBytes) {
      throw new Error('pending transition mismatch');
    }
    return desired;
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function writeRestartPending(
  profileDirectory: string,
  value: RestartPending,
  options: {
    /** @internal deterministic durability-failure injection. */
    readonly testOnlySyncAfterCommit?: (directory: string) => Promise<void>;
  } = {}
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
      await atomicWriteExclusive(
        canonicalDirectory,
        RESTART_FILE,
        JSON.stringify(parsed),
        true,
        options.testOnlySyncAfterCommit
      );
    });
  } catch {
    throw new Error('RESTART_PENDING_WRITE_FAILED');
  }
}

async function loadRestartFromDirectory(directory: string): Promise<RestartPending | undefined> {
  try {
    const targetBytes = await readIfPresent(join(directory, RESTART_FILE));
    if (targetBytes !== undefined) {
      return restartPendingSchema.parse(JSON.parse(targetBytes) as unknown);
    }
    const recoveryBytes = await readIfPresent(join(directory, RESTART_RECOVERY_FILE));
    if (recoveryBytes === undefined) return undefined;
    return restartPendingSchema.parse(JSON.parse(recoveryBytes) as unknown);
  } catch {
    return undefined;
  }
}

export async function loadRestartPending(
  profileDirectory: string
): Promise<RestartPending | undefined> {
  try {
    return await loadRestartFromDirectory(
      await resolvePendingDirectory(profileDirectory, false)
    );
  } catch {
    return undefined;
  }
}

export async function markRestartPendingPrepared(
  profileDirectory: string,
  expected: PreparingRestartPending,
  observation: { readonly rawSha256: string; readonly upstreamVersion: string },
  options: {
    /** @internal deterministic durability-failure injection. */
    readonly testOnlySyncAfterCommit?: (directory: string) => Promise<void>;
  } = {}
): Promise<PreparedRestartPending> {
  let parsedExpected: PreparingRestartPending;
  let desired: PreparedRestartPending;
  try {
    parsedExpected = preparingRestartPendingSchema.parse(expected);
    if (observation.rawSha256 !== parsedExpected.rawSha256) throw new Error('hash mismatch');
    desired = preparedRestartPendingSchema.parse({
      ...parsedExpected,
      phase: 'prepared',
      upstreamVersion: observation.upstreamVersion
    });
  } catch {
    throw new Error('RESTART_PENDING_NOT_CURRENT');
  }
  try {
    const canonicalDirectory = await resolvePendingDirectory(profileDirectory, false);
    return preparedRestartPendingSchema.parse(await withPendingLock(
      canonicalDirectory,
      () => replaceExactRecord(
        canonicalDirectory,
        parsedExpected,
        desired,
        options.testOnlySyncAfterCommit
      )
    ));
  } catch {
    throw new Error('RESTART_PENDING_NOT_CURRENT');
  }
}

export async function markRestartPendingVerified(
  profileDirectory: string,
  expected: ObservedRestartPending,
  activation: { readonly verifiedAt: string; readonly intendedProfileRevision: string },
  options: {
    /** @internal deterministic durability-failure injection. */
    readonly testOnlySyncAfterCommit?: (directory: string) => Promise<void>;
  } = {}
): Promise<RestartVerifiedPending> {
  let parsedExpected: ObservedRestartPending;
  let desired: RestartVerifiedPending;
  try {
    parsedExpected = expected.phase === 'prepared'
      ? preparedRestartPendingSchema.parse(expected)
      : restartVerifiedPendingSchema.parse(expected);
    const parsedActivation = activationSchema.parse(activation);
    if (
      parsedExpected.phase === 'restart-verified'
      && (
        parsedExpected.verifiedAt !== parsedActivation.verifiedAt
        || parsedExpected.intendedProfileRevision !== parsedActivation.intendedProfileRevision
      )
    ) {
      throw new Error('verified activation mismatch');
    }
    desired = restartVerifiedPendingSchema.parse({
      ...parsedExpected,
      phase: 'restart-verified',
      ...parsedActivation
    });
  } catch {
    throw new Error('RESTART_PENDING_NOT_CURRENT');
  }
  try {
    const canonicalDirectory = await resolvePendingDirectory(profileDirectory, false);
    return restartVerifiedPendingSchema.parse(await withPendingLock(
      canonicalDirectory,
      () => replaceExactRecord(
        canonicalDirectory,
        parsedExpected,
        desired,
        options.testOnlySyncAfterCommit
      )
    ));
  } catch {
    throw new Error('RESTART_PENDING_NOT_CURRENT');
  }
}

export async function markRestartPendingFailed(
  profileDirectory: string,
  expected: PreparedRestartPending,
  failure: {
    readonly failedAt: string;
    readonly reasonCode: 'RESTART_STATE_MISMATCH';
    readonly intendedProfileRevision: string;
  },
  options: {
    /** @internal deterministic durability-failure injection. */
    readonly testOnlySyncAfterCommit?: (directory: string) => Promise<void>;
  } = {}
): Promise<RestartFailedPending> {
  let parsedExpected: PreparedRestartPending;
  let desired: RestartFailedPending;
  try {
    parsedExpected = preparedRestartPendingSchema.parse(expected);
    desired = restartFailedPendingSchema.parse({
      ...parsedExpected,
      phase: 'restart-failed',
      ...failure
    });
  } catch {
    throw new Error('RESTART_PENDING_NOT_CURRENT');
  }
  try {
    const canonicalDirectory = await resolvePendingDirectory(profileDirectory, false);
    return restartFailedPendingSchema.parse(await withPendingLock(
      canonicalDirectory,
      () => replaceExactRecord(
        canonicalDirectory,
        parsedExpected,
        desired,
        options.testOnlySyncAfterCommit
      )
    ));
  } catch {
    throw new Error('RESTART_PENDING_NOT_CURRENT');
  }
}

function cleanupFileName(runId: string): string {
  return `cleanup-pending.${runId}.json`;
}

function cleanupRecoveryFileName(runId: string): string {
  return `cleanup-pending.${runId}.recovery.json`;
}

export async function loadCleanupPending(
  profileDirectory: string,
  runId: string
): Promise<CleanupPending | undefined> {
  try {
    const parsedRunId = runIdSchema.parse(runId);
    const canonicalDirectory = await resolvePendingDirectory(profileDirectory, false);
    const value = await readIfPresent(join(canonicalDirectory, cleanupFileName(parsedRunId)))
      ?? await readIfPresent(join(canonicalDirectory, cleanupRecoveryFileName(parsedRunId)));
    if (value === undefined) return undefined;
    const parsed = cleanupPendingSchema.parse(JSON.parse(value) as unknown);
    return parsed.runId === parsedRunId ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function buildCleanupPending(
  pending: RestartPending,
  cleanup: {
    readonly status: 'unverified' | 'failed';
    readonly reasonCode: string;
    readonly checkedAt: string;
  }
): CleanupPending {
  return cleanupPendingSchema.parse({
    ...pending,
    cleanupStatus: cleanup.status,
    cleanupReasonCode: cleanup.reasonCode,
    cleanupCheckedAt: cleanup.checkedAt
  });
}

export async function writeCleanupPending(
  profileDirectory: string,
  pending: RestartPending,
  cleanup: {
    readonly status: 'unverified' | 'failed';
    readonly reasonCode: string;
    readonly checkedAt: string;
  }
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

async function restoreNamedRecoveryAsTarget(
  directory: string,
  targetName: string,
  recoveryName: string
): Promise<void> {
  const target = join(directory, targetName);
  const recovery = join(directory, recoveryName);
  const targetBytes = await readIfPresent(target);
  const recoveryBytes = await readIfPresent(recovery);
  if (targetBytes !== undefined) {
    if (recoveryBytes !== undefined) {
      if (recoveryBytes !== targetBytes) throw new Error('recovery mismatch');
      await unlink(recovery);
      await syncDirectory(directory);
    }
    return;
  }
  if (recoveryBytes === undefined) throw new Error('pending missing');
  await rename(recovery, target);
  await syncDirectory(directory);
}

export async function consumeCleanupPending(
  profileDirectory: string,
  expected: CleanupPending,
  options: {
    /** @internal deterministic rollback fault injection. */
    readonly testOnlySyncAfterTargetUnlink?: (directory: string) => Promise<void>;
  } = {}
): Promise<void> {
  let parsedExpected: CleanupPending;
  try {
    parsedExpected = cleanupPendingSchema.parse(expected);
  } catch {
    throw new Error('RESTART_PENDING_NOT_CURRENT');
  }
  try {
    const canonicalDirectory = await resolvePendingDirectory(profileDirectory, false);
    await withPendingLock(canonicalDirectory, async () => {
      const targetName = cleanupFileName(parsedExpected.runId);
      const recoveryName = cleanupRecoveryFileName(parsedExpected.runId);
      await restoreNamedRecoveryAsTarget(canonicalDirectory, targetName, recoveryName);
      const target = join(canonicalDirectory, targetName);
      const recovery = join(canonicalDirectory, recoveryName);
      const expectedBytes = `${JSON.stringify(parsedExpected)}\n`;
      if (await readRegularFileNoFollow(target) !== expectedBytes) {
        throw new Error('pending mismatch');
      }
      await atomicWriteExclusive(
        canonicalDirectory,
        recoveryName,
        JSON.stringify(parsedExpected),
        true
      );
      try {
        await unlink(target);
        await (options.testOnlySyncAfterTargetUnlink ?? syncDirectory)(canonicalDirectory);
      } catch (error) {
        try {
          const targetBytes = await readIfPresent(target);
          if (targetBytes === undefined) await rename(recovery, target);
          else if (targetBytes === expectedBytes) await unlink(recovery);
          else throw new Error('target changed');
          await syncDirectory(canonicalDirectory);
        } catch {
          // The loader recognizes the fixed recovery locator.
        }
        throw error;
      }
      await unlink(recovery).catch(() => {});
      await syncDirectory(canonicalDirectory).catch(() => {});
    });
  } catch {
    throw new Error('RESTART_PENDING_NOT_CURRENT');
  }
}

function normalizedRestartIdentity(pending: RestartPending | CleanupPending): object {
  return {
    schemaVersion: pending.schemaVersion,
    phase: pending.phase,
    runId: pending.runId,
    root: pending.root,
    noteId: pending.noteId,
    rawSha256: pending.rawSha256,
    profileKey: pending.profileKey,
    manualCleanupReasonCode: pending.manualCleanupReasonCode,
    upstreamVersion: 'upstreamVersion' in pending ? pending.upstreamVersion : undefined,
    verifiedAt: 'verifiedAt' in pending ? pending.verifiedAt : undefined,
    intendedProfileRevision: 'intendedProfileRevision' in pending
      ? pending.intendedProfileRevision : undefined,
    failedAt: 'failedAt' in pending ? pending.failedAt : undefined,
    reasonCode: 'reasonCode' in pending ? pending.reasonCode : undefined
  };
}

export function cleanupPendingMatchesRestart(
  cleanup: CleanupPending,
  pending: RestartPending
): boolean {
  return JSON.stringify(normalizedRestartIdentity(cleanup))
    === JSON.stringify(normalizedRestartIdentity(pending));
}

export function restartPendingMatchesProfile(
  pending: RestartPending,
  profileKey: string
): boolean {
  return pending.profileKey === profileKey;
}

function verifiedRestartEvidenceMatches(
  pending: RestartPending,
  profile: StoredContractProfile
): pending is RestartVerifiedPending {
  if (pending.phase !== 'restart-verified') return false;
  const restart = profile.evidence
    .filter((record) => record.operation === 'restartPersistence')
    .at(-1);
  return pending.profileKey === profile.profileKey
    && profile.restartPersistence === 'passed'
    && profile.restartCheckedAt === pending.verifiedAt
    && restart?.status === 'passed'
    && restart.timestamp === pending.verifiedAt
    && restart.reasonCode === 'RAW_HASH_AND_VERSION_PERSISTED'
    && restart.primitive === 'RAW_REREAD';
}

export function restartPendingAlreadyCompleted(
  pending: RestartPending,
  profile: StoredContractProfile
): boolean {
  const cleanup = profile.evidence
    .filter((record) => record.operation === 'cleanup')
    .at(-1);
  return verifiedRestartEvidenceMatches(pending, profile)
    && cleanup?.status === 'passed'
    && cleanup.reasonCode === restartCleanupPassedReasonCode(pending)
    && cleanup.primitive === 'DELETE_NON_PERMANENT';
}

export function restartCleanupPassedReasonCode(pending: RestartVerifiedPending): string {
  return `CLEANUP_PASSED:${pending.runId}:${pending.intendedProfileRevision.toUpperCase()}`;
}

export function restartPendingHasVerifiedRestart(
  pending: RestartPending,
  profile: StoredContractProfile
): boolean {
  return verifiedRestartEvidenceMatches(pending, profile)
    && computeContractProfileRevision(profile) === pending.intendedProfileRevision;
}

export function isVerifiedNonPermanentCleanup(
  deleteStatus: number,
  rereadStatus: number
): boolean {
  return deleteStatus >= 200 && deleteStatus < 300 && rereadStatus === 404;
}

export function classifyNonPermanentCleanup(input: {
  readonly preReadStatus: number;
  readonly deleteStatus?: number;
  readonly rereadStatus?: number;
}): {
  readonly status: 'passed' | 'failed';
  readonly reasonCode:
    | 'CONDITIONAL_NONPERMANENT_CLEANUP_PASSED'
    | 'CLEANUP_TARGET_ALREADY_MISSING'
    | 'CONDITIONAL_NONPERMANENT_CLEANUP_FAILED';
} {
  if (input.preReadStatus === 404) {
    return { status: 'failed', reasonCode: 'CLEANUP_TARGET_ALREADY_MISSING' };
  }
  if (
    input.preReadStatus === 200
    && input.deleteStatus !== undefined
    && input.rereadStatus !== undefined
    && isVerifiedNonPermanentCleanup(input.deleteStatus, input.rereadStatus)
  ) {
    return {
      status: 'passed',
      reasonCode: 'CONDITIONAL_NONPERMANENT_CLEANUP_PASSED'
    };
  }
  return { status: 'failed', reasonCode: 'CONDITIONAL_NONPERMANENT_CLEANUP_FAILED' };
}

async function restoreRecoveryAsTarget(directory: string): Promise<void> {
  await restoreNamedRecoveryAsTarget(directory, RESTART_FILE, RESTART_RECOVERY_FILE);
}

async function consumeRestartPendingLocked(
  directory: string,
  expected: RestartPending,
  syncAfterTargetUnlink: (directory: string) => Promise<void>
): Promise<void> {
  await restoreRecoveryAsTarget(directory);
  const target = join(directory, RESTART_FILE);
  const recovery = join(directory, RESTART_RECOVERY_FILE);
  const expectedBytes = `${JSON.stringify(expected)}\n`;
  if (await readRegularFileNoFollow(target) !== expectedBytes) {
    throw new Error('pending mismatch');
  }
  await atomicWriteExclusive(
    directory,
    RESTART_RECOVERY_FILE,
    JSON.stringify(expected),
    true
  );
  try {
    await unlink(target);
    await syncAfterTargetUnlink(directory);
  } catch (error) {
    try {
      const targetBytes = await readIfPresent(target);
      if (targetBytes === undefined) {
        await rename(recovery, target);
      } else if (targetBytes === expectedBytes) {
        await unlink(recovery);
      } else {
        throw new Error('target changed');
      }
      await syncDirectory(directory);
    } catch {
      // The safe loader also recognizes the fixed recovery locator.
    }
    throw error;
  }
  try {
    await unlink(recovery);
    // Removing the recovery locator is the consumption commit point. A failed
    // post-unlink fsync can only resurrect an already-completed locator.
    await syncDirectory(directory);
  } catch {
    // Cleanup-passed profile evidence is authoritative; a stale recovery record
    // is safe to rediscover and consume again.
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
  let parsedExpected: RestartPending;
  try {
    parsedExpected = restartPendingSchema.parse(expected);
  } catch {
    throw new Error('RESTART_PENDING_NOT_CURRENT');
  }
  try {
    const canonicalDirectory = await resolvePendingDirectory(profileDirectory, false);
    await withPendingLock(canonicalDirectory, () => consumeRestartPendingLocked(
      canonicalDirectory,
      parsedExpected,
      options.testOnlySyncAfterClaimUnlink ?? syncDirectory
    ));
  } catch {
    throw new Error('RESTART_PENDING_NOT_CURRENT');
  }
}

export async function promoteRestartPendingToCleanup(
  profileDirectory: string,
  expected: RestartPending,
  cleanup: {
    readonly status: 'unverified' | 'failed';
    readonly reasonCode: string;
    readonly checkedAt: string;
  },
  options: {
    /** @internal deterministic fault injection for post-commit cleanup tests. */
    readonly testOnlyRemoveClaimAfterCleanupCommit?: (target: string) => Promise<void>;
  } = {}
): Promise<void> {
  let parsedExpected: RestartPending;
  let cleanupRecord: CleanupPending;
  try {
    parsedExpected = restartPendingSchema.parse(expected);
    cleanupRecord = buildCleanupPending(parsedExpected, cleanup);
  } catch {
    throw new Error('RESTART_PENDING_NOT_CURRENT');
  }
  try {
    const canonicalDirectory = await resolvePendingDirectory(profileDirectory, false);
    await withPendingLock(canonicalDirectory, async () => {
      await restoreRecoveryAsTarget(canonicalDirectory);
      if (
        await readRegularFileNoFollow(join(canonicalDirectory, RESTART_FILE))
        !== `${JSON.stringify(parsedExpected)}\n`
      ) {
        throw new Error('pending mismatch');
      }
      await atomicWriteExclusive(
        canonicalDirectory,
        cleanupFileName(cleanupRecord.runId),
        JSON.stringify(cleanupRecord),
        true
      );
      if (options.testOnlyRemoveClaimAfterCleanupCommit !== undefined) {
        await options.testOnlyRemoveClaimAfterCleanupCommit(
          join(canonicalDirectory, RESTART_FILE)
        );
      }
      await consumeRestartPendingLocked(canonicalDirectory, parsedExpected, syncDirectory);
    });
  } catch {
    throw new Error('RESTART_PENDING_NOT_CURRENT');
  }
}
