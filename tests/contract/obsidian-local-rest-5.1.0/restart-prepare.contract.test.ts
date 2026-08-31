import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { describe, it } from 'vitest';
import { assertContractTestVault } from '../../helpers/test-vault-guard.js';
import { createContractDiskSandbox } from '../../helpers/contract-disk-sandbox.js';
import { waitForRawObservation } from '../../helpers/contract-observation.js';
import {
  confirmPreparedRestartBlocked,
  runRestartPrepareFlow,
  selectRestartPreparation
} from '../../helpers/restart-prepare-flow.js';
import {
  assertSandboxVaultPath,
  contractSandboxRoots,
  createContractGateway,
  requireContractEnvironment
} from '../../helpers/contract-runtime.js';
import {
  loadRestartPending,
  markRestartPendingPrepared,
  writeRestartPending
} from '../../helpers/restart-pending.js';
import {
  buildContractProfile,
  computeContractProfileKey,
  loadContractProfileStateByKey,
  recoverContractProfileActivation,
  writeContractProfile
} from '../../../src/server/vault/contract-profile-store.js';

describe('Local REST restart persistence prepare', () => {
  it('guards, creates one sandbox note, and records only sanitized restart facts', async () => {
    const currentEnvironment = requireContractEnvironment(process.env);
    const gateway = createContractGateway(currentEnvironment);
    const canonicalRoots = await assertContractTestVault({
      gateway,
      testVaultRoot: currentEnvironment.testVaultRoot,
      formalVaultRoot: currentEnvironment.formalVaultRoot,
      sourceRoot: currentEnvironment.sourceRoot,
      appDataRoot: currentEnvironment.appDataRoot,
      allowWrite: process.env.ALLOW_OBSIDIAN_CONTRACT_WRITE
    });

    const fingerprint = await gateway.fingerprint();
    if (fingerprint.pluginId !== 'obsidian-local-rest-api' || fingerprint.pluginVersion.split('.')[0] !== '5') {
      throw new Error('PLUGIN_CONTRACT_INCOMPATIBLE');
    }
    const openApiSha256 = createHash('sha256').update(await gateway.readOpenApi(), 'utf8').digest('hex');
    const expectedOpenApiSha256 = process.env.OBSIDIAN_EXPECTED_OPENAPI_SHA256;
    if (expectedOpenApiSha256 !== undefined && expectedOpenApiSha256 !== openApiSha256) {
      throw new Error('OPENAPI_FINGERPRINT_MISMATCH');
    }
    const profileKey = computeContractProfileKey({ ...fingerprint, openApiSha256 });
    const profileDirectory = join(canonicalRoots.appDataRoot, 'contract-profiles');
    await recoverContractProfileActivation(profileDirectory);
    const existing = await loadContractProfileStateByKey(profileDirectory, profileKey);
    if (existing === undefined) throw new Error('RESTART_PROFILE_UNAVAILABLE');
    const profile = existing.profile;
    const {
      schemaVersion: _schemaVersion,
      profileKey: _profileKey,
      formalWriteGate: _formalWriteGate,
      restartCheckedAt: _restartCheckedAt,
      ...profileInput
    } = profile;
    const blockedAt = new Date().toISOString();
    const blockProfile = () => writeContractProfile(profileDirectory, buildContractProfile({
      ...profileInput,
      restartPersistence: 'unverified',
      evidence: [
        ...profile.evidence.filter((record) => (
          record.operation !== 'restartPersistence' && record.operation !== 'cleanup'
        )),
        {
          operation: 'restartPersistence',
          status: 'unverified',
          timestamp: blockedAt,
          reasonCode: 'PREPARING_AWAITING_OBSERVATION',
          primitive: 'RAW_REREAD'
        },
        {
          operation: 'cleanup',
          status: 'unverified',
          timestamp: blockedAt,
          reasonCode: 'MANUAL_CLEANUP_REQUIRED'
        }
      ]
    }), { expectedRevision: existing.revision });
    const freshRunId = ulid();
    const noteId = 'restart.md';
    const bytes = new TextEncoder().encode('# Restart contract\npersist\n');
    const rawSha256 = createHash('sha256').update(bytes).digest('hex');
    const active = await loadRestartPending(profileDirectory);
    if (active?.phase === 'prepared' && active.profileKey === profileKey) {
      await confirmPreparedRestartBlocked({
        blockProfile,
        announce: () => process.stdout.write(
          'Restart Obsidian, then run npm run test:contract:obsidian:restart:verify\n'
        )
      });
      return;
    }
    const preparing = selectRestartPreparation(active, {
      schemaVersion: 1,
      phase: 'preparing',
      runId: freshRunId,
      root: 'library',
      noteId,
      rawSha256,
      profileKey,
      manualCleanupReasonCode: 'MANUAL_CLEANUP_REQUIRED'
    });
    const runId = preparing.runId;
    const notePath = assertSandboxVaultPath(
      `${contractSandboxRoots(runId).library}/${preparing.noteId}`,
      runId
    );
    const disk = createContractDiskSandbox({
      canonicalTestVaultRoot: canonicalRoots.testVaultRoot,
      runId
    });
    await runRestartPrepareFlow({
      preparing,
      blockProfile,
      writePreparing: (pending) => writeRestartPending(profileDirectory, pending),
      mutateAndObserve: async () => {
        await disk.ensureFile(notePath, bytes);
        const observed = await waitForRawObservation({
          gateway,
          path: notePath,
          expectedRawSha256: rawSha256,
          requireVersion: true
        });
        return {
          rawSha256: observed.rawSha256,
          upstreamVersion: observed.upstreamVersion!
        };
      },
      markPrepared: (pending, observation) => markRestartPendingPrepared(
        profileDirectory,
        pending,
        observation
      )
    });
    process.stdout.write('Restart Obsidian, then run npm run test:contract:obsidian:restart:verify\n');
  });
});
