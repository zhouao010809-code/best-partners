import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertContractTestVault } from '../../helpers/test-vault-guard.js';
import {
  assertSandboxVaultPath,
  contractSandboxRoots,
  createContractGateway,
  loadContractEnvironment
} from '../../helpers/contract-runtime.js';
import { loadRestartPending } from '../../helpers/restart-pending.js';
import {
  buildContractProfile,
  loadContractProfileByKey,
  writeContractProfile
} from '../../../src/server/vault/contract-profile-store.js';

const environment = loadContractEnvironment(process.env);

describe.skipIf(environment === undefined)('Local REST restart persistence verify', () => {
  it('guards, rereads the exact pending note, and updates restart evidence', async () => {
    const currentEnvironment = environment!;
    const gateway = createContractGateway(currentEnvironment);
    await assertContractTestVault({
      gateway,
      testVaultRoot: currentEnvironment.testVaultRoot,
      formalVaultRoot: currentEnvironment.formalVaultRoot,
      sourceRoot: currentEnvironment.sourceRoot,
      appDataRoot: currentEnvironment.appDataRoot,
      allowWrite: process.env.ALLOW_OBSIDIAN_CONTRACT_WRITE
    });

    const profileDirectory = join(currentEnvironment.appDataRoot, 'contract-profiles');
    const pending = await loadRestartPending(profileDirectory);
    expect(pending).toBeDefined();
    const currentPending = pending!;
    const roots = contractSandboxRoots(currentPending.runId);
    const root = currentPending.root === 'library' ? roots.library : roots.knowledge;
    const notePath = assertSandboxVaultPath(`${root}/${currentPending.noteId}`, currentPending.runId);
    const observed = await gateway.readRaw(notePath);
    expect(observed.rawSha256).toBe(currentPending.rawSha256);
    expect(observed.upstreamVersion).toBe(currentPending.upstreamVersion);

    const existing = await loadContractProfileByKey(profileDirectory, currentPending.profileKey);
    expect(existing).toBeDefined();
    const profile = existing!;
    const {
      schemaVersion: _schemaVersion,
      profileKey: _profileKey,
      formalWriteGate: _formalWriteGate,
      ...input
    } = profile;
    const restartCheckedAt = new Date().toISOString();
    await writeContractProfile(profileDirectory, buildContractProfile({
      ...input,
      restartPersistence: 'passed',
      restartCheckedAt,
      evidence: [
        ...profile.evidence,
        {
          operation: 'restartPersistence',
          status: 'passed',
          httpStatuses: [200],
          timestamp: restartCheckedAt,
          reasonCode: 'RAW_HASH_AND_VERSION_PERSISTED',
          primitive: 'RAW_REREAD'
        },
        {
          operation: 'cleanup',
          status: 'unverified',
          timestamp: restartCheckedAt,
          reasonCode: 'MANUAL_CLEANUP_REQUIRED',
          primitive: 'DELETE_NON_PERMANENT'
        }
      ]
    }));
  });
});
