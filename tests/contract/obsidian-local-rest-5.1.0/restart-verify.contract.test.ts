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
  classifyNonPermanentCleanup,
  cleanupPendingMatchesRestart,
  consumeCleanupPending,
  consumeRestartPending,
  loadCleanupPending,
  loadRestartPending,
  markRestartPendingFailed,
  markRestartPendingVerified,
  restartPendingAlreadyCompleted,
  restartCleanupPassedReasonCode,
  restartPendingMatchesProfile,
  writeCleanupPending,
  type RestartVerifiedPending
} from '../../helpers/restart-pending.js';
import {
  activateVerifiedRestart,
  buildCleanupFailedProfile,
  buildRestartFailedProfile,
  persistCleanupFailure,
  planRestartProfileActivation,
  recordRestartFailure,
  restartFailedProfileMatches,
  restartPendingCanResumeCleanup
} from '../../helpers/restart-verify-flow.js';
import {
  buildContractProfile,
  computeContractProfileKey,
  computeContractProfileRevision,
  loadContractProfileStateByKey,
  recoverContractProfileActivation,
  writeContractProfile,
  type ContractProfileState
} from '../../../src/server/vault/contract-profile-store.js';
import { VaultGatewayError } from '../../../src/server/vault/LocalRest51Gateway.js';

type CleanupFailureReasonCode =
  | 'CLEANUP_TARGET_ALREADY_MISSING'
  | 'CLEANUP_IDENTITY_MISMATCH'
  | 'CONDITIONAL_NONPERMANENT_CLEANUP_FAILED';

function cleanupFailureReasonCode(value: string): CleanupFailureReasonCode {
  if (
    value === 'CLEANUP_TARGET_ALREADY_MISSING'
    || value === 'CLEANUP_IDENTITY_MISMATCH'
    || value === 'CONDITIONAL_NONPERMANENT_CLEANUP_FAILED'
  ) return value;
  throw new Error('RESTART_PENDING_NOT_CURRENT');
}

describe('Local REST restart persistence verify', () => {
  it('persists restart verification before activating the profile and consumes only proven cleanup', async () => {
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
    await recoverContractProfileActivation(profileDirectory);
    let pending = await loadRestartPending(profileDirectory);
    if (pending === undefined) throw new Error('RESTART_PENDING_UNAVAILABLE');
    if (pending.phase === 'preparing') throw new Error('RESTART_PENDING_NOT_PREPARED');

    const fingerprint = await gateway.fingerprint();
    if (
      fingerprint.pluginId !== 'obsidian-local-rest-api'
      || fingerprint.pluginVersion.split('.')[0] !== '5'
    ) {
      throw new Error('PLUGIN_CONTRACT_INCOMPATIBLE');
    }
    const openApiSha256 = createHash('sha256')
      .update(await gateway.readOpenApi(), 'utf8')
      .digest('hex');
    const expectedOpenApiSha256 = process.env.OBSIDIAN_EXPECTED_OPENAPI_SHA256;
    if (expectedOpenApiSha256 !== undefined && expectedOpenApiSha256 !== openApiSha256) {
      throw new Error('OPENAPI_FINGERPRINT_MISMATCH');
    }
    const currentProfileKey = computeContractProfileKey({ ...fingerprint, openApiSha256 });
    if (!restartPendingMatchesProfile(pending, currentProfileKey)) {
      throw new Error('RESTART_PROFILE_MISMATCH');
    }

    const initialProfileState = await loadContractProfileStateByKey(
      profileDirectory,
      currentProfileKey
    );
    if (initialProfileState === undefined) throw new Error('RESTART_PROFILE_UNAVAILABLE');
    if (restartPendingAlreadyCompleted(pending, initialProfileState.profile)) {
      const cleanupPending = await loadCleanupPending(profileDirectory, pending.runId);
      if (cleanupPending !== undefined) {
        if (!cleanupPendingMatchesRestart(cleanupPending, pending)) {
          throw new Error('RESTART_PENDING_NOT_CURRENT');
        }
        await consumeCleanupPending(profileDirectory, cleanupPending);
      }
      await consumeRestartPending(profileDirectory, pending);
      return;
    }

    const roots = contractSandboxRoots(pending.runId);
    const root = pending.root === 'library' ? roots.library : roots.knowledge;
    const notePath = assertSandboxVaultPath(`${root}/${pending.noteId}`, pending.runId);

    if (pending.phase === 'restart-failed') {
      if (!restartFailedProfileMatches(pending, initialProfileState.profile)) {
        throw new Error('RESTART_TERMINAL_FAILURE_RECORDED');
      }
      return;
    }

    let verifiedState: ContractProfileState;
    let verifiedPending: RestartVerifiedPending;
    const priorCleanup = pending.phase === 'restart-verified'
      ? await loadCleanupPending(profileDirectory, pending.runId)
      : undefined;
    if (
      priorCleanup !== undefined
      && !cleanupPendingMatchesRestart(priorCleanup, pending)
    ) {
      throw new Error('RESTART_PENDING_NOT_CURRENT');
    }
    if (
      pending.phase === 'restart-verified'
      && restartPendingCanResumeCleanup(pending, initialProfileState.profile, priorCleanup)
    ) {
      verifiedState = initialProfileState;
      verifiedPending = pending;
      if (priorCleanup?.cleanupStatus === 'failed') {
        const failureProfile = buildCleanupFailedProfile(
          initialProfileState.profile,
          pending,
          {
            checkedAt: priorCleanup.cleanupCheckedAt,
            reasonCode: cleanupFailureReasonCode(priorCleanup.cleanupReasonCode)
          }
        );
        if (computeContractProfileRevision(failureProfile) !== initialProfileState.revision) {
          verifiedState = await writeContractProfile(
            profileDirectory,
            failureProfile,
            { expectedRevision: initialProfileState.revision }
          );
        }
      }
    } else {
      if (pending.phase === 'prepared') {
        let restartMatches = false;
        try {
          const observed = await gateway.readRaw(notePath);
          restartMatches = observed.rawSha256 === pending.rawSha256
            && observed.upstreamVersion === pending.upstreamVersion;
        } catch {
          restartMatches = false;
        }
        if (!restartMatches) {
          const failedAt = new Date().toISOString();
          const failedProfile = buildRestartFailedProfile(
            initialProfileState.profile,
            pending,
            failedAt
          );
          const intendedProfileRevision = computeContractProfileRevision(failedProfile);
          await recordRestartFailure({
            pending,
            markFailed: (current) => markRestartPendingFailed(
              profileDirectory,
              current,
              {
                failedAt,
                reasonCode: 'RESTART_STATE_MISMATCH',
                intendedProfileRevision
              }
            ),
            persistProfile: () => writeContractProfile(
              profileDirectory,
              failedProfile,
              { expectedRevision: initialProfileState.revision }
            )
          });
          return;
        }
      }

      const activationPlan = planRestartProfileActivation(
        pending,
        initialProfileState.profile,
        new Date().toISOString()
      );

      const activated = await activateVerifiedRestart({
        pending,
        markVerified: (current) => markRestartPendingVerified(
          profileDirectory,
          current,
          {
            verifiedAt: activationPlan.verifiedAt,
            intendedProfileRevision: activationPlan.intendedProfileRevision
          }
        ),
        activateProfile: () => writeContractProfile(
          profileDirectory,
          activationPlan.profile,
          { expectedRevision: initialProfileState.revision }
        )
      });
      verifiedPending = activated.pending;
      verifiedState = activated.profile;
      pending = verifiedPending;
    }

    const persistCleanupFailureForRun = async (
      reasonCode: CleanupFailureReasonCode
    ): Promise<void> => {
      const existing = await loadCleanupPending(profileDirectory, verifiedPending.runId);
      if (existing !== undefined && !cleanupPendingMatchesRestart(existing, verifiedPending)) {
        throw new Error('RESTART_PENDING_NOT_CURRENT');
      }
      if (existing !== undefined && existing.cleanupStatus !== 'failed') {
        throw new Error('RESTART_PENDING_NOT_CURRENT');
      }
      const checkedAt = existing?.cleanupCheckedAt ?? new Date().toISOString();
      const recordedReason = existing === undefined
        ? reasonCode
        : cleanupFailureReasonCode(existing.cleanupReasonCode);
      verifiedState = await persistCleanupFailure({
        pending: verifiedPending,
        profile: verifiedState.profile,
        checkedAt,
        reasonCode: recordedReason,
        persistLocator: (cleanup) => writeCleanupPending(
          profileDirectory,
          verifiedPending,
          cleanup
        ),
        persistProfile: (profile) => writeContractProfile(
          profileDirectory,
          profile,
          { expectedRevision: verifiedState.revision }
        )
      });
    };

    const verifiedProfile = verifiedState.profile;
    const latestSafeDelete = verifiedProfile.evidence
      .filter((record) => record.operation === 'safeDelete')
      .at(-1);
    const verifiedSafeDelete = verifiedProfile.safeDelete
      && latestSafeDelete?.status === 'passed'
      && latestSafeDelete.reasonCode === 'CONDITIONAL_NONPERMANENT_DELETE_VERIFIED'
      && latestSafeDelete.primitive === 'DELETE_NON_PERMANENT';
    if (!verifiedSafeDelete) {
      // The run-bound restart locator remains durable for sanitized manual cleanup.
      return;
    }

    let current: Awaited<ReturnType<typeof gateway.readRaw>>;
    try {
      current = await gateway.readRaw(notePath);
    } catch (error) {
      const preReadStatus = error instanceof VaultGatewayError ? error.upstreamStatus : 599;
      const decision = classifyNonPermanentCleanup({ preReadStatus });
      await persistCleanupFailureForRun(cleanupFailureReasonCode(decision.reasonCode));
      return;
    }
    if (
      current.rawSha256 !== verifiedPending.rawSha256
      || current.upstreamVersion !== verifiedPending.upstreamVersion
    ) {
      await persistCleanupFailureForRun('CLEANUP_IDENTITY_MISMATCH');
      return;
    }

    const client = new ContractRestClient(environment.apiUrl, environment.apiKey);
    let deleteStatus = 599;
    let rereadStatus = 599;
    try {
      deleteStatus = await client.trash(notePath, current.upstreamVersion);
      try {
        await gateway.readRaw(notePath);
        rereadStatus = 200;
      } catch (error) {
        rereadStatus = error instanceof VaultGatewayError ? error.upstreamStatus : 599;
      }
    } catch {
      deleteStatus = 599;
    }
    const cleanup = classifyNonPermanentCleanup({
      preReadStatus: 200,
      deleteStatus,
      rereadStatus
    });
    if (cleanup.status !== 'passed') {
      await persistCleanupFailureForRun(cleanupFailureReasonCode(cleanup.reasonCode));
      return;
    }

    const cleanupCheckedAt = new Date().toISOString();
    const {
      schemaVersion: _verifiedSchemaVersion,
      profileKey: _verifiedProfileKey,
      formalWriteGate: _verifiedFormalWriteGate,
      ...verifiedInput
    } = verifiedProfile;
    const cleanupPassedProfile = buildContractProfile({
      ...verifiedInput,
      evidence: [
        ...verifiedProfile.evidence.filter((record) => record.operation !== 'cleanup'),
        {
          operation: 'cleanup',
          status: 'passed',
          timestamp: cleanupCheckedAt,
          reasonCode: restartCleanupPassedReasonCode(verifiedPending),
          primitive: 'DELETE_NON_PERMANENT'
        }
      ]
    });
    await writeContractProfile(
      profileDirectory,
      cleanupPassedProfile,
      { expectedRevision: verifiedState.revision }
    );
    const staleCleanup = await loadCleanupPending(profileDirectory, verifiedPending.runId);
    if (staleCleanup !== undefined) {
      if (!cleanupPendingMatchesRestart(staleCleanup, verifiedPending)) {
        throw new Error('RESTART_PENDING_NOT_CURRENT');
      }
      await consumeCleanupPending(profileDirectory, staleCleanup);
    }
    await consumeRestartPending(profileDirectory, verifiedPending);
  });
});
