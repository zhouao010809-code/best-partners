import type {
  CleanupPending,
  ObservedRestartPending,
  PreparedRestartPending,
  RestartFailedPending,
  RestartPending,
  RestartVerifiedPending
} from './restart-pending.js';
import {
  buildContractProfile,
  computeContractProfileRevision,
  type StoredContractProfile
} from '../../src/server/vault/contract-profile-store.js';

type CleanupFailureReasonCode =
  | 'CLEANUP_TARGET_ALREADY_MISSING'
  | 'CLEANUP_IDENTITY_MISMATCH'
  | 'CONDITIONAL_NONPERMANENT_CLEANUP_FAILED';

function isCleanupFailureReasonCode(value: string): value is CleanupFailureReasonCode {
  return value === 'CLEANUP_TARGET_ALREADY_MISSING'
    || value === 'CLEANUP_IDENTITY_MISMATCH'
    || value === 'CONDITIONAL_NONPERMANENT_CLEANUP_FAILED';
}

function verifiedSafeDelete(profile: StoredContractProfile): boolean {
  const latest = profile.evidence.filter((record) => record.operation === 'safeDelete').at(-1);
  return profile.safeDelete
    && latest?.status === 'passed'
    && latest.reasonCode === 'CONDITIONAL_NONPERMANENT_DELETE_VERIFIED'
    && latest.primitive === 'DELETE_NON_PERMANENT';
}

function restartCleanupArmingEvidence(
  profile: StoredContractProfile,
  verifiedAt: string
): StoredContractProfile['evidence'][number] {
  const armed = verifiedSafeDelete(profile);
  return {
    operation: 'cleanup',
    status: 'unverified',
    timestamp: verifiedAt,
    reasonCode: armed ? 'CONDITIONAL_NONPERMANENT_CLEANUP_ARMED' : 'MANUAL_CLEANUP_REQUIRED',
    ...(armed ? { primitive: 'DELETE_NON_PERMANENT' as const } : {})
  };
}

export function buildRestartVerifiedProfile(
  profile: StoredContractProfile,
  verifiedAt: string
): StoredContractProfile {
  const {
    schemaVersion: _schemaVersion,
    profileKey: _profileKey,
    formalWriteGate: _formalWriteGate,
    restartCheckedAt: _restartCheckedAt,
    ...profileInput
  } = profile;
  return buildContractProfile({
    ...profileInput,
    restartPersistence: 'passed',
    restartCheckedAt: verifiedAt,
    evidence: [
      ...profile.evidence.filter((record) => (
        record.operation !== 'restartPersistence' && record.operation !== 'cleanup'
      )),
      {
        operation: 'restartPersistence',
        status: 'passed',
        httpStatuses: [200],
        timestamp: verifiedAt,
        reasonCode: 'RAW_HASH_AND_VERSION_PERSISTED',
        primitive: 'RAW_REREAD'
      },
      restartCleanupArmingEvidence(profile, verifiedAt)
    ]
  });
}

export function restartFailureEvidenceReasonCode(pending: Pick<RestartPending, 'runId'>): string {
  return `RESTART_FAILED:${pending.runId}:RESTART_STATE_MISMATCH`;
}

export function buildRestartFailedProfile(
  profile: StoredContractProfile,
  pending: PreparedRestartPending,
  failedAt: string
): StoredContractProfile {
  const {
    schemaVersion: _schemaVersion,
    profileKey: _profileKey,
    formalWriteGate: _formalWriteGate,
    restartCheckedAt: _restartCheckedAt,
    ...profileInput
  } = profile;
  return buildContractProfile({
    ...profileInput,
    restartPersistence: 'failed',
    restartCheckedAt: failedAt,
    evidence: [
      ...profile.evidence.filter((record) => (
        record.operation !== 'restartPersistence' && record.operation !== 'cleanup'
      )),
      {
        operation: 'restartPersistence',
        status: 'failed',
        timestamp: failedAt,
        reasonCode: restartFailureEvidenceReasonCode(pending),
        primitive: 'RAW_REREAD'
      },
      {
        operation: 'cleanup',
        status: 'unverified',
        timestamp: failedAt,
        reasonCode: 'MANUAL_CLEANUP_REQUIRED'
      }
    ]
  });
}

export function restartFailedProfileMatches(
  pending: RestartFailedPending,
  profile: StoredContractProfile
): boolean {
  const restart = profile.evidence
    .filter((record) => record.operation === 'restartPersistence')
    .at(-1);
  const cleanup = profile.evidence.filter((record) => record.operation === 'cleanup').at(-1);
  return profile.profileKey === pending.profileKey
    && profile.restartPersistence === 'failed'
    && profile.restartCheckedAt === pending.failedAt
    && computeContractProfileRevision(profile) === pending.intendedProfileRevision
    && restart?.status === 'failed'
    && restart.timestamp === pending.failedAt
    && restart.reasonCode === restartFailureEvidenceReasonCode(pending)
    && restart.primitive === 'RAW_REREAD'
    && cleanup?.status === 'unverified'
    && cleanup.timestamp === pending.failedAt
    && cleanup.reasonCode === 'MANUAL_CLEANUP_REQUIRED';
}

export function cleanupFailureEvidenceReasonCode(
  pending: RestartVerifiedPending,
  reasonCode: CleanupFailureReasonCode
): string {
  return `CLEANUP_FAILED:${pending.runId}:${reasonCode}`;
}

function verifiedRestartEvidenceMatches(
  pending: RestartVerifiedPending,
  profile: StoredContractProfile
): boolean {
  const restart = profile.evidence
    .filter((record) => record.operation === 'restartPersistence')
    .at(-1);
  return profile.profileKey === pending.profileKey
    && profile.restartPersistence === 'passed'
    && profile.restartCheckedAt === pending.verifiedAt
    && restart?.status === 'passed'
    && restart.timestamp === pending.verifiedAt
    && restart.reasonCode === 'RAW_HASH_AND_VERSION_PERSISTED'
    && restart.primitive === 'RAW_REREAD';
}

export function restartPendingCanResumeCleanup(
  pending: RestartVerifiedPending,
  profile: StoredContractProfile,
  cleanupLocator?: CleanupPending
): boolean {
  if (!verifiedRestartEvidenceMatches(pending, profile)) return false;
  const latestCleanup = profile.evidence.filter((record) => record.operation === 'cleanup').at(-1);
  const armed = restartCleanupArmingEvidence(profile, pending.verifiedAt);
  let normalized = profile;
  if (
    latestCleanup?.status === 'unverified'
    && JSON.stringify(latestCleanup) === JSON.stringify(armed)
  ) {
    normalized = profile;
  } else if (
    latestCleanup?.status === 'failed'
    && cleanupLocator?.cleanupStatus === 'failed'
    && cleanupLocator.phase === pending.phase
    && cleanupLocator.runId === pending.runId
    && cleanupLocator.root === pending.root
    && cleanupLocator.noteId === pending.noteId
    && cleanupLocator.rawSha256 === pending.rawSha256
    && cleanupLocator.profileKey === pending.profileKey
    && cleanupLocator.upstreamVersion === pending.upstreamVersion
    && cleanupLocator.verifiedAt === pending.verifiedAt
    && cleanupLocator.intendedProfileRevision === pending.intendedProfileRevision
    && isCleanupFailureReasonCode(cleanupLocator.cleanupReasonCode)
    && latestCleanup.timestamp === cleanupLocator.cleanupCheckedAt
    && latestCleanup.reasonCode === cleanupFailureEvidenceReasonCode(
      pending,
      cleanupLocator.cleanupReasonCode
    )
  ) {
    const {
      schemaVersion: _schemaVersion,
      profileKey: _profileKey,
      formalWriteGate: _formalWriteGate,
      ...profileInput
    } = profile;
    normalized = buildContractProfile({
      ...profileInput,
      evidence: [
        ...profile.evidence.filter((record) => record.operation !== 'cleanup'),
        armed
      ]
    });
  } else {
    return false;
  }
  return computeContractProfileRevision(normalized) === pending.intendedProfileRevision;
}

export function buildCleanupFailedProfile(
  profile: StoredContractProfile,
  pending: RestartVerifiedPending,
  cleanup: { readonly checkedAt: string; readonly reasonCode: CleanupFailureReasonCode }
): StoredContractProfile {
  const locator: CleanupPending = {
    ...pending,
    cleanupStatus: 'failed',
    cleanupReasonCode: cleanup.reasonCode,
    cleanupCheckedAt: cleanup.checkedAt
  };
  if (!restartPendingCanResumeCleanup(pending, profile, locator)) {
    throw new Error('RESTART_PROFILE_CONFLICT');
  }
  const {
    schemaVersion: _schemaVersion,
    profileKey: _profileKey,
    formalWriteGate: _formalWriteGate,
    ...profileInput
  } = profile;
  return buildContractProfile({
    ...profileInput,
    evidence: [
      ...profile.evidence.filter((record) => record.operation !== 'cleanup'),
      {
        operation: 'cleanup',
        status: 'failed',
        timestamp: cleanup.checkedAt,
        reasonCode: cleanupFailureEvidenceReasonCode(pending, cleanup.reasonCode)
      }
    ]
  });
}

export function planRestartProfileActivation(
  pending: RestartPending,
  currentProfile: StoredContractProfile,
  verifiedAtForPrepared?: string
): {
  readonly verifiedAt: string;
  readonly intendedProfileRevision: string;
  readonly profile: StoredContractProfile;
} {
  if (pending.phase === 'restart-failed') throw new Error('RESTART_TERMINAL_FAILURE_RECORDED');
  if (pending.phase === 'preparing') throw new Error('RESTART_PENDING_NOT_PREPARED');
  const verifiedAt = pending.phase === 'restart-verified'
    ? pending.verifiedAt
    : verifiedAtForPrepared;
  if (verifiedAt === undefined) throw new Error('RESTART_PROFILE_CONFLICT');
  const profile = buildRestartVerifiedProfile(currentProfile, verifiedAt);
  const intendedProfileRevision = computeContractProfileRevision(profile);
  const latestRestart = currentProfile.evidence
    .filter((record) => record.operation === 'restartPersistence')
    .at(-1);
  if (
    currentProfile.formalWriteGate !== 'blocked'
    || currentProfile.restartPersistence !== 'unverified'
    || latestRestart?.status !== 'unverified'
  ) {
    throw new Error('RESTART_PROFILE_CONFLICT');
  }
  return { verifiedAt, intendedProfileRevision, profile };
}

export async function recordRestartFailure<T>(input: {
  readonly pending: PreparedRestartPending;
  readonly markFailed: (pending: PreparedRestartPending) => Promise<RestartFailedPending>;
  readonly persistProfile: (pending: RestartFailedPending) => Promise<T>;
}): Promise<{ readonly pending: RestartFailedPending; readonly profile: T }> {
  const pending = await input.markFailed(input.pending);
  const profile = await input.persistProfile(pending);
  return { pending, profile };
}

export async function persistCleanupFailure<T>(input: {
  readonly pending: RestartVerifiedPending;
  readonly profile: StoredContractProfile;
  readonly checkedAt: string;
  readonly reasonCode: CleanupFailureReasonCode;
  readonly persistLocator: (cleanup: {
    readonly status: 'failed';
    readonly reasonCode: CleanupFailureReasonCode;
    readonly checkedAt: string;
  }) => Promise<void>;
  readonly persistProfile: (profile: StoredContractProfile) => Promise<T>;
}): Promise<T> {
  await input.persistLocator({
    status: 'failed',
    reasonCode: input.reasonCode,
    checkedAt: input.checkedAt
  });
  return input.persistProfile(buildCleanupFailedProfile(input.profile, input.pending, {
    checkedAt: input.checkedAt,
    reasonCode: input.reasonCode
  }));
}

export async function activateVerifiedRestart<T>(input: {
  readonly pending: ObservedRestartPending;
  readonly markVerified: (
    pending: ObservedRestartPending
  ) => Promise<RestartVerifiedPending>;
  readonly activateProfile: (pending: RestartVerifiedPending) => Promise<T>;
}): Promise<{ readonly pending: RestartVerifiedPending; readonly profile: T }> {
  const pending = await input.markVerified(input.pending);
  const profile = await input.activateProfile(pending);
  return { pending, profile };
}
