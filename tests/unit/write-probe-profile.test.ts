import { describe, expect, it } from 'vitest';
import {
  aggregateSafeCreate,
  buildWriteProbeProfile,
  type CapabilityResult
} from '../helpers/write-probe-profile.js';
import { renderContractProfileMarkdown } from '../../src/server/vault/contract-profile-store.js';

const timestamp = '2026-08-31T00:00:00.000Z';
const passed = (operation: CapabilityResult['operation'], primitive: CapabilityResult['primitive']): CapabilityResult => ({
  operation, primitive, status: 'passed', reasonCode: 'PROBE_PASSED', timestamp
});
const failed = (operation: CapabilityResult['operation'], primitive: CapabilityResult['primitive']): CapabilityResult => ({
  operation, primitive, status: 'failed', reasonCode: 'PROBE_FAILED', timestamp
});

describe('write probe profile aggregation', () => {
  it('records PUT and COPY separately and passes safeCreate only for an actually safe candidate', () => {
    expect(aggregateSafeCreate([
      failed('safeCreate', 'PUT_REJECT_IF_CONTENT_PREEXISTS'),
      passed('safeCreate', 'COPY_ALLOW_OVERWRITE_FALSE')
    ])).toEqual({ passed: true, complete: true });
    expect(aggregateSafeCreate([
      failed('safeCreate', 'PUT_REJECT_IF_CONTENT_PREEXISTS')
    ])).toEqual({ passed: false, complete: false });
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
      undefined
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
});
