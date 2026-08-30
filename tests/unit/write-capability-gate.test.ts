import { describe, expect, it } from 'vitest';
import {
  composeGateOutput,
  evaluateWriteCapability,
  runWriteCapabilityGate
} from '../../scripts/gate-write-capability.js';
import { buildContractProfile, type ContractProfileInput } from '../../src/server/vault/contract-profile-store.js';

function input(overrides: Partial<ContractProfileInput> = {}): ContractProfileInput {
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
      reasonCode: 'EXECUTABLE_PROBE_PASSED'
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
      'BLOCKED safeRead:CAPABILITY_NOT_PASSED safeCreate:CAPABILITY_NOT_PASSED '
      + 'safeRestore:CAPABILITY_NOT_PASSED rereadVerified:CAPABILITY_NOT_PASSED '
      + 'externalMutationObservation:EXTERNAL_MUTATION_FAILED '
      + 'restartPersistence:RESTART_UNVERIFIED formalWriteGate:FORMAL_GATE_BLOCKED'
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

  it('composes a non-throwing blocked CLI result when expected context is absent', async () => {
    await expect(runWriteCapabilityGate({
      profileDirectory: '/unused/private/path',
      expectedProfileKey: undefined
    })).resolves.toEqual({
      exitCode: 1,
      output: 'BLOCKED profile:PROFILE_UNAVAILABLE'
    });
  });
});
