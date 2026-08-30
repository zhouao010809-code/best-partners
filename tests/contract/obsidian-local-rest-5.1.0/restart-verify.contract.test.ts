import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { assertContractTestVault } from '../../helpers/test-vault-guard.js';
import {
  assertSandboxVaultPath,
  ContractRestClient,
  contractSandboxRoots,
  createContractGateway,
  requireContractEnvironment
} from '../../helpers/contract-runtime.js';
import {
  consumeRestartPending,
  isVerifiedNonPermanentCleanup,
  loadRestartPending,
  markRestartPendingVerified,
  restartPendingAlreadyCompleted,
  restartPendingHasVerifiedRestart,
  restartPendingMatchesProfile
} from '../../helpers/restart-pending.js';
import {
  buildContractProfile,
  computeContractProfileKey,
  loadContractProfileStateByKey,
  writeContractProfile
} from '../../../src/server/vault/contract-profile-store.js';
import { VaultGatewayError } from '../../../src/server/vault/LocalRest51Gateway.js';

describe('Local REST restart persistence verify', () => {
  it('matches the current fingerprint, updates restart evidence, and consumes only a successful pending record', async () => {
    const environment = requireContractEnvironment(process.env);
    const gateway = createContractGateway(environment);
    const canonicalRoots = await assertContractTestVault({
      gateway,
      testVaultRoot: environment.testVaultRoot,
      formalVaultRoot: environment.formalVaultRoot,
      sourceRoot: environment.sourceRoot,
      appDataRoot: environment.appDataRoot,
      allowWrite: process.env.ALLOW_OBSIDIAN_CONTRACT_WRITE
    });

    const profileDirectory = join(canonicalRoots.appDataRoot, 'contract-profiles');
    let pending = await loadRestartPending(profileDirectory);
    if (pending === undefined) throw new Error('RESTART_PENDING_UNAVAILABLE');
    const fingerprint = await gateway.fingerprint();
    if (fingerprint.pluginId !== 'obsidian-local-rest-api' || fingerprint.pluginVersion.split('.')[0] !== '5') {
      throw new Error('PLUGIN_CONTRACT_INCOMPATIBLE');
    }
    const openApiSha256 = createHash('sha256').update(await gateway.readOpenApi(), 'utf8').digest('hex');
    const expectedOpenApiSha256 = process.env.OBSIDIAN_EXPECTED_OPENAPI_SHA256;
    if (expectedOpenApiSha256 !== undefined && expectedOpenApiSha256 !== openApiSha256) {
      throw new Error('OPENAPI_FINGERPRINT_MISMATCH');
    }
    const currentProfileKey = computeContractProfileKey({ ...fingerprint, openApiSha256 });
    if (!restartPendingMatchesProfile(pending, currentProfileKey)) {
      throw new Error('RESTART_PROFILE_MISMATCH');
    }
    const profileState = await loadContractProfileStateByKey(profileDirectory, currentProfileKey);
    if (profileState === undefined) throw new Error('RESTART_PROFILE_UNAVAILABLE');
    const profile = profileState.profile;
    if (restartPendingAlreadyCompleted(pending, profile)) {
      await consumeRestartPending(profileDirectory, pending);
      return;
    }

    const roots = contractSandboxRoots(pending.runId);
    const root = pending.root === 'library' ? roots.library : roots.knowledge;
    const notePath = assertSandboxVaultPath(`${root}/${pending.noteId}`, pending.runId);
    const latestSafeDelete = profile.evidence
      .filter((record) => record.operation === 'safeDelete')
      .at(-1);
    const verifiedSafeDelete = profile.safeDelete
      && latestSafeDelete?.status === 'passed'
      && latestSafeDelete.reasonCode === 'CONDITIONAL_NONPERMANENT_DELETE_VERIFIED'
      && latestSafeDelete.primitive === 'DELETE_NON_PERMANENT';
    const restartWasVerified = restartPendingHasVerifiedRestart(pending, profile);
    let restartObserved: Awaited<ReturnType<typeof gateway.readRaw>> | undefined;
    if (!restartWasVerified) {
      try {
        const observed = await gateway.readRaw(notePath);
        if (
          observed.rawSha256 === pending.rawSha256
          && observed.upstreamVersion === pending.upstreamVersion
        ) {
          restartObserved = observed;
        }
      } catch {
        restartObserved = undefined;
      }
    }

    const restartCheckedAt = new Date().toISOString();
    const {
      schemaVersion: _schemaVersion,
      profileKey: _profileKey,
      formalWriteGate: _formalWriteGate,
      restartCheckedAt: previousRestartCheckedAt,
      ...profileInput
    } = profile;
    if (!restartWasVerified && restartObserved === undefined) {
      await writeContractProfile(profileDirectory, buildContractProfile({
        ...profileInput,
        restartPersistence: 'failed',
        restartCheckedAt,
        evidence: [
          ...profile.evidence.filter((record) => (
            record.operation !== 'restartPersistence' && record.operation !== 'cleanup'
          )),
          {
            operation: 'restartPersistence',
            status: 'failed',
            timestamp: restartCheckedAt,
            reasonCode: 'RESTART_STATE_MISMATCH',
            primitive: 'RAW_REREAD'
          },
          {
            operation: 'cleanup',
            status: 'unverified',
            timestamp: restartCheckedAt,
            reasonCode: 'MANUAL_CLEANUP_REQUIRED'
          }
        ]
      }), { expectedRevision: profileState.revision });
      return;
    }

    let verifiedState = profileState;
    let verifiedProfile = profile;
    if (!restartWasVerified) {
      verifiedProfile = buildContractProfile({
        ...profileInput,
        restartPersistence: 'passed',
        restartCheckedAt,
        evidence: [
          ...profile.evidence.filter((record) => (
            record.operation !== 'restartPersistence' && record.operation !== 'cleanup'
          )),
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
            reasonCode: verifiedSafeDelete
              ? 'CONDITIONAL_NONPERMANENT_CLEANUP_ARMED'
              : 'MANUAL_CLEANUP_REQUIRED',
            ...(verifiedSafeDelete ? { primitive: 'DELETE_NON_PERMANENT' as const } : {})
          }
        ]
      });
      verifiedState = await writeContractProfile(
        profileDirectory,
        verifiedProfile,
        { expectedRevision: profileState.revision }
      );
      pending = await markRestartPendingVerified(profileDirectory, pending);
    }

    if (!verifiedSafeDelete) {
      // The exact run-bound restart record remains active for sanitized manual cleanup.
      return;
    }

    let cleanupStatus: 'passed' | 'failed' = 'failed';
    let trashAttempted = false;
    try {
      let current: Awaited<ReturnType<typeof gateway.readRaw>> | undefined;
      try {
        // Always re-read after the restart phase/armed record commits; the
        // earlier restart observation is too stale to authorize cleanup.
        current = await gateway.readRaw(notePath);
      } catch (error) {
        if (error instanceof VaultGatewayError && error.upstreamStatus === 404) {
          cleanupStatus = 'passed';
        } else {
          throw error;
        }
      }
      if (current !== undefined) {
        if (
          current.rawSha256 !== pending.rawSha256
          || current.upstreamVersion !== pending.upstreamVersion
        ) {
          throw new Error('cleanup precondition mismatch');
        }
        const client = new ContractRestClient(environment.apiUrl, environment.apiKey);
        trashAttempted = true;
        const status = await client.trash(notePath, current.upstreamVersion);
        let rereadStatus = 200;
        try {
          await gateway.readRaw(notePath);
        } catch (error) {
          rereadStatus = error instanceof VaultGatewayError ? error.upstreamStatus : 599;
        }
        cleanupStatus = isVerifiedNonPermanentCleanup(status, rereadStatus) ? 'passed' : 'failed';
      }
    } catch {
      cleanupStatus = 'failed';
    }

    const cleanupCheckedAt = new Date().toISOString();
    const {
      schemaVersion: _verifiedSchemaVersion,
      profileKey: _verifiedProfileKey,
      formalWriteGate: _verifiedFormalWriteGate,
      restartCheckedAt: verifiedRestartCheckedAt,
      ...verifiedInput
    } = verifiedProfile;
    const updated = buildContractProfile({
      ...verifiedInput,
      restartPersistence: 'passed',
      restartCheckedAt: verifiedRestartCheckedAt ?? previousRestartCheckedAt ?? restartCheckedAt,
      evidence: [
        ...verifiedProfile.evidence.filter((record) => (
          record.operation !== 'restartPersistence' && record.operation !== 'cleanup'
        )),
        {
          operation: 'restartPersistence',
          status: 'passed',
          httpStatuses: [200],
          timestamp: verifiedRestartCheckedAt ?? previousRestartCheckedAt ?? restartCheckedAt,
          reasonCode: 'RAW_HASH_AND_VERSION_PERSISTED',
          primitive: 'RAW_REREAD'
        },
        {
          operation: 'cleanup',
          status: cleanupStatus,
          timestamp: cleanupCheckedAt,
          reasonCode: cleanupStatus === 'passed'
            ? 'CONDITIONAL_NONPERMANENT_CLEANUP_PASSED'
            : 'CONDITIONAL_NONPERMANENT_CLEANUP_FAILED',
          ...(trashAttempted || cleanupStatus === 'passed'
            ? { primitive: 'DELETE_NON_PERMANENT' as const } : {})
        }
      ]
    });
    await writeContractProfile(
      profileDirectory,
      updated,
      { expectedRevision: verifiedState.revision }
    );
    if (cleanupStatus === 'passed') {
      await consumeRestartPending(profileDirectory, pending);
    }
  });
});
