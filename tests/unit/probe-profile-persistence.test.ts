import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildContractProfile,
  loadContractProfileStateByKey,
  writeContractProfile,
  type ContractProfileInput,
  type StoredContractProfile
} from '../../src/server/vault/contract-profile-store.js';
import {
  loadProbeProfileBaseline,
  persistProbeProfile
} from '../helpers/probe-profile-persistence.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function storeDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'probe-profile-persistence-'));
  roots.push(root);
  return join(root, 'contract-profiles');
}

function readProfile(
  checkedAt: string,
  safeRead: boolean,
  reasonCode: string,
  openApiSha256 = 'a'.repeat(64)
): StoredContractProfile {
  const evidence: ContractProfileInput['evidence'] = [{
    operation: 'safeRead',
    status: safeRead ? 'passed' : 'failed',
    timestamp: checkedAt,
    reasonCode,
    primitive: 'RAW_REREAD'
  }];
  return buildContractProfile({
    pluginId: 'obsidian-local-rest-api',
    pluginVersion: '5.1.0',
    obsidianVersion: '1.13.7',
    openApiSha256,
    checkedAt,
    safeRead,
    safeReplace: false,
    safeCreate: false,
    safeRestore: false,
    safeDelete: false,
    rereadVerified: false,
    externalMutationObservation: 'unverified',
    restartPersistence: 'unverified',
    evidence
  });
}

describe('probe profile persistence', () => {
  it('loads the validated global CAS baseline even when the next fingerprint key differs', async () => {
    const directory = await storeDirectory();
    const initial = readProfile('2026-08-31T00:00:00.000Z', true, 'READ_FIDELITY_VERIFIED');
    const state = await writeContractProfile(directory, initial);

    await expect(loadProbeProfileBaseline(directory, initial.profileKey)).resolves.toEqual(state);
    await expect(loadProbeProfileBaseline(directory, 'b'.repeat(64))).resolves.toEqual(state);
  });

  it('migrates to a new fingerprint key by CASing against the old global revision', async () => {
    const directory = await storeDirectory();
    const oldProfile = readProfile(
      '2026-08-31T00:00:00.000Z',
      true,
      'READ_FIDELITY_VERIFIED'
    );
    const oldState = await writeContractProfile(directory, oldProfile);
    const newProfile = readProfile(
      '2026-08-31T00:01:00.000Z',
      false,
      'NEW_FINGERPRINT_UNVERIFIED',
      'b'.repeat(64)
    );
    const baseline = await loadProbeProfileBaseline(directory, newProfile.profileKey);
    expect(baseline).toEqual(oldState);

    await expect(persistProbeProfile(directory, baseline, newProfile))
      .resolves.toMatchObject({ profile: newProfile });
  });

  it('recovers a staged activation before returning the exact probe baseline', async () => {
    const directory = await storeDirectory();
    const initial = readProfile('2026-08-31T00:00:00.000Z', true, 'READ_FIDELITY_VERIFIED');
    const initialState = await writeContractProfile(directory, initial);
    const revoked = readProfile('2026-08-31T00:01:00.000Z', false, 'READ_FIDELITY_REVOKED');
    await expect(writeContractProfile(directory, revoked, {
      expectedRevision: initialState.revision,
      testOnlyBeforePointerCommit: async () => {
        throw new Error('injected staged activation');
      }
    })).rejects.toThrowError('CONTRACT_PROFILE_WRITE_FAILED');

    await expect(loadProbeProfileBaseline(directory, revoked.profileKey))
      .resolves.toMatchObject({ profile: revoked });
  });

  it('uses a null revision for a first-write baseline and rejects a stale second first write', async () => {
    const directory = await storeDirectory();
    const first = readProfile('2026-08-31T00:00:00.000Z', false, 'FIRST_PROBE_FAILED');
    const stale = readProfile('2026-08-31T00:01:00.000Z', true, 'STALE_PROBE_PASSED');

    await persistProbeProfile(directory, undefined, first);
    await expect(persistProbeProfile(directory, undefined, stale))
      .rejects.toThrowError('CONTRACT_PROFILE_CONFLICT');

    await expect(loadContractProfileStateByKey(directory, first.profileKey))
      .resolves.toMatchObject({ profile: first });
  });

  it('keeps a concurrent revocation and rejects passing evidence built from the same stale baseline', async () => {
    const directory = await storeDirectory();
    const initial = readProfile('2026-08-31T00:00:00.000Z', true, 'READ_FIDELITY_VERIFIED');
    await writeContractProfile(directory, initial);
    const revocationBaseline = await loadContractProfileStateByKey(directory, initial.profileKey);
    const passingBaseline = await loadContractProfileStateByKey(directory, initial.profileKey);
    expect(revocationBaseline).toBeDefined();
    expect(passingBaseline).toEqual(revocationBaseline);

    const revoked = readProfile('2026-08-31T00:01:00.000Z', false, 'READ_FIDELITY_REVOKED');
    const stalePass = readProfile('2026-08-31T00:02:00.000Z', true, 'STALE_READ_PASSED');
    const revokedState = await persistProbeProfile(directory, revocationBaseline, revoked);

    await expect(persistProbeProfile(directory, passingBaseline, stalePass))
      .rejects.toThrowError('CONTRACT_PROFILE_CONFLICT');
    await expect(loadContractProfileStateByKey(directory, initial.profileKey))
      .resolves.toEqual(revokedState);
  });
});
