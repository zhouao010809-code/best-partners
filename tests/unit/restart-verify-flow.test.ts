import { describe, expect, it, vi } from 'vitest';
import type {
  PreparedRestartPending,
  RestartVerifiedPending
} from '../helpers/restart-pending.js';
import {
  activateVerifiedRestart,
  buildRestartVerifiedProfile,
  planRestartProfileActivation
} from '../helpers/restart-verify-flow.js';
import {
  buildContractProfile,
  computeContractProfileRevision
} from '../../src/server/vault/contract-profile-store.js';

function pending(): PreparedRestartPending {
  return {
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
}

describe('restart activation ordering', () => {
  it('builds the same intended passed revision from a fixed verified timestamp', () => {
    const checkedAt = '2026-08-31T02:00:00.000Z';
    const profile = buildContractProfile({
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
      evidence: []
    });
    const verifiedAt = '2026-08-31T03:00:00.000Z';
    const left = buildRestartVerifiedProfile(profile, verifiedAt);
    const right = buildRestartVerifiedProfile(profile, verifiedAt);

    expect(computeContractProfileRevision(left)).toBe(computeContractProfileRevision(right));
    expect(left.restartCheckedAt).toBe(verifiedAt);
    expect(left.evidence.at(-2)).toMatchObject({
      operation: 'restartPersistence',
      status: 'passed',
      timestamp: verifiedAt
    });
  });

  it('rebases only onto a newer blocked profile and preserves its revoked evidence', () => {
    const checkedAt = '2026-08-31T02:00:00.000Z';
    const revoked = buildContractProfile({
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
        operation: 'safeRead',
        status: 'failed',
        timestamp: checkedAt,
        reasonCode: 'READ_FIDELITY_REVOKED',
        primitive: 'RAW_REREAD'
      }, {
        operation: 'restartPersistence',
        status: 'unverified',
        timestamp: checkedAt,
        reasonCode: 'RESTART_PERSISTENCE_PENDING',
        primitive: 'RAW_REREAD'
      }]
    });
    const oldPending: RestartVerifiedPending = {
      ...pending(),
      phase: 'restart-verified',
      verifiedAt: '2026-08-31T03:00:00.000Z',
      intendedProfileRevision: 'c'.repeat(64)
    };

    const plan = planRestartProfileActivation(oldPending, revoked);
    expect(plan.intendedProfileRevision).not.toBe(oldPending.intendedProfileRevision);
    expect(plan.profile.safeRead).toBe(false);
    expect(plan.profile.formalWriteGate).toBe('blocked');
    expect(plan.verifiedAt).toBe(oldPending.verifiedAt);
  });

  it('does not rebase an old pending target over a concurrently passing profile', () => {
    const verifiedAt = '2026-08-31T03:00:00.000Z';
    const passed = buildContractProfile({
      pluginId: 'obsidian-local-rest-api',
      pluginVersion: '5.1.0',
      obsidianVersion: '1.13.7',
      openApiSha256: 'a'.repeat(64),
      checkedAt: verifiedAt,
      restartCheckedAt: verifiedAt,
      safeRead: true,
      safeCreate: true,
      safeReplace: true,
      safeRestore: true,
      safeDelete: true,
      rereadVerified: true,
      externalMutationObservation: 'passed',
      restartPersistence: 'passed',
      evidence: [
        { operation: 'safeRead', status: 'passed', timestamp: verifiedAt, reasonCode: 'READ_FIDELITY_VERIFIED', primitive: 'RAW_REREAD' },
        { operation: 'safeCreate', status: 'passed', timestamp: verifiedAt, reasonCode: 'SAFE_CREATE_VERIFIED', primitive: 'COPY_ALLOW_OVERWRITE_FALSE' },
        { operation: 'safeReplace', status: 'passed', timestamp: verifiedAt, reasonCode: 'CAS_REPLACE_VERIFIED', primitive: 'PATCH_IF_MATCH' },
        { operation: 'safeRestore', status: 'passed', timestamp: verifiedAt, reasonCode: 'CAS_RESTORE_VERIFIED', primitive: 'PATCH_IF_MATCH' },
        { operation: 'safeDelete', status: 'passed', timestamp: verifiedAt, reasonCode: 'CONDITIONAL_NONPERMANENT_DELETE_VERIFIED', primitive: 'DELETE_NON_PERMANENT' },
        { operation: 'rereadVerified', status: 'passed', timestamp: verifiedAt, reasonCode: 'RAW_REREAD_VERIFIED', primitive: 'RAW_REREAD' },
        { operation: 'externalMutationObservation', status: 'passed', timestamp: verifiedAt, reasonCode: 'EXTERNAL_OBSERVATION_VERIFIED', primitive: 'RAW_REREAD' },
        { operation: 'restartPersistence', status: 'passed', timestamp: verifiedAt, reasonCode: 'RAW_HASH_AND_VERSION_PERSISTED', primitive: 'RAW_REREAD' }
      ]
    });
    const oldPending: RestartVerifiedPending = {
      ...pending(),
      phase: 'restart-verified',
      verifiedAt,
      intendedProfileRevision: 'c'.repeat(64)
    };

    expect(() => planRestartProfileActivation(oldPending, passed))
      .toThrowError('RESTART_PROFILE_CONFLICT');
  });

  it('does not erase a concurrent restart failure while rebasing a verified pending run', () => {
    const failedAt = '2026-08-31T04:00:00.000Z';
    const failed = buildContractProfile({
      pluginId: 'obsidian-local-rest-api',
      pluginVersion: '5.1.0',
      obsidianVersion: '1.13.7',
      openApiSha256: 'a'.repeat(64),
      checkedAt: failedAt,
      restartCheckedAt: failedAt,
      safeRead: false,
      safeCreate: false,
      safeReplace: false,
      safeRestore: false,
      safeDelete: false,
      rereadVerified: false,
      externalMutationObservation: 'unverified',
      restartPersistence: 'failed',
      evidence: [{
        operation: 'restartPersistence',
        status: 'failed',
        timestamp: failedAt,
        reasonCode: 'RESTART_STATE_MISMATCH',
        primitive: 'RAW_REREAD'
      }]
    });
    const oldPending: RestartVerifiedPending = {
      ...pending(),
      phase: 'restart-verified',
      verifiedAt: '2026-08-31T03:00:00.000Z',
      intendedProfileRevision: 'c'.repeat(64)
    };

    expect(() => planRestartProfileActivation(oldPending, failed))
      .toThrowError('RESTART_PROFILE_CONFLICT');
  });

  it('does not activate a passing profile when the pending transition fails', async () => {
    const activateProfile = vi.fn(async () => 'activated');
    await expect(activateVerifiedRestart({
      pending: pending(),
      markVerified: async () => { throw new Error('RESTART_PENDING_NOT_CURRENT'); },
      activateProfile
    })).rejects.toThrowError('RESTART_PENDING_NOT_CURRENT');
    expect(activateProfile).not.toHaveBeenCalled();
  });

  it('leaves pending verified on profile CAS conflict and completes on retry', async () => {
    let current: PreparedRestartPending | RestartVerifiedPending = pending();
    const order: string[] = [];
    const markVerified = async (): Promise<RestartVerifiedPending> => {
      order.push('pending-verified');
      current = {
        ...current,
        phase: 'restart-verified',
        verifiedAt: '2026-08-31T03:00:00.000Z',
        intendedProfileRevision: 'c'.repeat(64)
      } as RestartVerifiedPending;
      return current;
    };
    const activateProfile = vi.fn()
      .mockImplementationOnce(async () => {
        order.push('profile-conflict');
        throw new Error('CONTRACT_PROFILE_CONFLICT');
      })
      .mockImplementationOnce(async () => {
        order.push('profile-activated');
        return 'activated';
      });

    await expect(activateVerifiedRestart({
      pending: current,
      markVerified,
      activateProfile
    })).rejects.toThrowError('CONTRACT_PROFILE_CONFLICT');
    expect(current.phase).toBe('restart-verified');

    await expect(activateVerifiedRestart({
      pending: current,
      markVerified,
      activateProfile
    })).resolves.toMatchObject({ profile: 'activated' });
    expect(order).toEqual([
      'pending-verified',
      'profile-conflict',
      'pending-verified',
      'profile-activated'
    ]);
  });
});
