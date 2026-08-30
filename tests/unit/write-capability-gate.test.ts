import { describe, expect, it } from 'vitest';
import {
  composeGateOutput,
  evaluateWriteCapability,
  runWriteCapabilityGate
} from '../../scripts/gate-write-capability.js';
import { buildContractProfile, type ContractProfileInput } from '../../src/server/vault/contract-profile-store.js';

function input(overrides: Partial<ContractProfileInput> = {}): ContractProfileInput {
  const primitiveByOperation = {
    safeRead: 'RAW_REREAD',
    safeCreate: 'COPY_ALLOW_OVERWRITE_FALSE',
    safeReplace: 'PATCH_IF_MATCH',
    safeRestore: 'PATCH_IF_MATCH',
    safeDelete: 'DELETE_NON_PERMANENT',
    rereadVerified: 'RAW_REREAD',
    externalMutationObservation: 'DIRECTORY_POLL',
    restartPersistence: 'RAW_REREAD'
  } as const;
  return {
    pluginId: 'obsidian-local-rest-api',
    pluginVersion: '5.1.0',
    obsidianVersion: '1.13.7',
    openApiSha256: 'a'.repeat(64),
    checkedAt: '2026-08-31T00:00:00.000Z',
    safeRead: true,
    safeCreate: true,
    safeReplace: true,
    safeRestore: true,
    safeDelete: true,
    rereadVerified: true,
    externalMutationObservation: 'passed',
    restartPersistence: 'passed',
    evidence: [
      'safeRead',
      'safeCreate',
      'safeReplace',
      'safeRestore',
      'safeDelete',
      'rereadVerified',
      'externalMutationObservation',
      'restartPersistence'
    ].map((operation) => ({
      operation: operation as ContractProfileInput['evidence'][number]['operation'],
      status: 'passed' as const,
      timestamp: '2026-08-31T00:00:00.000Z',
      reasonCode: operation === 'safeDelete'
        ? 'CONDITIONAL_NONPERMANENT_DELETE_VERIFIED'
        : 'EXECUTABLE_PROBE_PASSED',
      primitive: primitiveByOperation[operation as keyof typeof primitiveByOperation]
    })),
    ...overrides
  };
}

describe('write capability gate', () => {
  it('passes only a complete profile with the exact expected key', () => {
    const profile = buildContractProfile(input());
    expect(evaluateWriteCapability(profile, profile.profileKey)).toEqual({
      passed: true,
      missing: []
    });
    expect(composeGateOutput({ passed: true, missing: [] })).toBe('PASSED');
  });

  it('lists every blocked or unverified required capability', () => {
    const profile = buildContractProfile(input({
      safeRead: false,
      safeCreate: false,
      safeRestore: false,
      rereadVerified: false,
      externalMutationObservation: 'failed',
      restartPersistence: 'unverified'
    }));
    const result = evaluateWriteCapability(profile, profile.profileKey);
    expect(result).toEqual({
      passed: false,
      missing: [
        { capability: 'safeRead', reasonCode: 'CAPABILITY_NOT_PASSED' },
        { capability: 'safeCreate', reasonCode: 'CAPABILITY_NOT_PASSED' },
        { capability: 'safeRestore', reasonCode: 'CAPABILITY_NOT_PASSED' },
        { capability: 'rereadVerified', reasonCode: 'CAPABILITY_NOT_PASSED' },
        { capability: 'externalMutationObservation', reasonCode: 'EXTERNAL_MUTATION_FAILED' },
        { capability: 'restartPersistence', reasonCode: 'RESTART_UNVERIFIED' },
        { capability: 'formalWriteGate', reasonCode: 'FORMAL_GATE_BLOCKED' }
      ]
    });
    expect(composeGateOutput(result)).toBe(
      'BLOCKED safeRead safeCreate safeRestore rereadVerified '
      + 'externalMutationObservation restartPersistence formalWriteGate'
    );
  });

  it('fails closed for unavailable profiles and key mismatch', () => {
    const profile = buildContractProfile(input());
    expect(evaluateWriteCapability(undefined, profile.profileKey)).toEqual({
      passed: false,
      missing: [{ capability: 'profile', reasonCode: 'PROFILE_UNAVAILABLE' }]
    });
    expect(evaluateWriteCapability(profile, 'b'.repeat(64))).toEqual({
      passed: false,
      missing: [{ capability: 'profileKey', reasonCode: 'PROFILE_KEY_MISMATCH' }]
    });
  });

  it('names a capability whose latest evidence revoked an older pass', () => {
    const base = input();
    const profile = buildContractProfile(input({
      evidence: [
        ...base.evidence,
        {
          operation: 'safeReplace',
          status: 'failed',
          timestamp: '2026-08-31T01:00:00.000Z',
          reasonCode: 'LATEST_REPLACE_FAILED',
          primitive: 'PATCH_IF_MATCH'
        }
      ]
    }));
    expect(composeGateOutput(evaluateWriteCapability(profile, profile.profileKey)))
      .toBe('BLOCKED safeReplace formalWriteGate');
  });

  it('composes a non-throwing blocked CLI result when expected context is absent', async () => {
    await expect(runWriteCapabilityGate({
      profileDirectory: '/unused/private/path',
      expectedProfileKey: undefined
    })).resolves.toEqual({
      exitCode: 1,
      output: 'BLOCKED profile'
    });
  });
});
