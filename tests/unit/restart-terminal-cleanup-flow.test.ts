import { describe, expect, it, vi } from 'vitest';
import {
  buildContractProfile,
  computeContractProfileRevision,
  renderContractProfileMarkdown,
  type StoredContractProfile
} from '../../src/server/vault/contract-profile-store.js';
import type {
  PreparedRestartPending,
  RestartFailedPending,
  RestartVerifiedPending
} from '../helpers/restart-pending.js';
import {
  buildCleanupFailedProfile,
  buildRestartFailedProfile,
  buildRestartVerifiedProfile,
  cleanupFailureEvidenceReasonCode,
  persistCleanupFailure,
  planRestartProfileActivation,
  recordRestartFailure,
  restartFailedProfileMatches,
  restartPendingCanResumeCleanup
} from '../helpers/restart-verify-flow.js';

const prepared: PreparedRestartPending = {
  schemaVersion: 1,
  phase: 'prepared',
  runId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  root: 'library',
  noteId: 'restart.md',
  rawSha256: 'a'.repeat(64),
  upstreamVersion: 'version-token:1',
  profileKey: 'b'.repeat(64),
  manualCleanupReasonCode: 'MANUAL_CLEANUP_REQUIRED'
};
const checkedAt = '2026-08-31T02:00:00.000Z';
const failedAt = '2026-08-31T03:00:00.000Z';
const cleanupCheckedAt = '2026-08-31T03:30:00.000Z';

function blockedProfile(): StoredContractProfile {
  return buildContractProfile({
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
    restartPersistence: 'unverified',
    evidence: [{
      operation: 'restartPersistence',
      status: 'unverified',
      timestamp: checkedAt,
      reasonCode: 'RESTART_PERSISTENCE_PENDING',
      primitive: 'RAW_REREAD'
    }]
  });
}

function verifiedFixture(): {
  readonly pending: RestartVerifiedPending;
  readonly profile: StoredContractProfile;
} {
  const profile = buildRestartVerifiedProfile(blockedProfile(), failedAt);
  return {
    profile,
    pending: {
      ...prepared,
      profileKey: profile.profileKey,
      phase: 'restart-verified',
      verifiedAt: failedAt,
      intendedProfileRevision: computeContractProfileRevision(profile)
    }
  };
}

describe('terminal restart failure and cleanup failure flow', () => {
  it('commits the terminal mismatch before trying to persist its failed profile', async () => {
    const base = blockedProfile();
    const currentPending = { ...prepared, profileKey: base.profileKey };
    const failedProfile = buildRestartFailedProfile(base, currentPending, failedAt);
    const failedPending: RestartFailedPending = {
      ...currentPending,
      phase: 'restart-failed',
      failedAt,
      reasonCode: 'RESTART_STATE_MISMATCH',
      intendedProfileRevision: computeContractProfileRevision(failedProfile)
    };
    const order: string[] = [];
    const persistProfile = vi.fn(async () => {
      order.push('profile-failed');
      return failedProfile;
    });

    await expect(recordRestartFailure({
      pending: currentPending,
      markFailed: async () => {
        order.push('pending-terminal');
        return failedPending;
      },
      persistProfile
    })).resolves.toMatchObject({ pending: failedPending, profile: failedProfile });
    expect(order).toEqual(['pending-terminal', 'profile-failed']);
    expect(restartFailedProfileMatches(failedPending, failedProfile)).toBe(true);
  });

  it('never writes a failed profile before terminal commit and retains terminal on profile conflict', async () => {
    const base = blockedProfile();
    const currentPending = { ...prepared, profileKey: base.profileKey };
    const failedProfile = buildRestartFailedProfile(base, currentPending, failedAt);
    const failedPending: RestartFailedPending = {
      ...currentPending,
      phase: 'restart-failed',
      failedAt,
      reasonCode: 'RESTART_STATE_MISMATCH',
      intendedProfileRevision: computeContractProfileRevision(failedProfile)
    };
    let durablePending: PreparedRestartPending | RestartFailedPending = currentPending;
    const persistProfile = vi.fn(async () => {
      throw new Error('CONTRACT_PROFILE_CONFLICT');
    });

    await expect(recordRestartFailure({
      pending: currentPending,
      markFailed: async () => {
        durablePending = failedPending;
        return failedPending;
      },
      persistProfile
    })).rejects.toThrowError('CONTRACT_PROFILE_CONFLICT');
    expect(durablePending.phase).toBe('restart-failed');

    persistProfile.mockClear();
    await expect(recordRestartFailure({
      pending: currentPending,
      markFailed: async () => { throw new Error('RESTART_PENDING_NOT_CURRENT'); },
      persistProfile
    })).rejects.toThrowError('RESTART_PENDING_NOT_CURRENT');
    expect(persistProfile).not.toHaveBeenCalled();
  });

  it('keeps a failed terminal run failed after bytes are restored or probes reset the profile', () => {
    const failedProfile = buildRestartFailedProfile(blockedProfile(), prepared, failedAt);
    const terminal: RestartFailedPending = {
      ...prepared,
      phase: 'restart-failed',
      failedAt,
      reasonCode: 'RESTART_STATE_MISMATCH',
      intendedProfileRevision: computeContractProfileRevision(failedProfile)
    };

    expect(() => planRestartProfileActivation(terminal, blockedProfile()))
      .toThrowError('RESTART_TERMINAL_FAILURE_RECORDED');
    expect(restartFailedProfileMatches(terminal, blockedProfile())).toBe(false);
  });

  it('rejects activation when a failed current profile happens to rebuild the intended revision', () => {
    const terminalProfile = buildRestartFailedProfile(blockedProfile(), prepared, failedAt);
    const wouldPass = buildRestartVerifiedProfile(terminalProfile, failedAt);
    const pending: RestartVerifiedPending = {
      ...prepared,
      phase: 'restart-verified',
      verifiedAt: failedAt,
      intendedProfileRevision: computeContractProfileRevision(wouldPass)
    };

    expect(() => planRestartProfileActivation(pending, terminalProfile))
      .toThrowError('RESTART_PROFILE_CONFLICT');
  });

  it.each([
    'CLEANUP_TARGET_ALREADY_MISSING',
    'CLEANUP_IDENTITY_MISMATCH',
    'CONDITIONAL_NONPERMANENT_CLEANUP_FAILED'
  ] as const)('persists %s locator before a run-bound FAILED profile/report', async (reasonCode) => {
    const { pending, profile } = verifiedFixture();
    const order: string[] = [];
    const expected = buildCleanupFailedProfile(profile, pending, {
      checkedAt: cleanupCheckedAt,
      reasonCode
    });

    await expect(persistCleanupFailure({
      pending,
      profile,
      checkedAt: cleanupCheckedAt,
      reasonCode,
      persistLocator: async () => { order.push('cleanup-locator'); },
      persistProfile: async (next) => {
        order.push('cleanup-profile');
        return next;
      }
    })).resolves.toEqual(expected);
    expect(order).toEqual(['cleanup-locator', 'cleanup-profile']);
    expect(expected.restartPersistence).toBe('passed');
    expect(expected.evidence.at(-1)).toMatchObject({
      operation: 'cleanup',
      status: 'failed',
      timestamp: cleanupCheckedAt,
      reasonCode: cleanupFailureEvidenceReasonCode(pending, reasonCode)
    });
    expect(renderContractProfileMarkdown(expected)).toContain('| cleanup | FAILED |');
  });

  it('retains the cleanup locator when failed-profile CAS conflicts', async () => {
    const { pending, profile } = verifiedFixture();
    let locatorPersisted = false;
    await expect(persistCleanupFailure({
      pending,
      profile,
      checkedAt: cleanupCheckedAt,
      reasonCode: 'CLEANUP_TARGET_ALREADY_MISSING',
      persistLocator: async () => { locatorPersisted = true; },
      persistProfile: async () => { throw new Error('CONTRACT_PROFILE_CONFLICT'); }
    })).rejects.toThrowError('CONTRACT_PROFILE_CONFLICT');
    expect(locatorPersisted).toBe(true);
  });

  it('resumes cleanup from cleanup-only failed evolution without reactivating restart', () => {
    const { pending, profile } = verifiedFixture();
    const failedCleanup = buildCleanupFailedProfile(profile, pending, {
      checkedAt: cleanupCheckedAt,
      reasonCode: 'CLEANUP_TARGET_ALREADY_MISSING'
    });
    const locator = {
      ...pending,
      cleanupStatus: 'failed' as const,
      cleanupReasonCode: 'CLEANUP_TARGET_ALREADY_MISSING',
      cleanupCheckedAt
    };
    expect(restartPendingCanResumeCleanup(pending, failedCleanup, locator)).toBe(true);
    expect(() => planRestartProfileActivation(pending, failedCleanup))
      .toThrowError('RESTART_PROFILE_CONFLICT');

    const { schemaVersion: _schema, profileKey: _key, formalWriteGate: _gate, ...input } = failedCleanup;
    const unrelated = buildContractProfile({
      ...input,
      safeRead: true
    });
    expect(restartPendingCanResumeCleanup(pending, unrelated, locator)).toBe(false);

    const restartFailed = buildContractProfile({
      ...input,
      restartPersistence: 'failed',
      restartCheckedAt: cleanupCheckedAt,
      evidence: [
        ...failedCleanup.evidence,
        {
          operation: 'restartPersistence',
          status: 'failed',
          timestamp: cleanupCheckedAt,
          reasonCode: 'RESTART_STATE_MISMATCH',
          primitive: 'RAW_REREAD'
        }
      ]
    });
    expect(restartPendingCanResumeCleanup(pending, restartFailed, locator)).toBe(false);
  });
});
