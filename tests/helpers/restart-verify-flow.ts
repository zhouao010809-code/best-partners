import type {
  ObservedRestartPending,
  RestartVerifiedPending
} from './restart-pending.js';
import {
  buildContractProfile,
  computeContractProfileRevision,
  type StoredContractProfile
} from '../../src/server/vault/contract-profile-store.js';

export function buildRestartVerifiedProfile(
  profile: StoredContractProfile,
  verifiedAt: string
): StoredContractProfile {
  const latestSafeDelete = profile.evidence
    .filter((record) => record.operation === 'safeDelete')
    .at(-1);
  const verifiedSafeDelete = profile.safeDelete
    && latestSafeDelete?.status === 'passed'
    && latestSafeDelete.reasonCode === 'CONDITIONAL_NONPERMANENT_DELETE_VERIFIED'
    && latestSafeDelete.primitive === 'DELETE_NON_PERMANENT';
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
      {
        operation: 'cleanup',
        status: 'unverified',
        timestamp: verifiedAt,
        reasonCode: verifiedSafeDelete
          ? 'CONDITIONAL_NONPERMANENT_CLEANUP_ARMED'
          : 'MANUAL_CLEANUP_REQUIRED',
        ...(verifiedSafeDelete ? { primitive: 'DELETE_NON_PERMANENT' as const } : {})
      }
    ]
  });
}

export function planRestartProfileActivation(
  pending: ObservedRestartPending,
  currentProfile: StoredContractProfile,
  verifiedAtForPrepared?: string
): {
  readonly verifiedAt: string;
  readonly intendedProfileRevision: string;
  readonly profile: StoredContractProfile;
} {
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
    pending.phase === 'restart-verified'
    && pending.intendedProfileRevision !== intendedProfileRevision
    && (
      currentProfile.formalWriteGate !== 'blocked'
      || currentProfile.restartPersistence !== 'unverified'
      || (latestRestart !== undefined && latestRestart.status !== 'unverified')
    )
  ) {
    throw new Error('RESTART_PROFILE_CONFLICT');
  }
  return { verifiedAt, intendedProfileRevision, profile };
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
