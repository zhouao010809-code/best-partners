import { describe, expect, it } from 'vitest';
import {
  aggregateSafeCreate,
  buildWriteProbeProfile,
  type CapabilityResult
} from '../helpers/write-probe-profile.js';
import {
  buildContractProfile,
  renderContractProfileMarkdown,
  type StoredContractProfile
} from '../../src/server/vault/contract-profile-store.js';

const timestamp = '2026-08-31T00:00:00.000Z';
const passed = (operation: CapabilityResult['operation'], primitive: CapabilityResult['primitive']): CapabilityResult => ({
  operation, primitive, status: 'passed', reasonCode: 'PROBE_PASSED', timestamp
});
const failed = (operation: CapabilityResult['operation'], primitive: CapabilityResult['primitive']): CapabilityResult => ({
  operation, primitive, status: 'failed', reasonCode: 'PROBE_FAILED', timestamp
});

function priorReadProfile(overrides: Partial<StoredContractProfile> = {}): StoredContractProfile {
  return {
    ...buildContractProfile({
      pluginId: 'obsidian-local-rest-api',
      pluginVersion: '5.1.0',
      obsidianVersion: '1.13.7',
      openApiSha256: 'a'.repeat(64),
      checkedAt: timestamp,
      safeRead: true,
      safeCreate: false,
      safeReplace: false,
      safeRestore: false,
      safeDelete: false,
      rereadVerified: false,
      externalMutationObservation: 'unverified',
      restartPersistence: 'unverified',
      evidence: [{
        operation: 'safeRead',
        status: 'passed',
        timestamp,
        reasonCode: 'READ_FIDELITY_VERIFIED',
        primitive: 'RAW_REREAD'
      }]
    }),
    ...overrides
  };
}

describe('write probe profile aggregation', () => {
  it('records PUT and COPY separately and passes safeCreate only for an actually safe candidate', () => {
    expect(aggregateSafeCreate([
      failed('safeCreate', 'PUT_REJECT_IF_CONTENT_PREEXISTS'),
      passed('safeCreate', 'COPY_ALLOW_OVERWRITE_FALSE')
    ])).toEqual({ passed: true, complete: true, primitive: 'COPY_ALLOW_OVERWRITE_FALSE' });
    expect(aggregateSafeCreate([
      failed('safeCreate', 'PUT_REJECT_IF_CONTENT_PREEXISTS')
    ])).toEqual({ passed: false, complete: false, primitive: undefined });
  });

  it('places an aggregate safeCreate result after both primitive records for reporting', async () => {
    const profile = await buildWriteProbeProfile({
      fingerprint: {
        pluginId: 'obsidian-local-rest-api',
        pluginVersion: '5.1.0',
        obsidianVersion: '1.13.7'
      },
      openApiSha256: 'a'.repeat(64),
      checkedAt: timestamp,
      results: [
        passed('safeCreate', 'PUT_REJECT_IF_CONTENT_PREEXISTS'),
        failed('safeCreate', 'COPY_ALLOW_OVERWRITE_FALSE')
      ],
      persist: async () => {}
    });
    const createEvidence = profile.evidence.filter((record) => record.operation === 'safeCreate');
    expect(createEvidence.map((record) => record.primitive)).toEqual([
      'PUT_REJECT_IF_CONTENT_PREEXISTS',
      'COPY_ALLOW_OVERWRITE_FALSE',
      'PUT_REJECT_IF_CONTENT_PREEXISTS'
    ]);
    expect(createEvidence.at(-1)?.status).toBe('passed');
  });

  it('builds and persists a blocked profile even when every capability probe is negative', async () => {
    const results: CapabilityResult[] = [
      failed('safeRead', 'RAW_REREAD'),
      failed('safeCreate', 'PUT_REJECT_IF_CONTENT_PREEXISTS'),
      failed('safeCreate', 'COPY_ALLOW_OVERWRITE_FALSE'),
      failed('safeReplace', 'PATCH_IF_MATCH'),
      failed('safeRestore', 'PATCH_IF_MATCH'),
      failed('safeDelete', undefined),
      failed('rereadVerified', 'RAW_REREAD'),
      failed('externalMutationObservation', 'DIRECTORY_POLL')
    ];
    let persisted = false;
    const profile = await buildWriteProbeProfile({
      fingerprint: {
        pluginId: 'obsidian-local-rest-api',
        pluginVersion: '5.1.0',
        obsidianVersion: '1.13.7'
      },
      openApiSha256: 'a'.repeat(64),
      checkedAt: timestamp,
      results,
      persist: async () => { persisted = true; }
    });
    expect(persisted).toBe(true);
    expect(profile.safeRead).toBe(false);
    expect(profile.safeCreate).toBe(false);
    expect(profile.formalWriteGate).toBe('blocked');
    expect(profile.evidence).toContainEqual({
      operation: 'cleanup',
      status: 'unverified',
      timestamp,
      reasonCode: 'MANUAL_CLEANUP_REQUIRED',
      primitive: 'DELETE_NON_PERMANENT'
    });
    expect(renderContractProfileMarkdown(profile)).toContain('MANUAL_CLEANUP_REQUIRED');
  });

  it('preserves exact verified read fidelity and never upgrades it from write setup reads', async () => {
    const prior = priorReadProfile();
    const profile = await buildWriteProbeProfile({
      fingerprint: {
        pluginId: prior.pluginId,
        pluginVersion: prior.pluginVersion,
        obsidianVersion: prior.obsidianVersion
      },
      openApiSha256: prior.openApiSha256,
      checkedAt: '2026-08-31T01:00:00.000Z',
      priorReadProfile: prior,
      results: [passed('safeRead', 'RAW_REREAD')],
      persist: async () => {}
    });
    expect(profile.safeRead).toBe(true);
    expect(profile.evidence).toContainEqual(prior.evidence[0]);
    expect(profile.evidence.filter((record) => record.operation === 'safeRead')).toHaveLength(1);
  });

  it('inherits only the latest verified safeRead record from a large prior history', async () => {
    const verified = priorReadProfile().evidence[0]!;
    const prior = priorReadProfile({
      evidence: [
        verified,
        ...Array.from({ length: 126 }, (_, index) => ({
          operation: 'cleanup' as const,
          status: 'passed' as const,
          timestamp,
          reasonCode: `OLD_CLEANUP_${index}`,
          primitive: 'DELETE_NON_PERMANENT' as const
        }))
      ]
    });
    const profile = await buildWriteProbeProfile({
      fingerprint: {
        pluginId: prior.pluginId,
        pluginVersion: prior.pluginVersion,
        obsidianVersion: prior.obsidianVersion
      },
      openApiSha256: prior.openApiSha256,
      checkedAt: '2026-08-31T01:00:00.000Z',
      priorReadProfile: prior,
      results: [],
      persist: async () => {}
    });
    expect(profile.evidence.length).toBeLessThan(16);
    expect(profile.evidence.filter((record) => record.operation === 'safeRead')).toEqual([verified]);
    expect(profile.evidence.some((record) => record.reasonCode.startsWith('OLD_CLEANUP_'))).toBe(false);
  });

  it('does not let prior cleanup evidence suppress this run manual-cleanup record', async () => {
    const prior = priorReadProfile({
      evidence: [
        priorReadProfile().evidence[0]!,
        {
          operation: 'cleanup',
          status: 'passed',
          timestamp,
          reasonCode: 'OLD_CLEANUP_PASSED',
          primitive: 'DELETE_NON_PERMANENT'
        }
      ]
    });
    const profile = await buildWriteProbeProfile({
      fingerprint: {
        pluginId: prior.pluginId,
        pluginVersion: prior.pluginVersion,
        obsidianVersion: prior.obsidianVersion
      },
      openApiSha256: prior.openApiSha256,
      checkedAt: '2026-08-31T01:00:00.000Z',
      priorReadProfile: prior,
      results: [],
      persist: async () => {}
    });
    expect(profile.evidence.filter((record) => record.operation === 'cleanup')).toEqual([{
      operation: 'cleanup',
      status: 'unverified',
      timestamp: '2026-08-31T01:00:00.000Z',
      reasonCode: 'MANUAL_CLEANUP_REQUIRED',
      primitive: 'DELETE_NON_PERMANENT'
    }]);
  });

  it.each([
    ['missing', undefined],
    ['fingerprint mismatch', priorReadProfile({ openApiSha256: 'b'.repeat(64) })],
    ['weak evidence', priorReadProfile({
      evidence: [{
        operation: 'safeRead',
        status: 'passed',
        timestamp,
        reasonCode: 'RAW_BYTES_AND_VERSION_VERIFIED',
        primitive: 'RAW_REREAD'
      }]
    })]
  ])('keeps safeRead unverified for %s prior evidence', async (_name, prior) => {
    const profile = await buildWriteProbeProfile({
      fingerprint: {
        pluginId: 'obsidian-local-rest-api',
        pluginVersion: '5.1.0',
        obsidianVersion: '1.13.7'
      },
      openApiSha256: 'a'.repeat(64),
      checkedAt: '2026-08-31T01:00:00.000Z',
      ...(prior === undefined ? {} : { priorReadProfile: prior }),
      results: [passed('safeRead', 'RAW_REREAD')],
      persist: async () => {}
    });
    expect(profile.safeRead).toBe(false);
    expect(profile.evidence.filter((record) => record.operation === 'safeRead').at(-1)).toMatchObject({
      status: 'unverified',
      reasonCode: 'READ_FIDELITY_PROFILE_UNAVAILABLE'
    });
  });
});
