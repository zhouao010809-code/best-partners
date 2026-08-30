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
  restartPendingMatchesProfile
} from '../../helpers/restart-pending.js';
import {
  buildContractProfile,
  computeContractProfileKey,
  loadContractProfileByKey,
  writeContractProfile
} from '../../../src/server/vault/contract-profile-store.js';
import { VaultGatewayError } from '../../../src/server/vault/LocalRest51Gateway.js';

describe('Local REST restart persistence verify', () => {
  it('matches the current fingerprint, updates restart evidence, and consumes only a successful pending record', async () => {
    const environment = requireContractEnvironment(process.env);
    const gateway = createContractGateway(environment);
    await assertContractTestVault({
      gateway,
      testVaultRoot: environment.testVaultRoot,
      formalVaultRoot: environment.formalVaultRoot,
      sourceRoot: environment.sourceRoot,
      appDataRoot: environment.appDataRoot,
      allowWrite: process.env.ALLOW_OBSIDIAN_CONTRACT_WRITE
    });

    const profileDirectory = join(environment.appDataRoot, 'contract-profiles');
    const pending = await loadRestartPending(profileDirectory);
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
    const profile = await loadContractProfileByKey(profileDirectory, currentProfileKey);
    if (profile === undefined) throw new Error('RESTART_PROFILE_UNAVAILABLE');

    const roots = contractSandboxRoots(pending.runId);
    const root = pending.root === 'library' ? roots.library : roots.knowledge;
    const notePath = assertSandboxVaultPath(`${root}/${pending.noteId}`, pending.runId);
    let restartPassed = false;
    try {
      const observed = await gateway.readRaw(notePath);
      restartPassed = observed.rawSha256 === pending.rawSha256
        && observed.upstreamVersion === pending.upstreamVersion;
    } catch {
      restartPassed = false;
    }

    const {
      schemaVersion: _schemaVersion,
      profileKey: _profileKey,
      formalWriteGate: _formalWriteGate,
      restartCheckedAt: _previousRestartCheckedAt,
      ...input
    } = profile;
    const restartCheckedAt = new Date().toISOString();
    const verifiedSafeDelete = profile.safeDelete && profile.evidence.some((record) => (
      record.operation === 'safeDelete'
      && record.status === 'passed'
      && record.reasonCode === 'CONDITIONAL_NONPERMANENT_DELETE_VERIFIED'
      && record.primitive === 'DELETE_NON_PERMANENT'
    ));
    let cleanupStatus: 'passed' | 'failed' | 'unverified' = 'unverified';
    let cleanupReason = 'MANUAL_CLEANUP_REQUIRED';
    if (restartPassed && verifiedSafeDelete) {
      try {
        const client = new ContractRestClient(environment.apiUrl, environment.apiKey);
        const status = await client.trash(notePath, pending.upstreamVersion);
        let rereadStatus = 200;
        try {
          await gateway.readRaw(notePath);
        } catch (error) {
          rereadStatus = error instanceof VaultGatewayError ? error.upstreamStatus : 599;
        }
        cleanupStatus = isVerifiedNonPermanentCleanup(status, rereadStatus) ? 'passed' : 'failed';
        cleanupReason = cleanupStatus === 'passed'
          ? 'CONDITIONAL_NONPERMANENT_CLEANUP_PASSED'
          : 'CONDITIONAL_NONPERMANENT_CLEANUP_FAILED';
      } catch {
        cleanupStatus = 'failed';
        cleanupReason = 'CONDITIONAL_NONPERMANENT_CLEANUP_FAILED';
      }
    }
    const updated = buildContractProfile({
      ...input,
      restartPersistence: restartPassed ? 'passed' : 'failed',
      restartCheckedAt,
      evidence: [
        ...profile.evidence.filter((record) => (
          record.operation !== 'restartPersistence' && record.operation !== 'cleanup'
        )),
        {
          operation: 'restartPersistence',
          status: restartPassed ? 'passed' : 'failed',
          ...(restartPassed ? { httpStatuses: [200] } : {}),
          timestamp: restartCheckedAt,
          reasonCode: restartPassed ? 'RAW_HASH_AND_VERSION_PERSISTED' : 'RESTART_STATE_MISMATCH',
          primitive: 'RAW_REREAD'
        },
        {
          operation: 'cleanup',
          status: cleanupStatus,
          timestamp: restartCheckedAt,
          reasonCode: cleanupReason,
          primitive: 'DELETE_NON_PERMANENT'
        }
      ]
    });
    await writeContractProfile(profileDirectory, updated);
    if (restartPassed) {
      await consumeRestartPending(profileDirectory, pending);
    }
  });
});
